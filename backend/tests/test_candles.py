"""Candlestick pattern detection: each shape is found where it belongs, and nothing looks ahead."""
import numpy as np
import pandas as pd
import pytest

from app.config import Settings
from app.domain import candles
from app.domain.backtest import run_backtest
from app.domain.fees import DEFAULT_FEE_SCHEDULE
from app.domain.strategies import STRATEGY_TYPES, StrategyConfig, signals
from app.services import App, _period_open
from app.store.sqlite_store import Store


def frame(rows):
    idx = pd.bdate_range("2025-01-01", periods=len(rows))
    return pd.DataFrame(rows, columns=["open", "high", "low", "close", "volume"], index=idx, dtype=float)


def decline(n=14, start=100.0):
    """Steady black candles: one point down a session. Returns the rows and the last close."""
    rows, p = [], start
    for _ in range(n):
        rows.append([p, p + 0.3, p - 1.3, p - 1.0, 1000])
        p -= 1.0
    return rows, p


def advance(n=14, start=100.0):
    rows, p = [], start
    for _ in range(n):
        rows.append([p, p + 1.3, p - 0.3, p + 1.0, 1000])
        p += 1.0
    return rows, p


def found(rows, last=1):
    return {p["pattern"]: p for p in candles.patterns(frame(rows), last=last)}


@pytest.mark.parametrize("name,after,bars", [
    ("hammer", "decline", lambda p: [[p - 0.1, p + 0.45, p - 2.0, p + 0.4, 1500]]),
    ("inverted_hammer", "decline", lambda p: [[p - 0.6, p + 1.5, p - 0.65, p - 0.1, 1500]]),
    ("bullish_engulfing", "decline", lambda p: [[p - 0.2, p + 1.6, p - 0.5, p + 1.5, 2000]]),
    ("piercing", "decline", lambda p: [[p - 0.4, p + 0.8, p - 0.6, p + 0.7, 2000]]),
    ("bullish_harami", "decline", lambda p: [[p + 0.3, p + 0.6, p + 0.2, p + 0.5, 800]]),
    ("bullish_harami_cross", "decline", lambda p: [[p + 0.5, p + 0.8, p + 0.2, p + 0.5, 800]]),
    ("doji_after_decline", "decline", lambda p: [[p - 0.5, p, p - 1.0, p - 0.5, 800]]),
    ("morning_star", "decline", lambda p: [[p - 0.5, p - 0.3, p - 0.9, p - 0.7, 800], [p - 0.5, p + 0.9, p - 0.6, p + 0.8, 1500]]),
    ("morning_doji_star", "decline", lambda p: [[p - 0.6, p - 0.3, p - 0.9, p - 0.6, 800], [p - 0.5, p + 0.9, p - 0.6, p + 0.8, 1500]]),
    ("rising_window", "decline", lambda p: [[p + 1.5, p + 2.5, p + 1.4, p + 2.4, 3000]]),
    ("hanging_man", "advance", lambda p: [[p + 0.1, p + 0.15, p - 2.0, p - 0.4, 1500]]),
    ("shooting_star", "advance", lambda p: [[p + 0.1, p + 2.0, p + 0.05, p + 0.6, 1500]]),
    ("bearish_engulfing", "advance", lambda p: [[p + 0.2, p + 0.5, p - 1.6, p - 1.5, 2000]]),
    ("dark_cloud_cover", "advance", lambda p: [[p + 0.4, p + 0.6, p - 0.8, p - 0.7, 2000]]),
    ("bearish_harami", "advance", lambda p: [[p - 0.3, p - 0.2, p - 0.6, p - 0.5, 800]]),
    ("doji_after_advance", "advance", lambda p: [[p + 0.5, p + 1.0, p, p + 0.5, 800]]),
    ("evening_star", "advance", lambda p: [[p + 0.5, p + 0.9, p + 0.3, p + 0.7, 800], [p + 0.5, p + 0.6, p - 0.9, p - 0.8, 1500]]),
    ("three_black_crows", "advance", lambda p: [[p - 0.1, p, p - 1.3, p - 1.2, 900], [p - 0.5, p - 0.4, p - 2.5, p - 2.4, 900],
                                                [p - 1.6, p - 1.5, p - 3.7, p - 3.6, 900]]),
    ("falling_window", "advance", lambda p: [[p - 1.5, p - 1.4, p - 2.5, p - 2.4, 3000]]),
])
def test_each_pattern_is_found_in_its_setting(name, after, bars):
    rows, p = decline() if after == "decline" else advance()
    hit = found(rows + bars(p)).get(name)
    assert hit is not None, f"{name} not found"
    label, direction, kind, n, waits = candles.PATTERNS[name]
    assert (hit["name"], hit["direction"], hit["kind"], hit["bars"], hit["needs_confirmation"]) == (label, direction, kind, n, waits)
    assert hit["state"] == "pending" and hit["level_role"] == ("support" if direction == "bullish" else "resistance")


