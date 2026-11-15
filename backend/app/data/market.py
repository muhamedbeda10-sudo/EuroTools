"""Market data access: instruments, cached price frames, CSV import, data-quality status."""
from __future__ import annotations

import csv
import io
import threading
from datetime import date, datetime
from pathlib import Path

import pandas as pd

from . import sample
from .calendar import cairo_now, market_open, trading_days_between

SEED_FILE = Path(__file__).resolve().parent.parent.parent / "seed" / "egx_instruments.csv"
STALE_AFTER_TRADING_DAYS = 2


class DataError(ValueError):
    pass


MAX_CSV_ROWS = 6000
UNCLASSIFIED = "Unclassified"
# A page opens with several requests at once. The first one builds the price tables; the others
# wait for it and reuse them instead of each doing the same work side by side.
BUILD_LOCK = threading.RLock()


def seed_instruments() -> list[dict]:
    with open(SEED_FILE, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


_SEED = seed_instruments()


class MarketData:
    """Price history = imported CSV bars, with deterministic sample bars filling the gaps.

    `cache` is a plain dict owned by the caller (one per user); it survives
    between requests on a warm server instance and is invalidated by
    `data_version`, which is bumped on every import, and by the calendar day.
    """

    def __init__(self, store, cache: dict, *, data_version: int, sample: bool, today: date | None = None,
                 feed: dict | None = None, now: datetime | None = None):
        self.store = store
        self.cache = cache
        self.data_version = data_version
        self.feed = feed  # Feed.load() state from the shared Younit cache, or None
        # Synthetic prices are never mixed with a real feed.
        self.sample = sample and feed is None
        self.now = now or cairo_now()
        self.today = today or self.now.date()
        # A price is "live" only while a session is actually running.
        self.open = self.today == self.now.date() and market_open(self.now)

    # ---- instruments -----------------------------------------------------
    def instruments(self, include_indices: bool = False) -> list[dict]:
        self._load()
        items = self.cache["instruments"]
        return items if include_indices else [i for i in items if i["type"] == "stock"]

    def instrument(self, symbol: str) -> dict | None:
        self._load()
        return self.cache["by_symbol"].get(symbol)

    # ---- bars ------------------------------------------------------------
    def _load(self) -> None:
        key = (self.data_version, self.today.isoformat(), self.sample,
               (self.feed["version"], self.feed.get("live_ts")) if self.feed else None, self.open)
        if self.cache.get("key") == key:
            return
        with BUILD_LOCK:
            if self.cache.get("key") != key:
                self._build(key)

    def _build(self, key: tuple) -> None:
        custom = self.store.list("instruments")
        if self.feed is not None:
            # The feed defines which stocks exist. It carries no sector, so the seed
            # list's classification is used where the symbol is known.
            sector = {i["symbol"]: i["sector"] for i in _SEED if i["type"] == "stock"}
            sector.update(((self.feed.get("live") or {}).get("sectors")) or {})  # the exchange's own, when the feed sent it
            # A stock that left the feed's list stays known (marked `listed: False`): it may still be held.
            base = [{"symbol": i["symbol"], "name": i["name"], "type": "stock",
                     "sector": sector.get(i["symbol"], UNCLASSIFIED), **({} if i.get("listed", True) else {"listed": False})}
                    for i in self.feed["instruments"]]
        else:
            base = list(_SEED)
        listed = {i["symbol"] for i in base}
        instruments = sorted(base + [c for c in custom if c["symbol"] not in listed], key=lambda i: i["symbol"])
        frames: dict[str, pd.DataFrame] = {}
        sources: dict[str, str] = {}
        watermark: dict[str, pd.Timestamp] = {}  # per stock: the last session whose bar is final
        live_symbols: set[str] = set()
        snapshot_symbols: set[str] = set()  # today's bar comes from a price snapshot, live or not

        def frame(rows) -> pd.DataFrame:
            df = pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])
            df["date"] = pd.to_datetime(df["date"])
            return df.set_index("date").sort_index()

        imported = {d["symbol"]: d["rows"] for d in self.store.list("bars")}
        if self.sample:
            for symbol, rows in sample.generate([i for i in instruments if i["symbol"] not in imported], self.today).items():
                frames[symbol], sources[symbol] = frame(rows), "sample"
        if self.feed is not None:
            live = self.feed.get("live") or {}
            live_quotes = live.get("quotes", {}) if live.get("date") == self.today.isoformat() else {}
            stamp = pd.Timestamp(self.today)
            marks = self.feed.get("settled_until") or {}
            for symbol, df in self.feed["frames"].items():  # built once per server instance, shared by reference
                if symbol in imported:
                    continue
                # Without a record of when it was read, only days before today are taken as final.
                mark = pd.Timestamp(marks[symbol]) if symbol in marks else stamp - pd.Timedelta(days=1)
                watermark[symbol] = mark
                q = live_quotes.get(symbol)
                if q and len(df) and mark < stamp and stamp >= df.index[-1]:
                    # Today's session so far, as one bar on top of the settled history. Once the final
                    # bar has been read after the close (mark == today) the snapshot is no longer used.
                    last, opened, high, low, volume = q
                    if stamp == df.index[-1]:
                        row = df.iloc[-1]
                        opened, high, low = row["open"], max(row["high"], high), min(row["low"], low)
                        volume = max(row["volume"], volume)
                        df = df.iloc[:-1]
                    df = pd.concat([df, pd.DataFrame(
                        {"open": opened, "high": high, "low": low, "close": last, "volume": volume}, index=[stamp])])
                    df.index.name = "date"
                    snapshot_symbols.add(symbol)
                    if self.open:
                        live_symbols.add(symbol)
                frames[symbol], sources[symbol] = df, "younit"
        for symbol, rows in imported.items():
            frames[symbol], sources[symbol] = frame(rows), "csv"
        for symbol, df in frames.items():  # imported and sample history is final as far as it reaches
            if symbol not in watermark and len(df):
                watermark[symbol] = df.index[-1]
        self.cache.clear()
        live_doc = (self.feed or {}).get("live") or {}
        self.cache.update(key=key, instruments=instruments, by_symbol={i["symbol"]: i for i in instruments},
                          frames=frames, sources=sources, settled={}, watermark=watermark, live_symbols=live_symbols,
                          snapshot_symbols=snapshot_symbols,
                          live_as_of=live_doc.get("ts") if snapshot_symbols else None,
                          shared_only=self.feed is not None and not imported and not custom,
                          indices=[{**i, "as_of": live_doc.get("ts"), "live": live_doc.get("date") == self.today.isoformat()}
                                   for i in live_doc.get("indices") or []])

    def bars(self, symbol: str, *, settled: bool = False) -> pd.DataFrame | None:
        """Price history. `settled=True` keeps completed sessions only: a bar whose session is still
        running (or was read before it closed) is left out. Backtests, signals and automatic trades use it."""
        self._load()
        df = self.cache["frames"].get(symbol)
        if not settled or df is None:
            return df
        done = self.cache["settled"]
        if symbol not in done:
            mark = self.cache["watermark"].get(symbol)
            done[symbol] = df if mark is None or not len(df) or df.index[-1] <= mark else df[df.index <= mark]
        return done[symbol]

    def settled_until(self, symbol: str) -> pd.Timestamp | None:
        """The last session known to be final for this stock, whether or not it traded that day."""
        self._load()
        return self.cache["watermark"].get(symbol)

    def latest_settled(self) -> pd.Timestamp | None:
        """The most recent completed session any stock has a bar for."""
        self._load()
        if "latest_settled" not in self.cache:
            dates = [df.index[-1] for s in self.cache["frames"] if (df := self.bars(s, settled=True)) is not None and len(df)]
            self.cache["latest_settled"] = max(dates) if dates else None
        return self.cache["latest_settled"]

    def is_live(self, symbol: str) -> bool:
        self._load()
        return symbol in self.cache["live_symbols"]

    def from_snapshot(self, symbol: str) -> bool:
        """True when today's bar is a price snapshot rather than the session's final bar."""
        self._load()
        return symbol in self.cache["snapshot_symbols"]

    def source(self, symbol: str) -> str | None:
        self._load()
        return self.cache["sources"].get(symbol)

    def closes(self, symbols: list[str]) -> pd.DataFrame:
        self._load()
        frames = self.cache["frames"]
        return pd.DataFrame({s: frames[s]["close"] for s in symbols if s in frames})

    def latest_date(self) -> date | None:
        self._load()
        dates = [f.index[-1] for f in self.cache["frames"].values() if len(f)]
        return max(dates).date() if dates else None

    # ---- import ----------------------------------------------------------
    def import_csv(self, symbol: str, content: str, *, name: str | None = None,
                   sector: str | None = None) -> dict:
        symbol = symbol.strip().upper()
        if not symbol.isalnum() or len(symbol) > 12:
            raise DataError("symbol must be 1-12 letters/digits")
        ins = self.instrument(symbol)
        if ins is None and not (name and sector):
            raise DataError(f"unknown symbol {symbol}: provide name and sector to create it")
        reader = csv.DictReader(io.StringIO(content.lstrip("﻿")))
        if not reader.fieldnames:
            raise DataError("empty file")
        cols = {c.strip().lower(): c for c in reader.fieldnames}
        missing = [c for c in ("date", "open", "high", "low", "close") if c not in cols]
        if missing:
            raise DataError(f"missing column(s): {', '.join(missing)}. Expected date,open,high,low,close,volume")
        seen: dict[str, tuple] = {}
        lines = list(reader)
        fmt = _date_format([str(row.get(cols["date"]) or "").strip() for row in lines])
        for n, row in enumerate(lines, start=2):
            try:
                d = datetime.strptime(str(row[cols["date"]]).strip(), fmt).date()
                o, h, low, c = (float(str(row[cols[k]]).replace(",", "")) for k in ("open", "high", "low", "close"))
                v = float(str(row.get(cols.get("volume", ""), 0) or 0).replace(",", ""))
            except (ValueError, TypeError, KeyError) as exc:
                raise DataError(f"line {n}: {exc}") from None
            if min(o, h, low, c) <= 0 or v < 0:
                raise DataError(f"line {n}: prices must be positive and volume non-negative")
            if h < max(o, c) or low > min(o, c):
                raise DataError(f"line {n}: high/low inconsistent with open/close")
            if d > self.today:
                raise DataError(f"line {n}: date {d} is in the future")
            seen[d.isoformat()] = (d.isoformat(), o, h, low, c, v)
        if len(seen) < 2:
            raise DataError("need at least 2 rows of data")
        if len(seen) > MAX_CSV_ROWS:
            raise DataError(f"too many rows ({len(seen)}); the limit is {MAX_CSV_ROWS} daily bars per stock")
        rows = [list(seen[k]) for k in sorted(seen)]
        with self.store.transaction():
            if ins is None:
                self.store.put("instruments", symbol,
                               {"symbol": symbol, "name": name.strip(), "sector": sector.strip(), "type": "stock"})
            self.store.put("bars", symbol, {"symbol": symbol, "rows": rows})
        return {"symbol": symbol, "rows": len(rows), "first_date": rows[0][0], "last_date": rows[-1][0]}

    # ---- data quality ----------------------------------------------------
    def status(self) -> dict:
        self._load()
        frames, src = self.cache["frames"], self.cache["sources"]
        sources = []
        for name in sorted(set(src.values())):
            fs = [frames[s] for s in frames if src[s] == name]
            sources.append({"source": name, "symbols": len(fs), "bars": int(sum(len(f) for f in fs)),
                            "first_date": min(f.index[0] for f in fs).strftime("%Y-%m-%d"),
                            "last_date": max(f.index[-1] for f in fs).strftime("%Y-%m-%d")})
        latest = self.latest_date()
        age = trading_days_between(latest, self.today) if latest else None
        names = set(src.values())
        return {
            "sources": sources,
            "mode": ("none" if not names else "sample" if names == {"sample"} else "mixed" if "sample" in names
                     else "younit" if "younit" in names else "imported"),
            "has_sample_data": "sample" in names,
            "latest_bar_date": latest.isoformat() if latest else None,
            "trading_days_behind": age,
            "is_stale": bool(age is not None and age > STALE_AFTER_TRADING_DAYS),
            "is_live": bool(self.cache["live_symbols"]),
            "live_as_of": self.cache["live_as_of"],
            "live_symbols": len(self.cache["live_symbols"]),
            "symbols_behind_latest": sorted(s for s, f in frames.items() if latest and f.index[-1].date() < latest),
            "symbols_without_data": sorted(i["symbol"] for i in self.cache["instruments"] if i["symbol"] not in frames),
        }


