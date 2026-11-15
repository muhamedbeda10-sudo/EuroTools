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
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, date, datetime, timedelta
from typing import Protocol

import httpx
import pandas as pd

from ..store.errors import AuthError
from .calendar import is_trading_day
from .younit import YounitClient, YounitError

CHUNKS = 24
HISTORY_DAYS = 3 * 366
MAX_BARS = 800
RECHECK_MINUTES = 15
WORKERS = 6
MAX_DOC_BYTES = 900_000
MAX_PER_BATCH = 40  # stocks per call: keeps one request far below the host's time limit


class SharedDocs(Protocol):
    def get(self, id: str) -> dict | None: ...
    def put(self, id: str, doc: dict) -> None: ...


class StoreDocs:
    """Shared documents inside the local SQLite store (local runs and tests)."""

    def __init__(self, store):
        self.store = store

    def get(self, id: str) -> dict | None:
        return self.store.get("egxMarket", id)

    def put(self, id: str, doc: dict) -> None:
        self.store.put("egxMarket", id, doc)


class FirestoreDocs:
    """Shared documents in Firestore, read and written with the caller's own token."""

    _client = httpx.Client(timeout=20.0)

    def __init__(self, project_id: str, token: str):
        emulator = os.environ.get("FIRESTORE_EMULATOR_HOST")
        origin = f"http://{emulator}" if emulator else "https://firestore.googleapis.com"
        self._url = f"{origin}/v1/projects/{project_id}/databases/(default)/documents/egxMarket"
        self._headers = {"Authorization": f"Bearer {token}"}

    def get(self, id: str) -> dict | None:
        res = self._client.get(f"{self._url}/{id}", headers=self._headers)
        if res.status_code == 404:
            return None
        if res.status_code in (401, 403):
            raise AuthError("not signed in, or this account is not allowed to use the app")
        res.raise_for_status()
        return json.loads(res.json()["fields"]["body"]["stringValue"])

    def put(self, id: str, doc: dict) -> None:
        res = self._client.patch(f"{self._url}/{id}", headers=self._headers,
                                 json={"fields": {"body": {"stringValue": json.dumps(doc, separators=(",", ":"))}}})
        if res.status_code in (401, 403):
            raise AuthError("not signed in, or this account is not allowed to use the app")
        res.raise_for_status()


def chunk_of(symbol: str) -> str:
    return f"chunk_{zlib.crc32(symbol.encode()) % CHUNKS:02d}"


def _now() -> datetime:
    return datetime.now(UTC)


def empty_index() -> dict:
    return {"version": 0, "instruments": [], "last_dates": {}, "checked": {}, "updated_at": None, "errors": []}


def _frame(rows: list) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date").sort_index()


def _meta(index: dict) -> dict:
    """The few numbers every request needs, kept apart from the large index document."""
    dates = [d for d in index["last_dates"].values() if d]
    return {"version": index["version"], "updated_at": index.get("updated_at"),
            "symbols": len(index["instruments"]), "with_history": len(dates),
            "latest_bar_date": max(dates) if dates else None, "errors": index.get("errors", [])[:5]}


