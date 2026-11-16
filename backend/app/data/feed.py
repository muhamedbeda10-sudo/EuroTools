"""Shared market-data cache fed from Younit.

Prices are the same for every account, so they live once, outside the per-user
trees, in the `egxMarket` collection: an `index` document plus a fixed number of
`chunk_NN` documents holding the bars. Refreshing is done in short batches so a
single request never runs long on a serverless host; the page calls
`refresh()` repeatedly until nothing is left.
"""
from __future__ import annotations

import json
import os
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, date, datetime, timedelta
from typing import Protocol

import httpx
import pandas as pd

from ..store.errors import AuthError, ConflictError
from .calendar import CAIRO, cairo_now, last_settle, market_open  # noqa: F401 - CAIRO re-exported for tests
from .younit import YounitClient, YounitError, YounitRateLimit

CHUNKS = 24
HISTORY_DAYS = 3 * 366
MAX_BARS = 800
WORKERS = 3              # requests in flight at once
REQUEST_GAP = 0.12       # seconds between request starts: a steady pace instead of a burst
WRITE_ATTEMPTS = 3
MAX_DOC_BYTES = 900_000
MAX_PER_BATCH = 40  # stocks per call: keeps one request far below the host's time limit


class SharedDocs(Protocol):
    def get(self, id: str) -> dict | None: ...
    def put(self, id: str, doc: dict, *, guard: bool = False) -> None: ...


class StoreDocs:
    """Shared documents inside the local SQLite store (local runs and tests)."""

    def __init__(self, store):
        self.store = store

    def get(self, id: str) -> dict | None:
        return self.store.get("egxMarket", id)

    def put(self, id: str, doc: dict, *, guard: bool = False) -> None:
        self.store.put("egxMarket", id, doc)  # one writer at a time locally: nothing to guard against


class FirestoreDocs:
    """Shared documents in Firestore, read and written with the caller's own token."""

    _client = httpx.Client(timeout=20.0)

    def __init__(self, project_id: str, token: str):
        emulator = os.environ.get("FIRESTORE_EMULATOR_HOST")
        origin = f"http://{emulator}" if emulator else "https://firestore.googleapis.com"
        self._db = f"projects/{project_id}/databases/(default)/documents"
        self._root = f"{origin}/v1/{self._db}"
        self._url = f"{self._root}/egxMarket"
        self._headers = {"Authorization": f"Bearer {token}"}
        self._seen: dict[str, str | None] = {}  # document -> its version when this request read it (None: absent)

    def get(self, id: str) -> dict | None:
        res = self._client.get(f"{self._url}/{id}", headers=self._headers)
        if res.status_code == 404:
            self._seen[id] = None
            return None
        if res.status_code in (401, 403):
            raise AuthError("not signed in, or this account is not allowed to use the app")
        res.raise_for_status()
        body = res.json()
        self._seen[id] = body.get("updateTime")
        return json.loads(body["fields"]["body"]["stringValue"])

    def put(self, id: str, doc: dict, *, guard: bool = False) -> None:
        """Write a document. With `guard`, only if it is still the version this request read:
        two people refreshing at once cannot silently overwrite each other's work."""
        write: dict = {"update": {"name": f"{self._db}/egxMarket/{id}",
                                  "fields": {"body": {"stringValue": json.dumps(doc, separators=(",", ":"))}}}}
        if guard and id in self._seen:
            seen = self._seen[id]
            write["currentDocument"] = {"exists": False} if seen is None else {"updateTime": seen}
        res = self._client.post(f"{self._root}:commit", headers=self._headers, json={"writes": [write]})
        if res.status_code in (401, 403):
            raise AuthError("not signed in, or this account is not allowed to use the app")
        if "currentDocument" in write and (res.status_code == 409 or res.status_code in (400, 404) and any(
                word in res.text for word in ("FAILED_PRECONDITION", "ALREADY_EXISTS", "NOT_FOUND"))):
            self._seen.pop(id, None)
            raise ConflictError("the shared market data changed while it was being updated")
        res.raise_for_status()
        stamp = ((res.json().get("writeResults") or [{}])[0]).get("updateTime")
        if stamp:
            self._seen[id] = stamp
        else:
            self._seen.pop(id, None)


def chunk_of(symbol: str) -> str:
    return f"chunk_{zlib.crc32(symbol.encode()) % CHUNKS:02d}"


def _now() -> datetime:
    return cairo_now().astimezone(UTC)  # one clock for the whole module


def empty_index() -> dict:
    return {"version": 0, "instruments": [], "last_dates": {}, "checked": {}, "updated_at": None, "errors": []}


def _frame(rows: list) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date").sort_index()


def listed(instruments: list[dict]) -> list[dict]:
    """Stocks the feed lists today. One that left the list keeps its history but is no longer refreshed."""
    return [i for i in instruments if i.get("listed", True)]