UNAMBIGUOUS_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%d-%m-%Y")
DAY_FIRST, MONTH_FIRST = "%d/%m/%Y", "%m/%d/%Y"


def _date_format(values: list[str]) -> str:
    """The one date format every row of the file is written in.

    Dates are never guessed row by row: 03/04/2025 would be read as 3 April on one
    line and 4 March on another. A file that fits both day/month and month/day is
    refused rather than imported on a coin toss.
    """
    def fits(fmt: str) -> bool:
        try:
            for v in values:
                datetime.strptime(v, fmt)
        except ValueError:
            return False
        return True

    if not values:
        raise DataError("need at least 2 rows of data")
    for fmt in UNAMBIGUOUS_FORMATS:
        if fits(fmt):
            return fmt
    day_first, month_first = fits(DAY_FIRST), fits(MONTH_FIRST)
    if day_first and month_first:
        raise DataError("the dates could be day/month or month/day (e.g. 03/04/2025); write them as YYYY-MM-DD")
    if day_first or month_first:
        return DAY_FIRST if day_first else MONTH_FIRST
    # Name the first line that fits none of the formats the rest of the file could be in.
    formats = [f for f in (*UNAMBIGUOUS_FORMATS, DAY_FIRST, MONTH_FIRST)]
    for n, v in enumerate(values, start=2):
        ok = []
        for fmt in formats:
            try:
                datetime.strptime(v, fmt)
                ok.append(fmt)
            except ValueError:
                pass
        if not ok:
            raise DataError(f"line {n}: unrecognised date {v!r} (use YYYY-MM-DD)")
    raise DataError("the dates are not all written the same way; use YYYY-MM-DD on every line")