def test_three_white_soldiers():
    rows, p = decline()
    rows += [[p + 0.1, p + 1.3, p, p + 1.2, 900], [p + 0.5, p + 2.5, p + 0.4, p + 2.4, 900], [p + 1.6, p + 3.7, p + 1.5, p + 3.6, 900]]
    assert "three_white_soldiers" in found(rows)


def test_the_same_shape_means_nothing_without_the_trend_before_it():
    """A hammer needs a decline and a shooting star an advance: in a flat market neither is reported."""
    flat = [[50, 50.6, 49.4, 50.2 if i % 2 else 49.8, 1000] for i in range(20)]
    assert found(flat + [[50.0, 50.45, 48.0, 50.4, 1500]]) == {}
    assert found(flat + [[50.0, 52.0, 49.95, 50.4, 1500]]) == {}
    rows, p = advance()          # the hammer's shape after a rise is a hanging man, not a hammer
    assert set(found(rows + [[p + 0.1, p + 0.15, p - 2.0, p - 0.4, 1500]])) == {"hanging_man"}


def test_level_and_what_followed():
    rows, p = decline()
    hammer = [p - 0.1, p + 0.45, p - 2.0, p + 0.4, 1500]
    up = [p + 0.5, p + 1.6, p + 0.4, p + 1.5, 1200]
    assert found(rows + [hammer])["hammer"]["level"] == pytest.approx(p - 2.0)           # its own low
    assert found(rows + [hammer, up], last=2)["hammer"]["state"] == "confirmed"          # next close above its body
    assert found(rows + [hammer, [p + 0.3, p + 0.5, p - 0.5, p + 0.2, 900]], last=2)["hammer"]["state"] == "unconfirmed"
    broken = [p + 0.2, p + 0.3, p - 3.0, p - 2.5, 1200]
    assert found(rows + [hammer, up, broken], last=3)["hammer"]["state"] == "failed"     # a later close under its low
    gap = [p + 1.5, p + 2.5, p + 1.4, p + 2.4, 3000]
    window = found(rows + [gap, [p + 2.4, p + 3.0, p + 2.0, p + 2.8, 1000]], last=2)["rising_window"]
    assert window["state"] == "open" and window["level"] == pytest.approx(p + 1.3)        # the high before the gap
    assert found(rows + [gap, [p + 2.0, p + 2.1, p + 0.5, p + 1.0, 1000]], last=2)["rising_window"]["state"] == "failed"
    assert found(rows + [hammer])["hammer"]["volume_ratio"] == pytest.approx(1.5)


def test_untraded_sessions_are_not_patterns():
    """A thin stock that prints one price all day has no candle to read."""
    assert candles.patterns(frame([[10, 10, 10, 10, 0]] * 40), last=40) == []
    assert candles.patterns(frame([[10, 10.5, 9.5, 10.2, 5]] * 2)) == []   # too little history


def _random_walk(n=400, seed=1):
    rng = np.random.default_rng(seed)
    close = 50 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
    open_ = np.concatenate([[close[0]], close[:-1]]) * (1 + rng.normal(0, 0.004, n))
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.008, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.008, n)))
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": rng.integers(1000, 9000, n).astype(float)},
                        index=pd.bdate_range("2024-01-01", periods=n))


