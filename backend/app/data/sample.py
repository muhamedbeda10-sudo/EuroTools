"""Deterministic SAMPLE price generator.

These are synthetic random walks, NOT market prices. They exist so every screen
and the backtester can be exercised before a real data feed is connected. The
UI labels them as sample data everywhere.

The series is anchored to a fixed start date and each random stream is drawn in
one call from its own seeded generator, so the price for a given date never
changes from one day (or one server instance) to the next: later days only
append. Nothing is stored.
"""
from __future__ import annotations

import zlib
from datetime import date, timedelta

import numpy as np

from .calendar import is_trading_day

EPOCH = date(2024, 1, 1)


def _rng(*parts: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(":".join(parts).encode()))


def trading_dates(end: date) -> list[str]:
    out, d = [], EPOCH
    while d <= end:
        if is_trading_day(d):
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def generate(instruments: list[dict], end: date) -> dict[str, list[tuple]]:
    dates = trading_dates(end)
    n = len(dates)
    market = _rng("market").normal(0.0004, 0.009, n)
    sector_factor: dict[str, np.ndarray] = {}
    out: dict[str, list[tuple]] = {}
    for ins in instruments:
        sym, sector = ins["symbol"], ins["sector"]
        if sector not in sector_factor:
            sector_factor[sector] = _rng("sector", sector).normal(0.0, 0.007, n)
        scalars = _rng(sym, "scalars").uniform(0, 1, 4)
        if ins["type"] == "index":
            rets = market + _rng(sym, "noise").normal(0, 0.002, n)
            start = {"EGX30": 30000.0, "EGX70": 9000.0, "EGX100": 12500.0}.get(sym, 10000.0)
            base_vol = 0.0
        else:
            beta = 0.6 + 0.8 * scalars[0]
            # slow regime drift so trend strategies have something to find
            regime = np.repeat(_rng(sym, "regime").normal(0.0, 0.0012, n // 40 + 1), 40)[:n]
            noise = _rng(sym, "noise").normal(0, 1, n) * (0.010 + 0.012 * scalars[1])
            rets = beta * market + sector_factor[sector] + regime + noise
            start = 2.0 + 88.0 * scalars[2]
            base_vol = 2e5 + 5.8e6 * scalars[3]
        close = start * np.exp(np.cumsum(rets))
        prev = np.concatenate([[start], close[:-1]])
        open_ = prev * np.exp(_rng(sym, "open").normal(0, 0.004, n))
        spread = np.abs(_rng(sym, "spread").normal(0, 0.008, n))
        high = np.maximum(open_, close) * (1 + spread)
        low = np.minimum(open_, close) * (1 - spread)
        volume = base_vol * np.exp(_rng(sym, "volume").normal(0, 0.5, n)) * (1 + 8 * np.abs(rets)) if base_vol else np.zeros(n)
        out[sym] = [
            (dates[i], round(float(open_[i]), 2), round(float(high[i]), 2), round(float(low[i]), 2),
             round(float(close[i]), 2), float(int(volume[i])))
            for i in range(n)
        ]
    return out
