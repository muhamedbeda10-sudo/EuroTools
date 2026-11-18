"""The radar: the app watches the live prices for the assistant by itself, and says when something moves.

A watch (wakes.py) is something the assistant or the person asked for: one stock, one level. The radar is
what nobody asked for. At every look at the live prices (once a minute, from the open app or from the server's
own looks) it goes over every stock, in code and at no cost:

- the person's own stocks, closely: what the paper portfolio holds, the watchlist and, for the brokerage
  account's owner whose autopilot has the real account in it, the real holdings, what the automation holds
  and the stocks of the automatic box;
- every other listed stock, loosely, when the person switched that on: only what is large enough to be an
  opportunity or a warning for the whole market.

What it looks for: a sharp move on the day (said again each time the move grows by the same step), volume
far above the stock's usual, a break of the recent high (and, for the person's own stocks, of the recent low),
and a holding coming close to its stop-loss or take-profit. Each is said once in a session. A find joins the
queue the assistant's watches use (wakes.py); in the modes that wake it, it then starts a short review, after
a small, cheap model has sorted what is worth one (assistant.py).

What it is not. It judges live prices only: a price the feed did not send in this session is not "now", so
without a live feed (sample or imported data) it says nothing. It sees the market once a minute, not every
trade. It decides nothing and sends nothing: it only tells the assistant, whose own limits and the owner's
box are what they always were.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime

from . import broker, orders, real_auto, wakes
from .assistant_prefs import autopilot_account, prefs
from .data.calendar import cairo_now, market_open
from .domain.ledger import replay
from .services import App, now_iso
from .store.errors import ConflictError

STATE = ("settings", "radar_state")   # what was already said in this session, so nothing is said twice
LOG = "radar_events"                  # what it found and how each batch was sorted, newest last: for the person to read
HIGH_MINE, HIGH_MARKET = 20, 60       # sessions: the recent high (and low) a break is measured against
MARKET_RISE_ON_VOLUME = 2.0           # percent: unusual volume in a stock nobody follows is said only when it is rising
MARKET_BURST = 4                      # more finds than this in the rest of the market at one look are told as one
MINE_AT_ONCE = 8                      # the most finds about the person's own stocks told from one look
REAL_HOLDINGS_SECONDS = 600           # how often the real account's holdings are read again for the radar
SHOWN = 40
log = logging.getLogger("egx.radar")


def _number(value) -> float | None:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


# ---- whose stocks are watched closely ----------------------------------------------------
def _real_holdings(core: App, state: dict, read: bool = True) -> list[dict]:
    """The real account's holdings, read from the broker at most every few minutes and kept with the radar's
    own notes: a look every minute must not ask the broker every minute. With `read` false, only what is kept."""
    kept = state.get("real") or {}
    if not read:
        return kept.get("holdings") or []
    try:
        age = (datetime.fromisoformat(now_iso()) - datetime.fromisoformat(kept["at"])).total_seconds()
    except (KeyError, TypeError, ValueError):
        age = None
    if age is not None and 0 <= age < REAL_HOLDINGS_SECONDS:
        return kept.get("holdings") or []
    try:
        holdings = [{"symbol": h["symbol"], "qty": h["qty"], "avg": h["avg_cost"]}
                    for h in broker.view(core)["holdings"] if h.get("symbol") and h.get("qty")]
    except Exception as exc:  # noqa: BLE001 - the broker not answering never stops the radar: it keeps what it knew
        log.warning("radar: the real account could not be read (%s)", type(exc).__name__)
        return kept.get("holdings") or []
    state["real"] = {"at": now_iso(), "holdings": holdings}
    return holdings


def own_stocks(core: App, state: dict | None = None, read: bool = True) -> dict[str, dict]:
    """The stocks watched closely, each with why it is one and the levels a holding is protected by:
    {symbol: {"why": [...], "stops": [(whose, price)], "targets": [(whose, price)]}}. `read` false asks the
    broker nothing: the real holdings are the ones the radar last kept."""
    state = state if state is not None else {}
    account = autopilot_account(core)
    out: dict[str, dict] = {}

    def entry(symbol: str) -> dict:
        return out.setdefault(symbol, {"why": [], "stops": [], "targets": []})

    if account != "real":
        for pos in replay(core.store.list(core._ledger_coll())).positions.values():
            if pos.qty:
                entry(pos.symbol)["why"].append(f"the paper portfolio holds {pos.qty:,} at an average of {float(pos.avg_price):g}")
        for o in orders.list_orders(core):
            if o["symbol"] in out:
                entry(o["symbol"])["stops" if o["kind"] == "stop" else "targets"].append(("the paper portfolio's", float(o["price"])))
    if account != "paper" and broker.access(core)["allowed"]:
        for h in _real_holdings(core, state, read):
            avg = f" at an average of {h['avg']:g}" if _number(h.get("avg")) else ""
            entry(h["symbol"])["why"].append(f"the real account holds {h['qty']:,}{avg}")
        for symbol, pos in real_auto._book(core)["positions"].items():
            if not pos.get("qty"):
                continue
            e = entry(symbol)
            e["why"].append(f"the automation holds {pos['qty']:,} of them")
            for key, name in (("stop", "stops"), ("target", "targets")):
                if _number(pos.get(key)):
                    e[name].append(("the automation's", float(pos[key])))
        box = real_auto.chosen(core)
        if box["enabled"]:
            for symbol in box["symbols"]:
                entry(symbol)["why"].append("in the automatic box")
    for w in core.store.list("watchlist"):
        entry(w["symbol"])["why"].append("on the watchlist")
    return out


# ---- the recent highs and lows a break is measured against --------------------------------
def _levels(core: App) -> dict[str, dict]:
    """For each stock, the high and low of the completed sessions before this one. Worked out once per completed
    session and kept in memory: they do not change while a session runs."""
    settled = core.market.latest_settled()
    key = (settled.isoformat() if settled is not None else None, core.market.data_version)
    kept = core.cache.get("radar_levels")
    if kept and kept[0] == key:
        return kept[1]
    out = {}
    for ins in core.market.instruments():
        df = core.market.bars(ins["symbol"], settled=True)
        if df is None or len(df) < HIGH_MINE:
            continue
        near, far = df.tail(HIGH_MINE), df.tail(HIGH_MARKET)
        out[ins["symbol"]] = {"high": float(near["high"].max()), "low": float(near["low"].min()),
                              "far_high": float(far["high"].max()) if len(df) >= HIGH_MARKET else None}
    core.cache["radar_levels"] = (key, out)
    return out


# ---- one stock ------------------------------------------------------------------------------
def _judge(q: dict, mine: dict | None, levels: dict | None, radar: dict, seen: dict) -> tuple[list[str], dict]:
    """What is new about one stock at this look: the facts worth saying, and the notes to keep so that none is
    said twice in the session. A move is said again each time it grows by a whole step of its threshold."""
    symbol, last = q["symbol"], _number(q.get("last"))
    if last is None or last <= 0:
        return [], {}
    facts, notes = [], {}
    change = _number(q.get("change_pct"))
    step = radar["move_pct"] if mine else radar["market_move_pct"]
    if change is not None and abs(change) >= step:
        way, size = ("up" if change > 0 else "down"), int(abs(change) // step)
        if size > int(seen.get(f"{symbol}|{way}") or 0):
            facts.append(f"{way} {abs(change):.1f}% today")
            notes[f"{symbol}|{way}"] = size
    average, volume = _number(q.get("avg_volume_20")), _number(q.get("volume"))
    times = volume / average if average and volume is not None else None
    level = radar["volume_x"] if mine else radar["market_volume_x"]
    rising = change is not None and change >= MARKET_RISE_ON_VOLUME
    if times is not None and times >= level and (mine or rising) and not seen.get(f"{symbol}|volume"):
        facts.append(f"volume already {times:.1f} times its 20-session average")
        notes[f"{symbol}|volume"] = 1
    if levels:
        high = levels["high"] if mine else levels["far_high"]
        days = HIGH_MINE if mine else HIGH_MARKET
        if high and last > high and not seen.get(f"{symbol}|high"):
            facts.append(f"above its {days}-session high of {high:g}")
            notes[f"{symbol}|high"] = 1
        if mine and last < levels["low"] and not seen.get(f"{symbol}|low"):
            facts.append(f"below its {HIGH_MINE}-session low of {levels['low']:g}")
            notes[f"{symbol}|low"] = 1
    for whose, price in (mine or {}).get("stops", []):
        gap = (last / price - 1) * 100
        if 0 < gap <= radar["near_pct"] and not seen.get(f"{symbol}|stop|{price:g}"):
            facts.append(f"{gap:.1f}% above {whose} stop-loss at {price:g}")
            notes[f"{symbol}|stop|{price:g}"] = 1
    for whose, price in (mine or {}).get("targets", []):
        gap = (price / last - 1) * 100
        if 0 < gap <= radar["near_pct"] and not seen.get(f"{symbol}|target|{price:g}"):
            facts.append(f"{gap:.1f}% under {whose} take-profit at {price:g}")
            notes[f"{symbol}|target|{price:g}"] = 1
    return facts, notes


def _sentence(q: dict, mine: dict | None, facts: list[str]) -> str:
    """One find in words: the stock, why it is watched, where it is, and everything new about it."""
    who = f" ({'; '.join(mine['why'])})" if mine and mine["why"] else " (a stock you neither hold nor follow)"
    return f"{q['symbol']}{who} is at {float(q['last']):g}: {', '.join(facts)}"


# ---- one look ---------------------------------------------------------------------------------
def scan(core: App) -> dict:
    """One look by the radar at the live prices. Returns {"ran", "why", "events", "wake"}; never raises, because
    the look it is part of (the page's round, the server's minute) must go on whatever happens here."""
    try:
        return _scan(core)
    except ConflictError:
        return {"ran": False, "why": "another look was at it in the same moment", "events": 0, "wake": False}
    except Exception as exc:  # noqa: BLE001
        log.exception("radar: the look failed")
        return {"ran": False, "why": f"the radar's look failed ({type(exc).__name__})", "events": 0, "wake": False}


def _off(why: str) -> dict:
    return {"ran": False, "why": why, "events": 0, "wake": False}


def _scan(core: App) -> dict:
    chosen = prefs(core)
    radar = chosen["radar"]
    if not radar["on"]:
        return _off("the radar is switched off")
    if not wakes.listening(core):
        return _off("the assistant has no reviews of its own to tell")
    if not market_open(cairo_now()):
        return _off("the market is closed")
    table = core.quotes()
    rows = [] if table.empty else [r for r in table.to_dict("records") if r.get("type") == "stock" and r.get("live")]
    if not rows:
        return _off("no live prices")
    session = max(str(r["as_of"]) for r in rows)
    state = core.store.get(*STATE) or {}
    if state.get("session") != session:
        state = {"session": session, "seen": {}, "real": state.get("real")}
    seen = state["seen"]
    own = own_stocks(core, state)
    levels = _levels(core)
    mine, market, notes = [], [], {}
    for q in rows:
        symbol = q["symbol"]
        watched = own.get(symbol)
        if watched is None and not radar["market"]:
            continue
        facts, kept = _judge(q, watched, levels.get(symbol), radar, seen)
        if not facts:
            continue
        notes.update(kept)
        event = {"ts": now_iso(), "kind": "radar", "symbol": symbol, "scope": "mine" if watched else "market", "note": "",
                 "message": _sentence(q, watched, facts), "move": abs(_number(q.get("change_pct")) or 0.0)}
        (mine if watched else market).append(event)
    events = sorted(mine, key=lambda e: -e["move"])[:MINE_AT_ONCE]
    if len(market) > MARKET_BURST:
        # Many at once is one piece of news, not many: the market itself is moving.
        market.sort(key=lambda e: -e["move"])
        named = "; ".join(e["message"].replace(" (a stock you neither hold nor follow)", "") for e in market[:MARKET_BURST])
        events.append({"ts": now_iso(), "kind": "radar", "symbol": None, "scope": "market", "note": "",
                       "message": f"{len(market)} stocks you neither hold nor follow stood out in the same minute, so the market "
                                  f"itself may be moving. The largest: {named}"})
    else:
        events += market
    for e in events:
        e.pop("move", None)
    if not notes and state == (core.store.get(*STATE) or {}):
        return {"ran": True, "why": None, "events": 0, "wake": False}
    seen.update(notes)
    with core.store.transaction():
        core.store.put(*STATE, state)
        if events:
            wakes.add(core, events)   # with the notes themselves: a find is never queued twice, nor lost
            for e in events:
                core.store.append(LOG, {**e, "type": "find"})
    return {"ran": True, "why": None, "events": len(events), "wake": bool(events) and wakes.wakes_now(core)}


# ---- for the person, and for the assistant -------------------------------------------------
def note_sort(core: App, events: list[dict], woke: list[dict], why: str, model: str | None, cost: float | None) -> None:
    """Keep how a batch of finds was sorted, for the person to read. Never raises: it is a record, not a step."""
    try:
        core.store.append(LOG, {"ts": now_iso(), "type": "sort", "of": len(events), "woke": len(woke),
                                "symbols": [e.get("symbol") for e in woke if e.get("symbol")][:12],
                                "why": str(why or "")[:300], "model": model, "usd": round(cost, 6) if cost is not None else None})
    except Exception:  # noqa: BLE001
        log.exception("radar: the sort could not be written down")


def view(core: App) -> dict:
    """The radar for the settings page and for the assistant: what it is set to, whether it is looking, whose stocks
    it watches closely, and what it found lately with how each batch was sorted."""
    chosen = prefs(core)
    radar, mode = chosen["radar"], chosen["autopilot"]["mode"]
    if not radar["on"]:
        standing = "Off: nothing is watched for the assistant except the watches it or you set."
    elif mode == "off":
        standing = "It does nothing yet: the assistant has no schedule for its own reviews, so there is nobody to tell."
    elif mode in wakes.WOKEN:
        standing = ("During the session the app goes over the live prices once a minute and wakes the assistant for what stands out"
                    + (", after a small model has sorted what is worth it." if radar["triage"] else "."))
    else:
        standing = ("During the session the app goes over the live prices once a minute. With reviews after the close only, what "
                    "it finds is told to that review; choose a schedule that wakes the assistant to have it act at once.")
    try:
        own = sorted(own_stocks(core, core.store.get(*STATE) or {}, read=False))
    except Exception:  # noqa: BLE001 - the list is for reading: a holding that cannot be read must not hide the settings
        own = []
    return {"settings": radar, "mode": mode, "wakes": bool(radar["on"] and mode in wakes.WOKEN), "standing": standing,
            "own": own, "session": (core.store.get(*STATE) or {}).get("session"),
            "events": [{k: e.get(k) for k in ("ts", "type", "symbol", "scope", "message", "of", "woke", "symbols", "why", "usd")}
                       for e in core.store.recent(LOG, SHOWN)]}