def test_detection_has_no_lookahead():
    df = _random_walk()
    pd.testing.assert_frame_equal(candles.detect(df).iloc[:250], candles.detect(df.iloc[:250]))
    for confirm in (True, False):
        pd.testing.assert_frame_equal(candles.reversal_signals(df, confirm).iloc[:250], candles.reversal_signals(df.iloc[:250], confirm))
    # every pattern the strategy trades on is one the detector knows, on the right side
    assert all(candles.PATTERNS[c][1] == "bullish" for c in candles.BULLISH_REVERSALS)
    assert all(candles.PATTERNS[c][1] == "bearish" for c in candles.BEARISH_REVERSALS)


def test_candle_strategy_signals_and_backtest():
    spec = STRATEGY_TYPES["candle_reversal"]
    assert spec["available"] and set(spec["params"]) == {"confirm", "trend_sma"}
    assert StrategyConfig(name="c", type="candle_reversal").params == {"confirm": 1.0, "trend_sma": 0.0}
    with pytest.raises(ValueError, match="between"):
        StrategyConfig(name="c", type="candle_reversal", params={"confirm": 2})

    rows, p = decline()
    hammer, up = [p - 0.1, p + 0.45, p - 2.0, p + 0.4, 1500], [p + 0.5, p + 1.6, p + 0.4, p + 1.5, 1200]
    df = frame(rows + [hammer, up, [p + 1.5, p + 2.5, p + 1.4, p + 2.4, 1000]])
    waits = signals(StrategyConfig(name="c", type="candle_reversal"), df)
    at_once = signals(StrategyConfig(name="c", type="candle_reversal", params={"confirm": 0}), df)
    assert list(waits["entry"].iloc[-3:]) == [False, True, False]     # the session after the hammer confirms it
    assert list(at_once["entry"].iloc[-3:]) == [True, False, False]   # or the hammer itself, without waiting
    # a filter on the longer trend keeps a bounce inside a decline out
    filtered = signals(StrategyConfig(name="c", type="candle_reversal", params={"trend_sma": 10}), df)
    assert not filtered["entry"].any()
    # a close under the bought pattern's low is the exit, once, on the session it happens
    failed = frame(rows + [hammer, up, [p + 1.0, p + 1.1, p - 3.0, p - 2.5, 1000], [p - 2.5, p - 2.4, p - 3.5, p - 3.4, 1000]])
    assert list(signals(StrategyConfig(name="c", type="candle_reversal"), failed)["exit"].iloc[-2:]) == [True, False]

    market = _random_walk(500, seed=3)
    full = signals(StrategyConfig(name="c", type="candle_reversal"), market)
    pd.testing.assert_frame_equal(full.iloc[:300], signals(StrategyConfig(name="c", type="candle_reversal"), market.iloc[:300]))
    result = run_backtest(StrategyConfig(name="c", type="candle_reversal", symbols=["AAA"]), {"AAA": market},
                          DEFAULT_FEE_SCHEDULE, start=None, end=None, capital=50_000)
    assert result["metrics"]["trades"] >= 1


def test_stock_page_and_market_scan(tmp_path):
    core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()
    for tf in ("d", "w", "m"):
        detail = core.stock_detail("COMI", tf)
        shown = {b["time"] for b in detail["bars"]}
        assert all(p["date"] in shown and p["pattern"] in candles.PATTERNS for p in detail["patterns"])
    scan = core.candle_scan(sessions=10)
    assert scan["stocks_read"] > 0 and scan["matches"], "ten sessions of 53 stocks hold at least one pattern"
    assert {"symbol", "company", "sector", "pattern", "state", "level"} <= set(scan["matches"][0])
    assert all(m["direction"] == "bullish" and m["kind"] == "reversal"
               for m in core.candle_scan("bullish", sessions=10, reversals_only=True)["matches"])
    assert {m["sector"] for m in core.candle_scan(sessions=10, sector="Banks")["matches"]} <= {"Banks"}


def test_a_week_or_month_that_has_not_ended_is_still_forming():
    assert _period_open(pd.Timestamp("2026-11-11"), "w") and not _period_open(pd.Timestamp("2026-11-12"), "w")   # Wed, Thu
    assert _period_open(pd.Timestamp("2026-11-26"), "m") and not _period_open(pd.Timestamp("2026-11-30"), "m")
    assert not _period_open(pd.Timestamp("2026-10-29"), "m")   # Thursday the 29th: the 30th and 31st are the weekend
    assert not _period_open(pd.Timestamp("2026-11-11"), "d")