class Feed:
    """In-memory view of the shared cache for one server instance (shared by all users).

    A request reads one small document (`meta`) to learn the current version. The
    large documents are downloaded, and the price tables built, only when that
    version changes, once per server instance rather than once per user.
    """

    _state: dict = {"version": None, "meta": None, "instruments": [], "frames": {}}

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
            return st
        index = self.docs.get("index") or empty_index()
        frames: dict[str, pd.DataFrame] = {}
        names = sorted({chunk_of(i["symbol"]) for i in index["instruments"]})
        if names:
            with ThreadPoolExecutor(12) as pool:
                for doc in pool.map(self.docs.get, names):
                    for symbol, rows in (doc or {}).get("bars", {}).items():
                        if rows:
                            frames[symbol] = _frame(rows)
        Feed._state = {"version": meta["version"], "meta": meta, "instruments": index["instruments"], "frames": frames}
        return Feed._state

    @staticmethod
    def reset() -> None:
        Feed._state = {"version": None, "meta": None, "instruments": [], "frames": {}}

    def summary(self, today: date) -> dict:
        meta = self.load()["meta"]
        updated = meta.get("updated_at")
        fresh_today = bool(updated) and updated[:10] == _now().date().isoformat()
        return {**{k: meta[k] for k in ("symbols", "with_history", "latest_bar_date", "updated_at", "errors")},
                "refresh_due": not fresh_today or meta["with_history"] < meta["symbols"]}

    def refresh(self, client: YounitClient, *, today: date, budget_seconds: float = 18.0) -> dict:
        """Update as many symbols as fit in the time budget. Call again while `remaining` > 0."""
        started = time.monotonic()
        index = json.loads(json.dumps(self.docs.get("index") or empty_index()))
        stocks = client.stocks()  # raises YounitError: nothing is written if the feed is down
        if not stocks:
            raise YounitError("Younit returned an empty stock list")
        index["instruments"] = stocks
        known = {s["symbol"] for s in stocks}
        now = _now()
        cutoff = (now - timedelta(minutes=RECHECK_MINUTES)).isoformat()

        def due(symbol: str) -> bool:
            checked = index["checked"].get(symbol)
            if checked is None:
                return True
            if checked >= cutoff:
                return False  # looked at it moments ago
            # once a day is enough on a closed market; during a session, look again
            return checked[:10] != now.date().isoformat() or is_trading_day(today)

        pending = [s for s in stocks if due(s["symbol"])][:MAX_PER_BATCH]
        updated: dict[str, list] = {}
        errors: list[str] = []

        def fetch(stock: dict):
            last = index["last_dates"].get(stock["symbol"])
            start = date.fromisoformat(last) - timedelta(days=7) if last else today - timedelta(days=HISTORY_DAYS)
            return stock["symbol"], client.daily_history(stock["stock_id"], start, today)

        done = 0
        with ThreadPoolExecutor(WORKERS) as pool:
            queue = iter(pending)
            running = set()
            while True:
                while len(running) < WORKERS and time.monotonic() - started < budget_seconds:
                    nxt = next(queue, None)
                    if nxt is None:
                        break
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
                except YounitError as exc:
                    errors.append(f"{fut.symbol}: {exc}")  # type: ignore[attr-defined]
                    if len(errors) >= 8:  # the feed is failing: stop hammering it
                        for other in running:
                            other.cancel()
                        break

        stamp = _now().isoformat()
        names = sorted({chunk_of(symbol) for symbol in updated})
        with ThreadPoolExecutor(8) as pool:
            chunks = {name: doc or {"bars": {}} for name, doc in zip(names, pool.map(self.docs.get, names), strict=True)}
        for symbol, rows in updated.items():
            name = chunk_of(symbol)
            merged = {r[0]: r for r in chunks[name]["bars"].get(symbol, [])}
            merged.update({r[0]: r for r in rows})
            bars = [merged[k] for k in sorted(merged)][-MAX_BARS:]
            chunks[name]["bars"][symbol] = bars
            index["checked"][symbol] = stamp
            index["last_dates"][symbol] = bars[-1][0] if bars else None
        for doc in chunks.values():
            doc["bars"] = {s: b for s, b in doc["bars"].items() if s in known}
            while len(json.dumps(doc, separators=(",", ":"))) > MAX_DOC_BYTES:  # stay under the document size limit
                longest = max(doc["bars"], key=lambda s: len(doc["bars"][s]))
                doc["bars"][longest] = doc["bars"][longest][100:]
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(lambda item: self.docs.put(*item), chunks.items()))
        index["last_dates"] = {s: d for s, d in index["last_dates"].items() if s in known}
        index["checked"] = {s: d for s, d in index["checked"].items() if s in known}
        index["errors"] = errors[:8]
        index["updated_at"] = stamp
        index["version"] = int(index.get("version", 0)) + 1
        self.docs.put("index", index)
        self.docs.put("meta", _meta(index))  # last: readers switch to the new version only once it is all there
        Feed.reset()
        remaining = sum(1 for s in stocks if due(s["symbol"]))
        return {"updated": done, "remaining": remaining, "total": len(stocks), "errors": errors[:5],
                "stalled": done == 0 and remaining > 0, "seconds": round(time.monotonic() - started, 1)}
