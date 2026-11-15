"""Market data access: instruments, cached price frames, CSV import, data-quality status."""
from __future__ import annotations

import csv
import io
from datetime import date, datetime
from pathlib import Path

import pandas as pd

from . import sample
from .calendar import trading_days_between

SEED_FILE = Path(__file__).resolve().parent.parent.parent / "seed" / "egx_instruments.csv"
STALE_AFTER_TRADING_DAYS = 2


class DataError(ValueError):
    pass


MAX_CSV_ROWS = 6000
UNCLASSIFIED = "Unclassified"


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
                 feed: dict | None = None):
        self.store = store
        self.cache = cache
        self.data_version = data_version
        self.feed = feed  # Feed.load() state from the shared Younit cache, or None
        # Synthetic prices are never mixed with a real feed.
        self.sample = sample and feed is None
        self.today = today or date.today()

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
        key = (self.data_version, self.today.isoformat(), self.sample, self.feed["version"] if self.feed else None)
        if self.cache.get("key") == key:
            return
        custom = self.store.list("instruments")
        if self.feed is not None:
            # The feed defines which stocks exist. It carries no sector, so the seed
            # list's classification is used where the symbol is known.
            sector = {i["symbol"]: i["sector"] for i in _SEED if i["type"] == "stock"}
            base = [{"symbol": i["symbol"], "name": i["name"], "type": "stock",
                     "sector": sector.get(i["symbol"], UNCLASSIFIED)} for i in self.feed["instruments"]]
        else:
            base = list(_SEED)
        listed = {i["symbol"] for i in base}
        instruments = sorted(base + [c for c in custom if c["symbol"] not in listed], key=lambda i: i["symbol"])
        frames: dict[str, pd.DataFrame] = {}
        sources: dict[str, str] = {}

        def frame(rows) -> pd.DataFrame:
            df = pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])
            df["date"] = pd.to_datetime(df["date"])
            return df.set_index("date").sort_index()

        imported = {d["symbol"]: d["rows"] for d in self.store.list("bars")}
        if self.sample:
            for symbol, rows in sample.generate([i for i in instruments if i["symbol"] not in imported], self.today).items():
                frames[symbol], sources[symbol] = frame(rows), "sample"
        if self.feed is not None:
            for symbol, df in self.feed["frames"].items():  # built once per server instance, shared by reference
                if symbol not in imported:
                    frames[symbol], sources[symbol] = df, "younit"
        for symbol, rows in imported.items():
            frames[symbol], sources[symbol] = frame(rows), "csv"
        self.cache.clear()
        self.cache.update(key=key, instruments=instruments, by_symbol={i["symbol"]: i for i in instruments},
                          frames=frames, sources=sources)

    def bars(self, symbol: str) -> pd.DataFrame | None:
        self._load()
        return self.cache["frames"].get(symbol)

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
        for n, row in enumerate(reader, start=2):
            try:
                d = _parse_date(row[cols["date"]])
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
            "is_live": False,
            "symbols_behind_latest": sorted(s for s, f in frames.items() if latest and f.index[-1].date() < latest),
            "symbols_without_data": sorted(i["symbol"] for i in self.cache["instruments"] if i["symbol"] not in frames),
        }


def _parse_date(text: str) -> date:
    text = str(text).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d", "%d-%m-%Y", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unrecognised date {text!r} (use YYYY-MM-DD)")
