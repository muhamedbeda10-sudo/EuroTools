"""Japanese candlestick patterns on OHLCV frames (pandas / numpy).

A pattern is judged on bars up to and including its own last bar, so it is known at that bar's
close and nothing here looks ahead. What happened AFTER a pattern (confirmed, failed) is reported
separately as its `state`, from the bars that followed it.

The shapes follow the classical definitions; the thresholds below are this app's reading of words
such as "long", "small" and "after a decline", which the classical texts leave to the eye.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

BODY_WINDOW = 10      # sessions a candle's body and range are compared with
TREND_BARS = 5        # "after a decline / an advance": close vs this many bars earlier, and vs the 10-bar average
TREND_MOVE = 1.0      # ...by at least this many average session ranges, so a wiggle in a flat market is not a trend
DOJI_BODY = 0.10      # body at most this share of the bar's range
SHADOW_MULT = 2.0     # long shadow of a hammer or shooting star, in bodies
SHORT_SHADOW = 0.15   # the opposite shadow, at most this share of the range
UMBRELLA_BODY = 0.35  # body of a hammer-like bar, at most this share of the range
LONG_BODY = 1.0       # "long" body: at least this many average bodies...
LONG_SHARE = 0.5      # ...and at least this share of its own range
SMALL_BODY = 0.5      # "small" body, in average bodies
STAR_OVERLAP = 0.2    # how far a star's body may reach into the first candle's body
FOLLOW_BARS = 5       # sessions after a pattern in which a close through its level makes it failed

# code: (label, direction, kind, bars, waits for the next session's confirmation)
PATTERNS: dict[str, tuple[str, str, str, int, bool]] = {
    "hammer": ("Hammer", "bullish", "reversal", 1, False),
    "inverted_hammer": ("Inverted hammer", "bullish", "reversal", 1, True),
    "bullish_engulfing": ("Bullish engulfing", "bullish", "reversal", 2, False),
    "piercing": ("Piercing pattern", "bullish", "reversal", 2, False),
    "bullish_harami": ("Bullish harami", "bullish", "reversal", 2, True),
    "bullish_harami_cross": ("Bullish harami cross", "bullish", "reversal", 2, True),
    "morning_star": ("Morning star", "bullish", "reversal", 3, False),
    "morning_doji_star": ("Morning doji star", "bullish", "reversal", 3, False),
    "doji_after_decline": ("Doji after a decline", "bullish", "reversal", 1, True),
    "three_white_soldiers": ("Three white soldiers", "bullish", "reversal", 3, False),
    "rising_window": ("Rising window (gap up)", "bullish", "continuation", 2, False),
    "hanging_man": ("Hanging man", "bearish", "reversal", 1, True),
    "shooting_star": ("Shooting star", "bearish", "reversal", 1, False),
    "bearish_engulfing": ("Bearish engulfing", "bearish", "reversal", 2, False),
    "dark_cloud_cover": ("Dark-cloud cover", "bearish", "reversal", 2, False),
    "bearish_harami": ("Bearish harami", "bearish", "reversal", 2, True),
    "bearish_harami_cross": ("Bearish harami cross", "bearish", "reversal", 2, True),
    "evening_star": ("Evening star", "bearish", "reversal", 3, False),
    "evening_doji_star": ("Evening doji star", "bearish", "reversal", 3, False),
    "doji_after_advance": ("Doji after an advance", "bearish", "reversal", 1, True),
    "three_black_crows": ("Three black crows", "bearish", "reversal", 3, False),
    "falling_window": ("Falling window (gap down)", "bearish", "continuation", 2, False),
}
WINDOWS = ("rising_window", "falling_window")
# What the candle-reversal strategy trades on. A lone doji is a warning, not a signal, and is left out.
BULLISH_REVERSALS = ("hammer", "inverted_hammer", "bullish_engulfing", "piercing", "bullish_harami",
                     "bullish_harami_cross", "morning_star", "morning_doji_star", "three_white_soldiers")
BEARISH_REVERSALS = ("hanging_man", "shooting_star", "bearish_engulfing", "dark_cloud_cover", "bearish_harami",
                     "bearish_harami_cross", "evening_star", "evening_doji_star", "three_black_crows")


def _back(a: np.ndarray, k: int, fill=np.nan) -> np.ndarray:
    """The array as it stood k bars earlier."""
    if k == 0:
        return a
    out = np.full(len(a), fill, dtype=a.dtype if a.dtype == bool else float)
    if k < len(a):
        out[k:] = a[:-k]
    return out


def detect(df: pd.DataFrame) -> pd.DataFrame:
    """One boolean column per pattern, true on the bar that completes it, plus the columns the
    callers need to judge what followed: `top` and `bot` of each body."""
    o, h, low, c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    body, rng = np.abs(c - o), h - low
    top, bot = np.maximum(o, c), np.minimum(o, c)
    upper, lower = h - top, bot - low
    mid = (o + c) / 2
    white, black, traded = c > o, c < o, rng > 0

    # the typical body of the sessions BEFORE this one, so a candle is never measured against itself
    avg_body = pd.Series(body).rolling(BODY_WINDOW, min_periods=BODY_WINDOW // 2).mean().shift(1).to_numpy()
    avg_rng = pd.Series(rng).rolling(BODY_WINDOW, min_periods=BODY_WINDOW // 2).mean().to_numpy()
    with np.errstate(invalid="ignore"):
        doji = traded & (body <= DOJI_BODY * rng)
        long_ = (body >= LONG_BODY * avg_body) & (body >= LONG_SHARE * rng)
        small = body <= SMALL_BODY * avg_body
        avg10 = pd.Series(c).rolling(10, min_periods=10).mean().to_numpy()
        moved = c - _back(c, TREND_BARS)
        fell = (moved <= -TREND_MOVE * avg_rng) & (c < avg10)   # this bar ends a decline
        rose = (moved >= TREND_MOVE * avg_rng) & (c > avg10)    # this bar ends an advance
        fell1, rose1 = _back(fell, 1, False), _back(rose, 1, False)   # the trend going into a one-bar pattern

        umbrella = traded & ~doji & (lower >= SHADOW_MULT * body) & (upper <= SHORT_SHADOW * rng) & (body <= UMBRELLA_BODY * rng)
        inverted = traded & ~doji & (upper >= SHADOW_MULT * body) & (lower <= SHORT_SHADOW * rng) & (body <= UMBRELLA_BODY * rng)

        # two-bar patterns: bar 1 belongs to the trend, bar 2 turns against it
        o1, c1, top1, bot1, mid1, body1 = (_back(a, 1) for a in (o, c, top, bot, mid, body))
        white1, black1, long1 = _back(white, 1, False), _back(black, 1, False), _back(long_, 1, False)
        bull_engulf = black1 & white & (o <= c1) & (c >= o1) & (body > body1) & fell1
        bear_engulf = white1 & black & (o >= c1) & (c <= o1) & (body > body1) & rose1
        piercing = black1 & long1 & white & (o < c1) & (c > mid1) & (c < o1) & fell1
        dark_cloud = white1 & long1 & black & (o > c1) & (c < mid1) & (c > o1) & rose1
        inside = traded & long1 & (top <= top1) & (bot >= bot1) & (body <= 0.5 * body1)
        bull_harami, bear_harami = inside & black1 & fell1, inside & white1 & rose1

        # three-bar patterns: long candle with the trend, a small star beyond it, a candle back through the first
        c2, top2, bot2, mid2, body2 = (_back(a, 2) for a in (c, top, bot, mid, body))
        white2, black2, long2 = _back(white, 2, False), _back(black, 2, False), _back(long_, 2, False)
        star1 = _back(small | doji, 1, False) & _back(traded, 1, False)
        doji1 = _back(doji, 1, False)
        fell2, rose2 = _back(fell, 2, False), _back(rose, 2, False)
        morning = black2 & long2 & star1 & (top1 <= bot2 + STAR_OVERLAP * body2) & white & (c > mid2) & fell2
        evening = white2 & long2 & star1 & (bot1 >= top2 - STAR_OVERLAP * body2) & black & (c < mid2) & rose2

        strong = body >= LONG_BODY * avg_body
        up_bar = white & strong & (upper <= 0.25 * rng)
        dn_bar = black & strong & (lower <= 0.25 * rng)
        soldiers = (up_bar & _back(up_bar, 1, False) & _back(up_bar, 2, False) & (c > c1) & (c1 > c2)
                    & (o >= bot1) & (o <= top1) & (o1 >= bot2) & (o1 <= top2))
        crows = (dn_bar & _back(dn_bar, 1, False) & _back(dn_bar, 2, False) & (c < c1) & (c1 < c2)
                 & (o >= bot1) & (o <= top1) & (o1 >= bot2) & (o1 <= top2))

        traded1 = _back(traded, 1, False)
        rising = traded & traded1 & (low > _back(h, 1))
        falling = traded & traded1 & (h < _back(low, 1))

    flags = {
        "hammer": umbrella & fell1,
        "hanging_man": umbrella & rose1,
        "inverted_hammer": inverted & fell1,
        "shooting_star": inverted & rose1,
        "bullish_engulfing": bull_engulf,
        "bearish_engulfing": bear_engulf,
        "piercing": piercing,
        "dark_cloud_cover": dark_cloud,
        "bullish_harami": bull_harami & ~doji,
        "bullish_harami_cross": bull_harami & doji,
        "bearish_harami": bear_harami & ~doji,
        "bearish_harami_cross": bear_harami & doji,
        "morning_star": morning & ~doji1,
        "morning_doji_star": morning & doji1,
        "evening_star": evening & ~doji1,
        "evening_doji_star": evening & doji1,
        # a doji inside a long candle is reported as the harami cross it is, not twice
        "doji_after_decline": doji & fell1 & ~bull_harami,
        "doji_after_advance": doji & rose1 & ~bear_harami,
        "three_white_soldiers": soldiers,
        "three_black_crows": crows,
        "rising_window": rising,
        "falling_window": falling,
    }
    out = pd.DataFrame({k: np.asarray(v, dtype=bool) for k, v in flags.items()}, index=df.index)
    out["top"], out["bot"] = top, bot
    return out


def _level(code: str, i: int, h: np.ndarray, low: np.ndarray) -> float:
    """The price a pattern defends: its lowest low if bullish, its highest high if bearish.
    A window defends its far edge: the high before a gap up, the low before a gap down."""
    _, direction, _, bars, _ = PATTERNS[code]
    if code == "rising_window":
        return float(h[i - 1])
    if code == "falling_window":
        return float(low[i - 1])
    span = slice(i - bars + 1, i + 1)
    return float(low[span].min() if direction == "bullish" else h[span].max())


def _state(code: str, i: int, level: float, c: np.ndarray, top: np.ndarray, bot: np.ndarray) -> str:
    """What the sessions after the pattern did with it."""
    direction = PATTERNS[code][1]
    after = c[i + 1:i + 1 + FOLLOW_BARS]
    if not len(after):
        return "pending"
    if (after < level).any() if direction == "bullish" else (after > level).any():
        return "failed"
    if code in WINDOWS:
        return "open"
    held = after[0] > top[i] if direction == "bullish" else after[0] < bot[i]
    return "confirmed" if held else "unconfirmed"


def patterns(df: pd.DataFrame, last: int = 60) -> list[dict]:
    """The patterns completed in the latest `last` bars, oldest first, each with the level it defends
    and what followed it: pending (no later session yet), confirmed, unconfirmed, failed, or open (a window)."""
    if df is None or len(df) < 3:
        return []
    flags = detect(df)
    h, low, c, vol = (df[k].to_numpy(dtype=float) for k in ("high", "low", "close", "volume"))
    top, bot = flags["top"].to_numpy(), flags["bot"].to_numpy()
    avg_vol = pd.Series(vol).rolling(20, min_periods=5).mean().shift(1).to_numpy()
    start = max(0, len(df) - last)
    out = []
    for code, (label, direction, kind, bars, waits) in PATTERNS.items():
        for i in np.flatnonzero(flags[code].to_numpy()[start:]) + start:
            level = _level(code, i, h, low)
            ratio = vol[i] / avg_vol[i] if avg_vol[i] and avg_vol[i] == avg_vol[i] else None
            out.append({
                "date": df.index[i].strftime("%Y-%m-%d"), "pattern": code, "name": label, "direction": direction,
                "kind": kind, "bars": bars, "needs_confirmation": waits, "state": _state(code, i, level, c, top, bot),
                "level": level, "level_role": "support" if direction == "bullish" else "resistance",
                "close": float(c[i]), "volume_ratio": float(ratio) if ratio is not None else None,
            })
    out.sort(key=lambda p: (p["date"], p["pattern"]))
    return out


def reversal_signals(df: pd.DataFrame, confirm: bool = True) -> pd.DataFrame:
    """Entry and exit columns for the candle-reversal strategy, known at each bar's close.

    `bull` is a bullish reversal pattern (with `confirm`, one that the next close confirmed by ending
    above the pattern's last body). `bear` mirrors it. `stop` carries the low of the latest bullish
    pattern forward: a close under it says the pattern failed.
    """
    flags = detect(df)
    c, low = df["close"].to_numpy(dtype=float), df["low"].to_numpy(dtype=float)
    top, bot = flags["top"].to_numpy(), flags["bot"].to_numpy()
    bull = flags[list(BULLISH_REVERSALS)].any(axis=1).to_numpy()
    bear = flags[list(BEARISH_REVERSALS)].any(axis=1).to_numpy()

    lows = pd.DataFrame({code: np.where(flags[code].to_numpy(),
                                        pd.Series(low).rolling(PATTERNS[code][3]).min().to_numpy(), np.nan)
                         for code in BULLISH_REVERSALS})
    level = lows.min(axis=1).to_numpy()   # the pattern's low on the bar that completes it
    if confirm:
        with np.errstate(invalid="ignore"):
            bull = _back(bull, 1, False) & (c > _back(top, 1))
            bear = _back(bear, 1, False) & (c < _back(bot, 1))
        level = _back(level, 1)
    stop = pd.Series(np.where(bull, level, np.nan)).ffill().to_numpy()
    return pd.DataFrame({"bull": bull, "bear": bear, "stop": stop}, index=df.index)