def _meta(index: dict) -> dict:
    """The few numbers every request needs, kept apart from the large index document."""
    current = listed(index["instruments"])
    dates = [d for s in current if (d := index["last_dates"].get(s["symbol"]))]
    checked = [index["checked"].get(s["symbol"]) for s in current]
    return {"version": index["version"], "updated_at": index.get("updated_at"),
            "symbols": len(current), "with_history": len(dates),
            "latest_bar_date": max(dates) if dates else None, "errors": index.get("errors", [])[:5],
            "fields": index.get("fields", []),
            # the oldest look at any stock: when it is older than the last session's close, a refresh is due
            "checked_min": min(checked) if checked and all(checked) else None}


def settled_until(checked: dict) -> dict[str, str]:
    """For each stock, the last session whose bar is known to be final.

    History read at some moment is final for every session that had closed by then;
    a bar dated later (the running session) is still forming and must not be used
    for signals, backtests or automatic trades.
    """
    out = {}
    for symbol, stamp in checked.items():
        try:
            out[symbol] = last_settle(datetime.fromisoformat(stamp)).date().isoformat()
        except (TypeError, ValueError):
            continue
    return out


class Feed:
    """In-memory view of the shared cache for one server instance (shared by all users).

    A request reads one small document (`meta`) to learn the current version. The
    large documents are downloaded, and the price tables built, only when that
    version changes, once per server instance rather than once per user.
    """

    _state: dict = {"version": None, "meta": None, "instruments": [], "frames": {}, "settled_until": {},
                    "live": None, "live_ts": None}
    _lock = threading.Lock()  # a cold server downloads the price tables once, however many requests arrive together

    def __init__(self, docs: SharedDocs):
        self.docs = docs

    def load(self) -> dict:
        meta = self.docs.get("meta")
        if meta is None:  # written by an earlier release that had no meta document
            index = self.docs.get("index")
            meta = _meta(index) if index else _meta(empty_index())
        st = Feed._state
        if st["version"] == meta["version"] and st["meta"] is not None:
            st["meta"] = meta
            if meta.get("live_ts") != st.get("live_ts"):
                st["live"], st["live_ts"] = self.docs.get("live"), meta.get("live_ts")
            return st
        with Feed._lock:
            st = Feed._state
            if st["version"] == meta["version"] and st["meta"] is not None:
                return st  # another request finished the same download while this one waited
            return self._download(meta)

    def _download(self, meta: dict) -> dict:
        index = self.docs.get("index") or empty_index()
        frames: dict[str, pd.DataFrame] = {}
        names = sorted({chunk_of(i["symbol"]) for i in index["instruments"]})
        if names:
            with ThreadPoolExecutor(12) as pool:
                for doc in pool.map(self.docs.get, names):
                    for symbol, rows in (doc or {}).get("bars", {}).items():
                        if rows:
                            frames[symbol] = _frame(rows)
        Feed._state = {"version": meta["version"], "meta": meta, "instruments": index["instruments"], "frames": frames,
                       "settled_until": settled_until(index.get("checked") or {}),
                       "live": self.docs.get("live") if meta.get("live_ts") else None, "live_ts": meta.get("live_ts")}
        return Feed._state

    @staticmethod
    def reset() -> None:
        Feed._state = {"version": None, "meta": None, "instruments": [], "frames": {}, "settled_until": {},
                       "live": None, "live_ts": None}

    def poll_live(self, client: YounitClient, *, now: datetime | None = None, min_age_seconds: float = 12.0) -> dict:
        """Take the latest price of every stock, once, and keep today's running open/high/low.

        Several open pages ask for this every minute; whoever arrives within
        `min_age_seconds` of the last poll gets the saved prices and the feed is
        not called again.
        """
        now = now or cairo_now()
        today = now.date().isoformat()
        current = self.docs.get("live")
        if current and current.get("date") == today:
            age = (now - datetime.fromisoformat(current["ts"])).total_seconds()
            if -5 <= age < min_age_seconds:   # a reading stamped in the future is not a recent one: the feed is asked again
                return {"updated": False, "ts": current["ts"], "available": bool(current["quotes"])}
        index = self.docs.get("index") or empty_index()
        current_list = listed(index["instruments"])
        tracked = [i for i in current_list if index["last_dates"].get(i["symbol"])] or current_list
        if not tracked:
            return {"updated": False, "ts": None, "available": False}
        got = client.live(tracked)
        same_day = current if current and current.get("date") == today else {}
        # A stock with no trade yet today is simply absent. One that answered earlier today but not this
        # time keeps its earlier figures: a slow answer must not send its price back to yesterday's close.
        quotes = {**(same_day.get("quotes") or {}), **got["quotes"]}
        sectors = {**((current or {}).get("sectors") or {}), **got["sectors"]}
        indices = got["indices"] or same_day.get("indices") or []
        doc = {"date": today, "ts": now.isoformat(timespec="seconds"), "quotes": quotes, "sectors": sectors,
               "indices": indices, "errors": got["errors"], "answered": got["answered"], "asked": len(tracked),
               "fresh": len(got["quotes"]),
               # stocks shown at an earlier figure because they did not answer this time: on screen, but not to be acted on
               "stale": sorted(set(quotes) - set(got["quotes"]))}
        self.docs.put("live", doc)
        meta = self.docs.get("meta") or _meta(self.docs.get("index") or empty_index())
        meta["live_ts"] = doc["ts"]
        self.docs.put("meta", meta)
        st = Feed._state
        if st["meta"] is not None:
            st["meta"], st["live"], st["live_ts"] = meta, doc, doc["ts"]
        return {"updated": True, "ts": doc["ts"], "available": bool(doc["quotes"]), "stocks": len(doc["quotes"]),
                "indices": len(indices), "errors": got["errors"]}

    def summary(self, today: date, *, now: datetime | None = None) -> dict:
        meta = self.load()["meta"]
        live = self._state.get("live")
        oldest = meta.get("checked_min")
        # Due when a stock has never been read, or was last read before the latest session closed:
        # the session's final bars are fetched on the first visit after the close, not the next morning.
        due = not meta["symbols"] or not oldest or datetime.fromisoformat(oldest) < last_settle(now or _now())
        return {**{k: meta[k] for k in ("symbols", "with_history", "latest_bar_date", "updated_at", "errors")},
                "refresh_due": due,
                "market_open": market_open(),
                "fields": meta.get("fields", []),
                "live": {"as_of": live["ts"], "date": live["date"], "stocks": len(live["quotes"]),
                         "asked": live.get("asked"), "answered": live.get("answered"),
                         "sectors": len(live.get("sectors") or {}), "indices": len(live.get("indices") or []),
                         "errors": live.get("errors", [])} if live else None}

    def refresh(self, client: YounitClient, *, today: date, budget_seconds: float = 18.0,
                now: datetime | None = None) -> dict:
        """Update as many symbols as fit in the time budget. Call again while `remaining` > 0.

        A stock is due once after every session close. Bars are merged into what the chunk
        document actually holds, and chunk and index writes are refused if someone else
        changed the document meanwhile (then re-read and merged again), so two refreshes at
        the same time cannot lose each other's history.
        """
        started = time.monotonic()
        now = now or _now()
        settle = last_settle(now)
        index = json.loads(json.dumps(self.docs.get("index") or empty_index()))

        def due(idx: dict, symbol: str) -> bool:
            checked = idx["checked"].get(symbol)
            return checked is None or datetime.fromisoformat(checked) < settle

        before = listed(index["instruments"])
        if before and not any(due(index, i["symbol"]) for i in before):
            meta = self.docs.get("meta") or {}
            if "checked_min" not in meta:  # written by an earlier release: bring it up to date once
                fresh = _meta(index)
                fresh["live_ts"] = meta.get("live_ts")
                self.docs.put("meta", fresh)
                Feed.reset()
            return {"updated": 0, "remaining": 0, "total": len(before), "errors": [], "stalled": False,
                    "rate_limited": False, "retry_after": None, "seconds": round(time.monotonic() - started, 1)}

        listed_at = index.get("listed_at")
        if before and listed_at and datetime.fromisoformat(listed_at) >= settle:
            # The stock list was already read for this session: every batch does not ask for it again.
            stocks, fields = [{k: s[k] for k in ("symbol", "name", "stock_id")} for s in before], index.get("fields", [])
        else:
            snap = client.snapshot()  # raises YounitError: nothing is written if the feed is down
            stocks, fields = [{k: s[k] for k in ("symbol", "name", "stock_id")} for s in snap["stocks"]], snap["fields"]
            if not stocks:
                raise YounitError("Younit returned an empty stock list")
            listed_at = now.astimezone(UTC).isoformat()
        known = {s["symbol"] for s in stocks}

        def instruments(idx: dict) -> list[dict]:
            # A stock that left the feed's list keeps its history (it may still be held); it is just not refreshed.
            gone = [{**i, "listed": False} for i in idx["instruments"]
                    if i["symbol"] not in known and idx["last_dates"].get(i["symbol"])]
            return stocks + gone

        pending = [s for s in stocks if due(index, s["symbol"])][:MAX_PER_BATCH]
        names = sorted({chunk_of(s["symbol"]) for s in pending})
        with ThreadPoolExecutor(8) as pool:
            chunks = {name: doc or {"bars": {}} for name, doc in zip(names, pool.map(self.docs.get, names), strict=True)}
        updated: dict[str, list] = {}
        errors: list[str] = []

        def fetch(stock: dict):
            # How far back to ask is decided by the bars actually held, never by a date noted elsewhere.
            have = chunks[chunk_of(stock["symbol"])]["bars"].get(stock["symbol"]) or []
            start = date.fromisoformat(have[-1][0]) - timedelta(days=7) if have else today - timedelta(days=HISTORY_DAYS)
            return stock["symbol"], client.daily_history(stock["stock_id"], start, today)

        done = 0
        limited: YounitRateLimit | None = None
        with ThreadPoolExecutor(WORKERS) as pool:
            queue = iter(pending)
            running = set()
            next_start = 0.0
            while True:
                while limited is None and len(running) < WORKERS and time.monotonic() - started < budget_seconds:
                    nxt = next(queue, None)
                    if nxt is None:
                        break
                    time.sleep(max(0.0, next_start - time.monotonic()))
                    next_start = time.monotonic() + REQUEST_GAP
                    fut = pool.submit(fetch, nxt)
                    fut.symbol = nxt["symbol"]  # type: ignore[attr-defined]
                    running.add(fut)
                if not running:
                    break
                fut = next(as_completed(running))
                running.discard(fut)
                try:
                    symbol, rows = fut.result()
                    updated[symbol] = rows
                    done += 1
                except YounitRateLimit as exc:
                    # Asked to slow down: start nothing new, keep what already arrived, resume after the pause.
                    limited = exc
                except YounitError as exc:
                    errors.append(f"{fut.symbol}: {exc}")  # type: ignore[attr-defined]
                    if len(errors) >= 8:  # the feed is failing: stop hammering it
                        for other in running:
                            other.cancel()
                        break

        stamp = now.astimezone(UTC).isoformat()
        last_dates: dict[str, str | None] = {}

        def save_chunk(name: str) -> None:
            mine = {symbol: rows for symbol, rows in updated.items() if chunk_of(symbol) == name}
            for attempt in range(WRITE_ATTEMPTS):
                doc = chunks[name] if attempt == 0 else (self.docs.get(name) or {"bars": {}})
                kept = {i["symbol"] for i in instruments(index)}
                for symbol, rows in mine.items():
                    merged = {r[0]: r for r in doc["bars"].get(symbol, [])}
                    merged.update({r[0]: r for r in rows})
                    doc["bars"][symbol] = [merged[k] for k in sorted(merged)][-MAX_BARS:]
                doc["bars"] = {s: b for s, b in doc["bars"].items() if s in kept}
                while len(json.dumps(doc, separators=(",", ":"))) > MAX_DOC_BYTES:  # stay under the document size limit
                    longest = max(doc["bars"], key=lambda s: len(doc["bars"][s]))
                    doc["bars"][longest] = doc["bars"][longest][100:]
                try:
                    self.docs.put(name, doc, guard=True)
                except ConflictError:
                    if attempt == WRITE_ATTEMPTS - 1:
                        raise
                    continue
                for symbol in mine:
                    bars = doc["bars"].get(symbol) or []
                    last_dates[symbol] = bars[-1][0] if bars else None
                return

        with ThreadPoolExecutor(8) as pool:
            list(pool.map(save_chunk, sorted({chunk_of(symbol) for symbol in updated})))

        for attempt in range(WRITE_ATTEMPTS):
            if attempt:  # someone else saved the index meanwhile: apply this batch on top of theirs
                index = json.loads(json.dumps(self.docs.get("index") or empty_index()))
            index["fields"] = fields
            index["listed_at"] = listed_at
            index["instruments"] = instruments(index)
            kept = {i["symbol"] for i in index["instruments"]}
            for symbol in updated:
                index["checked"][symbol] = stamp
                index["last_dates"][symbol] = last_dates.get(symbol)
            index["last_dates"] = {s: d for s, d in index["last_dates"].items() if s in kept}
            index["checked"] = {s: d for s, d in index["checked"].items() if s in kept}
            index["errors"] = errors[:8]
            index["updated_at"] = stamp
            index["version"] = int(index.get("version", 0)) + 1
            try:
                self.docs.put("index", index, guard=True)
                break
            except ConflictError:
                if attempt == WRITE_ATTEMPTS - 1:
                    raise
        meta = _meta(index)
        meta["live_ts"] = (self.docs.get("meta") or {}).get("live_ts")
        self.docs.put("meta", meta)  # last: readers switch to the new version only once it is all there
        Feed.reset()
        remaining = sum(1 for s in stocks if due(index, s["symbol"]))
        return {"updated": done, "remaining": remaining, "total": len(stocks), "errors": errors[:5],
                "stalled": done == 0 and remaining > 0 and limited is None,
                "rate_limited": limited is not None, "retry_after": limited.retry_after if limited else None,
                "seconds": round(time.monotonic() - started, 1)}
