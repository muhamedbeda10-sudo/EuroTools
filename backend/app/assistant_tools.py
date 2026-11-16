"""What the in-app assistant can see and do.

Each tool is a thin, bounded wrapper over the same service methods the screens
use, so the assistant follows exactly the rules a person does: the same fee
schedule, the same ledger checks, the same paper-only limits. There is no tool
for sign-in accounts or passwords, which stay a manual, administrator-only task.

The real brokerage account, for its owner only: the assistant can read it, and it
can write a proposal for a real order. It has no tool that approves, sends or
cancels one, and none that changes the owner's limits. Sending takes the owner's
approval: of that order on the Real account page (`real_orders.approve`), or given
in advance for what fits the automatic box they set (`real_auto.tick`, asked for by
their open app or by the server's timer working with their key). Neither is
reachable from here, and a test keeps it so.

`kind` decides how a call is treated under each access level:
  read    - looks only
  write   - changes the user's own notes, lists, strategies, alerts, backtests
  confirm - moves paper money or deletes something: asks first when the user chose "ask me"
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import broker, orders, paper, real_auto, real_orders, wakes
from .assistant_prefs import check_trade, prefs
from .data.calendar import cairo_now, market_open
from .domain import indicators as ind
from .domain.fees import FeeItem, FeeSchedule
from .domain.ledger import replay
from .domain.strategies import STRATEGY_TYPES, RiskConfig, StrategyConfig
from .extras import ALERT_KINDS, AlertError, AlertIn, Extras, JournalIn, ResearchIn
from .services import App, NotFound, clean

MAX_RESULT_CHARS = 30_000
KNOWLEDGE_DIR = Path(__file__).resolve().parent / "knowledge"
KNOWLEDGE_PART = 24_000   # the most reference text one call returns, in characters
KNOWLEDGE_MATCHES = 8
CANDLE_PATTERNS_SHOWN = 12   # the latest patterns a stock report carries
PAGES = {
    "dashboard": "/", "market": "/market", "stock": "/stock", "watchlist": "/watchlist", "portfolio": "/portfolio",
    "account": "/account", "trades": "/trades", "strategies": "/strategies", "simulator": "/simulator", "research": "/research",
    "journal": "/journal", "alerts": "/alerts", "guide": "/guide", "settings": "/settings",
}


class Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoArgs(Args):
    pass


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[Args]
    run: Callable[[App, Any], Any]
    kind: Literal["read", "write", "confirm"] = "read"
    label: Callable[[Any], str] = lambda a: ""
    # The account whose money the tool moves, where it moves any: "paper" for a paper trade, a protective order or an
    # automatic run, "real" for a proposal of a real order. A review the autopilot makes for one account is refused
    # the other account's tools (assistant.py); in a conversation it changes nothing.
    account: Literal["paper", "real"] | None = None


def r4(value):
    """Numbers short enough to read: four decimals at most."""
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {k: r4(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [r4(v) for v in value]
    return value


def pick(row: dict, *keys: str) -> dict:
    return {k: row.get(k) for k in keys}


QUOTE = ("symbol", "name", "sector", "last", "change_pct", "week_pct", "month_pct", "volume", "avg_volume_20",
         "turnover", "as_of", "current", "live", "source")


# ---- market ------------------------------------------------------------------------------
def _market_overview(core: App, a: NoArgs) -> dict:
    ov = core.market_overview()
    status = core.market.status()
    return {
        "as_of": ov.get("as_of"), "market_open_now": market_open(), "cairo_time": cairo_now().strftime("%Y-%m-%d %H:%M"),
        "data": pick(status, "mode", "latest_bar_date", "is_live", "live_as_of", "trading_days_behind", "is_stale"),
        "indices": [pick(i, "name", "last", "change_pct", "as_of") for i in ov.get("indices", [])],
        "breadth": ov.get("breadth"),
        "gainers": ov.get("gainers", []), "losers": ov.get("losers", []), "most_active": ov.get("most_active", []),
        "sectors": [pick(s, "sector", "stocks", "traded", "day_pct", "week_pct", "month_pct", "relative_strength")
                    for s in core.sectors()],
    }


class FindStocks(Args):
    query: str | None = Field(default=None, max_length=60, description="Part of a symbol or company name")
    sector: str | None = Field(default=None, max_length=80)
    sort_by: Literal["symbol", "change_pct", "week_pct", "month_pct", "volume", "turnover", "last"] = "symbol"
    descending: bool = False
    traded_in_latest_session_only: bool = False
    watched_only: bool = False
    limit: int = Field(default=25, ge=1, le=60)


def _find_stocks(core: App, a: FindStocks) -> dict:
    rows = core.stock_rows(a.sector, a.query)
    if a.traded_in_latest_session_only:
        rows = [r for r in rows if r.get("current")]
    if a.watched_only:
        rows = [r for r in rows if r.get("watched")]
    missing = float("-inf") if a.descending else float("inf")
    rows.sort(key=lambda r: (r.get(a.sort_by) if r.get(a.sort_by) is not None else missing) if a.sort_by != "symbol"
              else r["symbol"], reverse=a.descending)
    return {"total_matching": len(rows), "stocks": [{**pick(r, *QUOTE), "watched": r.get("watched")} for r in rows[:a.limit]]}


class StockReport(Args):
    symbol: str = Field(min_length=1, max_length=12)
    timeframe: Literal["d", "w", "m"] = Field(default="d", description="Candle size: day, week or month")
    bars: int = Field(default=30, ge=0, le=120, description="How many of the latest candles to include")


def _stock_report(core: App, a: StockReport) -> dict:
    symbol = a.symbol.upper()
    d = core.stock_detail(symbol, a.timeframe, limit=max(a.bars, 1))
    out: dict = {"instrument": d["instrument"], "has_data": d["has_data"]}
    if not d["has_data"]:
        return out
    held = replay(core.store.list(core._ledger_coll())).positions.get(symbol)
    out.update(
        quote=d["quote"], data_note=d["data_note"], watched=d["watched"],
        assessment={k: v for k, v in d["assessment"].items()},
        candles={"columns": ["date", "open", "high", "low", "close", "volume", "rsi"],
                 "rows": [[b["time"], b["open"], b["high"], b["low"], b["close"], b["volume"], b["rsi"]]
                          for b in d["bars"][-a.bars:]] if a.bars else []},
        holding=({"qty": held.qty, "avg_price": float(held.avg_price), "cost": float(held.cost)}
                 if held is not None and held.qty else None),
        candle_patterns={"timeframe": a.timeframe, "latest": d["patterns"][-CANDLE_PATTERNS_SHOWN:],
                         "note": "Detected by the app from the candles of this timeframe. `level` is the price the "
                                 "pattern defends; `state` says what the following sessions did with it."},
        signals=[s for s in core.active_signals() if s["symbol"] == symbol],
        saved_research_items=len(Extras(core).research(symbol=symbol)),
        fundamentals="not available: no verified source of financial statements is connected",
    )
    return out


def market_metrics(core: App) -> list[dict]:
    """The technical read of every stock, computed once per data update and reused by every screen."""
    cache = core.market.cache
    core.quotes()
    if "screen" not in cache:
        rows = []
        table = core.quotes()
        for q in table[table["type"] == "stock"].to_dict("records") if len(table) else []:
            df = core.market.bars(q["symbol"])
            if df is None or len(df) < 30:
                continue
            a, last = ind.assess(df), q["last"]
            high = float(df["high"].tail(252).max())
            avg_volume = q.get("avg_volume_20")
            rows.append({
                **pick(q, "symbol", "name", "sector", "last", "change_pct", "week_pct", "month_pct", "as_of", "current"),
                "three_month_pct": a["returns_pct"]["3m"], "rsi": a["rsi"], "trend": a["trend"], "technical_score": a["technical_score"],
                "above_sma50": None if a["sma50"] is None else last > a["sma50"],
                "above_sma200": None if a["sma200"] is None else last > a["sma200"],
                "volume_ratio": a["volume_ratio"], "pct_from_high": (last / high - 1) * 100 if high else None,
                "avg_turnover_20": avg_volume * last if avg_volume == avg_volume and avg_volume is not None else None,
                "support": a["support"], "resistance": a["resistance"],
            })
        cache["screen"] = rows
    return cache["screen"]


class Screen(Args):
    sector: str | None = Field(default=None, max_length=80)
    trend: Literal["uptrend", "sideways", "downtrend"] | None = None
    rsi_min: float | None = Field(default=None, ge=0, le=100)
    rsi_max: float | None = Field(default=None, ge=0, le=100)
    above_sma50: bool | None = None
    above_sma200: bool | None = None
    min_volume_ratio: float | None = Field(default=None, ge=0, description="Latest volume against the average of the 20 sessions before")
    min_avg_turnover: float | None = Field(default=None, ge=0, description="Liquidity floor: average daily value traded, in EGP")
    min_month_pct: float | None = None
    max_month_pct: float | None = None
    within_pct_of_high: float | None = Field(default=None, ge=0, le=100, description="At most this far below the 12-month high")
    traded_in_latest_session_only: bool = True
    sort_by: Literal["rsi", "change_pct", "week_pct", "month_pct", "three_month_pct", "volume_ratio", "avg_turnover_20",
                     "pct_from_high", "technical_score"] = "month_pct"
    descending: bool = True
    limit: int = Field(default=20, ge=1, le=40)


def _screen(core: App, a: Screen) -> dict:
    def keep(r: dict) -> bool:
        def at_least(key, floor):
            return floor is None or (r[key] is not None and r[key] >= floor)

        def at_most(key, ceiling):
            return ceiling is None or (r[key] is not None and r[key] <= ceiling)
        return ((not a.sector or r["sector"] == a.sector) and (not a.trend or r["trend"] == a.trend)
                and (not a.traded_in_latest_session_only or r["current"])
                and at_least("rsi", a.rsi_min) and at_most("rsi", a.rsi_max)
                and (a.above_sma50 is None or r["above_sma50"] is a.above_sma50)
                and (a.above_sma200 is None or r["above_sma200"] is a.above_sma200)
                and at_least("volume_ratio", a.min_volume_ratio) and at_least("avg_turnover_20", a.min_avg_turnover)
                and at_least("month_pct", a.min_month_pct) and at_most("month_pct", a.max_month_pct)
                and (a.within_pct_of_high is None or (r["pct_from_high"] is not None and r["pct_from_high"] >= -a.within_pct_of_high)))
    rows = [r for r in market_metrics(core) if keep(r)]
    edge = float("-inf") if a.descending else float("inf")
    rows.sort(key=lambda r: r[a.sort_by] if r[a.sort_by] is not None else edge, reverse=a.descending)
    return {"screened": len(market_metrics(core)), "matching": len(rows), "stocks": rows[:a.limit],
            "note": "Technical figures only, from price history. There are no fundamentals in the app."}


class Size(Args):
    symbol: str = Field(min_length=1, max_length=12)
    stop_price: float | None = Field(default=None, gt=0, description="Where the stop-loss would sit")
    stop_pct: float | None = Field(default=None, gt=0, lt=90, description="Or the stop as a percentage below the latest price")
    risk_pct: float = Field(default=1.0, gt=0, le=10, description="Share of the portfolio you accept to lose if the stop is hit")


def _size(core: App, a: Size) -> dict:
    symbol = a.symbol.upper()
    quote = core.preview_trade("BUY", symbol, 1, None)
    last = quote["price"]
    if a.stop_price is None and a.stop_pct is None:
        raise ValueError("give stop_price or stop_pct")
    stop = a.stop_price if a.stop_price is not None else last * (1 - a.stop_pct / 100)
    if stop >= last:
        raise ValueError(f"the stop ({stop:g}) must be below the latest price ({last:g})")
    summary = core.portfolio()["summary"]
    equity, cash = summary["total_value"], summary["cash"]
    held = replay(core.store.list(core._ledger_coll())).positions.get(symbol)
    held_qty = held.qty if held is not None else 0
    limits = prefs(core)["limits"]
    with_fees = last * 1.006  # room for fees when turning cash into shares
    caps = {
        "the risk accepted": int(equity * a.risk_pct / 100 // (last - stop)),
        "the per-trade limit": int(equity * limits["max_trade_pct"] / 100 // with_fees),
        "the per-stock limit": int(equity * limits["max_position_pct"] / 100 // last) - held_qty,
        "the cash that must stay": int((cash - equity * limits["min_cash_pct"] / 100) // with_fees),
    }
    binding = min(caps, key=caps.get)
    shares = max(caps[binding], 0)
    out = {"symbol": symbol, "price": last, "stop": round(stop, 4), "risk_per_share": round(last - stop, 4), "shares": shares,
           "limited_by": binding, "already_held": held_qty, "portfolio_value": equity, "cash": cash, "limits": limits}
    if shares:
        cost = core.preview_trade("BUY", symbol, shares, None)
        out.update(cost_with_fees=cost["gross"] + cost["fees_total"], loss_if_stopped=round(shares * (last - stop), 2),
                   loss_pct_of_portfolio=round(shares * (last - stop) / equity * 100, 3) if equity else None)
    return out


class CandleScan(Args):
    direction: Literal["bullish", "bearish"] | None = Field(default=None, description="Leave out for both")
    sessions: int = Field(default=1, ge=1, le=10, description="How many of the latest completed sessions to cover")
    sector: str | None = Field(default=None, max_length=80)
    watched_only: bool = False
    reversals_only: bool = Field(default=False, description="Leave out windows (gaps), which are continuation signals")
    limit: int = Field(default=40, ge=1, le=80)


def _candle_scan(core: App, a: CandleScan) -> dict:
    found = core.candle_scan(a.direction, a.sessions, a.sector, a.watched_only, a.reversals_only)
    keep = ("symbol", "company", "sector", "date", "pattern", "name", "direction", "kind", "state", "needs_confirmation",
            "level", "level_role", "close", "volume_ratio")
    return {"as_of": found["as_of"], "sessions": a.sessions, "stocks_read": found["stocks_read"],
            "total_matching": len(found["matches"]), "matches": [pick(m, *keep) for m in found["matches"][:a.limit]]}


class SymbolArg(Args):
    symbol: str = Field(min_length=1, max_length=12)


def _price_depth(core: App, a: SymbolArg) -> dict:
    book = core.depth(a.symbol)
    return {**{k: v for k, v in book.items() if k not in ("bids", "asks", "unread")},
            "bids": book["bids"][:10], "asks": book["asks"][:10]}


# ---- portfolio and trades ---------------------------------------------------------------
def _portfolio(core: App, a: NoArgs) -> dict:
    p = core.portfolio()
    return {"mode": "paper", "summary": p["summary"], "holdings": p["holdings"], "sector_allocation": p["sector_allocation"],
            "cash_weight_pct": p["cash_weight_pct"], "warnings": p["warnings"],
            "value_history_recent": p["history"]["curve"][-20:]}


REAL_HOLDING = ("symbol", "name", "sector", "in_app", "qty", "available", "unsettled", "frozen", "avg_cost", "cost",
                "price", "value", "weight_pct", "unrealized", "unrealized_pct", "app_price", "app_price_as_of",
                "price_gap_pct", "suspended")


def _real_account(core: App, a: NoArgs) -> dict:
    if not broker.access(core)["allowed"]:
        return {"available": False,
                "reason": "The real brokerage account is not connected, or it is not enabled for this sign-in: only its "
                          "owner can see it. Everything else in the app is the paper portfolio."}
    v = broker.view(core)
    return {"available": True, "account": "REAL brokerage account (EFG Hermes), not the paper portfolio",
            "read_only": "You can look only. Nothing in this app can buy or sell in this account, and paper trades never change it.",
            "as_of_cairo": v["as_of"], "market_open_now": v["market_open"], "currency": v["currency"],
            "summary": v["summary"], "holdings": [pick(h, *REAL_HOLDING) for h in v["holdings"]],
            "checks": v["checks"], "notes": v["notes"],
            "fields": "avg_cost, cost, price, value and unrealized are the broker's figures; app_price is the app's own latest "
                      "price for the same stock; available = shares free to sell now; unsettled = bought but not settled yet."}


NOT_SENT = ("This is a proposal, not an order. Nothing was sent to the broker. It waits on the Real account page, where only "
            "the owner can approve it; you cannot approve, send or cancel it. That is settled for this proposal: it will not "
            "be sent by itself later, whatever changes.")
WILL_BE_SENT = ("AUTOMATIC: this proposal fits the box the owner set for automatic orders. Nothing has been sent yet, but it "
                "WILL be sent to the broker with REAL money, without the owner looking at it first, at the next look during "
                "the session: within a minute or two, from their open app or, if they switched that on, from the server's own "
                "looks with the app closed. It is checked once more at that moment. Say exactly this to the user. If you no "
                "longer stand behind it, withdraw it now.")
REAL_ORDER = ("id", "created_at", "session", "origin", "symbol", "side", "qty", "price", "value", "stop", "target", "reason",
              "status", "status_note", "approved_by", "hold", "auto", "broker")


def _real_orders(core: App, a: NoArgs) -> dict:
    if not broker.access(core)["allowed"]:
        return {"available": False, "reason": "Real orders exist only for the owner of the brokerage account, on their own sign-in."}
    v = real_orders.view(core)
    return {"available": True, "can_propose_now": v["ready"], "why_not": v["why_not"], "market_open_now": v["market_open"],
            "next_session": v["session"], "limits_set_by_the_owner": v["limits"], "sent_today": v["today"],
            "waiting_for_the_owner": [pick(o, *REAL_ORDER) for o in v["waiting"]],
            "earlier": [pick(o, *REAL_ORDER) for o in v["orders"][:20]], "note": v["sync_problem"],
            "your_proposals_today": real_orders.assistant_quota(core),
            "automatic_orders": real_auto.brief(core),
            "rules": "Limit orders for one day only. You can propose; you cannot approve, send or cancel. A proposal is sent "
                     "either when the owner approves it on the Real account page, or by itself when automatic_orders.on is "
                     "true and it fits automatic_orders.box (an allowed stock, within the limit per order, what is free "
                     "of the budget and, when the owner set one, the most it may buy in one day (max_day_value); a buy "
                     "carrying a stop-loss no further under its price than max_stop_pct; a sale only "
                     "of shares listed in automatic_orders.positions). approved_by says which: owner or auto. "
                     "your_proposals_today is how many proposals the owner lets you write in a day (allowed 0: none at "
                     "all) and how many are left. "
                     "broker.status is the broker's own word for a sent order; broker.state is how the app reads it."}


class ProposeRealOrder(Args):
    symbol: str = Field(min_length=1, max_length=12)
    side: Literal["BUY", "SELL"]
    qty: int = Field(gt=0, le=100_000_000, description="Whole shares")
    limit_price: Decimal = Field(gt=0, le=Decimal("10000000"), description="The limit price in EGP, at most three decimals")
    reason: str = Field(min_length=15, max_length=600, description="Why, in a sentence or two the owner will read before deciding: "
                        "what you saw, and what would make it wrong")
    stop_price: Decimal | None = Field(default=None, gt=0, le=Decimal("10000000"), description="For a buy: the stop-loss "
                                       "price, under the limit price. Required for a buy to be sent automatically; the app "
                                       "watches the position by it while the owner's app is open")
    target_price: Decimal | None = Field(default=None, gt=0, le=Decimal("10000000"), description="For a buy, optional: the "
                                         "take-profit price, above the limit price")
    hold_for_owner: bool = Field(default=False, description="True when the user asked to see or approve it themselves: it "
                                 "then waits for them even if the automatic box would allow it")


def _propose_real_order(core: App, a: ProposeRealOrder) -> dict:
    made = real_orders.propose(core, real_orders.OrderIn(symbol=a.symbol, side=a.side, qty=a.qty, price=a.limit_price,
                                                         reason=a.reason, stop_price=a.stop_price, target_price=a.target_price),
                               "assistant", hold=a.hold_for_owner)
    outlook = real_auto.admit(core, made["id"])   # decided once, here: sent by itself, or waiting for the owner for good
    out = {"proposal": pick(made, *REAL_ORDER), "checked": made["checked"],
           "what_happens_next": WILL_BE_SENT if outlook["will_be_sent_automatically"] else NOT_SENT}
    if not outlook["will_be_sent_automatically"]:
        out["why_it_is_not_sent_automatically"] = outlook["why_not"]
    return out


class WithdrawRealOrder(Args):
    id: str = Field(min_length=1, max_length=40, description="The id of a waiting proposal that you wrote")


def _withdraw_real_order(core: App, a: WithdrawRealOrder) -> dict:
    return {"withdrawn": pick(real_orders.withdraw(core, a.id), *REAL_ORDER)}


class Trades(Args):
    symbol: str | None = Field(default=None, max_length=12)
    limit: int = Field(default=20, ge=1, le=60)


def _trades(core: App, a: Trades) -> dict:
    t = core.trades()
    rows = [r for r in t["transactions"] if not a.symbol or r.get("symbol") == a.symbol.upper()]
    keys = ("seq", "trade_date", "type", "symbol", "qty", "price", "gross", "fees_total", "cash_delta", "cash_after",
            "avg_cost", "realized_gross", "realized_net", "remaining_qty", "origin", "note", "backdated",
            "last", "last_as_of", "since_pct")
    return {"totals": t["totals"], "matching": len(rows), "transactions": [pick(r, *keys) for r in rows[:a.limit]]}


class TradeArgs(Args):
    side: Literal["BUY", "SELL"]
    symbol: str = Field(min_length=1, max_length=12)
    qty: int = Field(gt=0, le=100_000_000, description="Whole shares")


class PlaceTrade(TradeArgs):
    note: str = Field(default="", max_length=1000, description="Why this trade (kept with it in the ledger)")


def _preview_trade(core: App, a: TradeArgs) -> dict:
    return core.preview_trade(a.side, a.symbol, a.qty, None)


def _place_trade(core: App, a: PlaceTrade) -> dict:
    check_trade(core, a.side, a.symbol, a.qty)  # the user's limits on the assistant's trading, enforced here in code
    tx = core.post_trade(a.side, a.symbol, a.qty, None, a.note, None, origin="assistant")
    cash = replay(core.store.list(core._ledger_coll())).cash
    recorded = pick(tx, "seq", "type", "symbol", "qty", "trade_date", "price_date")
    recorded.update({k: float(tx[k]) for k in ("price", "gross", "fees_total")})  # numbers, not the ledger's text form
    return {"recorded": recorded, "cash_after": float(cash), "mode": "paper"}


class OrdersList(Args):
    include_closed: bool = Field(default=False, description="Also the filled and cancelled ones")


def _orders(core: App, a: OrdersList) -> dict:
    rows = orders.list_orders(core, None if a.include_closed else "open")
    held = {s: p.qty for s, p in replay(core.store.list(core._ledger_coll())).positions.items() if p.qty}
    stops = {o["symbol"] for o in rows if o["status"] == "open" and o["kind"] == "stop"}
    return {"orders": [orders.view(core, o) for o in rows[:40]], "holdings_without_a_stop": sorted(set(held) - stops)}


class SetOrder(Args):
    symbol: str = Field(min_length=1, max_length=12)
    kind: Literal["stop", "target"] = Field(description="stop = sell if the price falls to it; target = sell if it rises to it")
    price: float = Field(gt=0)
    qty: int | None = Field(default=None, gt=0, description="Leave out to cover the whole holding")
    note: str = Field(default="", max_length=300)


def _set_order(core: App, a: SetOrder) -> dict:
    body = orders.OrderIn(symbol=a.symbol, kind=a.kind, price=Decimal(str(a.price)), qty=a.qty, note=a.note)
    return orders.view(core, orders.place(core, body, origin="assistant"))


class CancelOrder(Args):
    id: str = Field(min_length=1, max_length=40)


def _cancel_order(core: App, a: CancelOrder) -> dict:
    return pick(orders.cancel(core, a.id), "id", "symbol", "kind", "status")


def _reset_portfolio(core: App, a: NoArgs) -> dict:
    return {"new_portfolio": core.reset_portfolio(), "note": "The previous ledger is kept; a fresh paper portfolio is now active."}


# ---- watchlist and lists ----------------------------------------------------------------
class SetWatch(Args):
    symbol: str = Field(min_length=1, max_length=12)
    watched: bool


def _watchlist(core: App, a: NoArgs) -> dict:
    return {"stocks": [pick(r, *QUOTE) for r in core.watchlist()],
            "custom_lists": core.store.list("categories")}


def _set_watch(core: App, a: SetWatch) -> dict:
    core.set_watch(a.symbol, a.watched)
    return {"symbol": a.symbol.upper(), "watched": a.watched}


class SaveList(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it to change an existing list")
    name: str = Field(min_length=1, max_length=60)
    symbols: list[str] = Field(max_length=300)


def _save_list(core: App, a: SaveList) -> dict:
    return core.save_category(a.name, a.symbols, a.id)


# ---- strategies, backtests, automatic runs ----------------------------------------------
def _strategies(core: App, a: NoArgs) -> dict:
    return {"strategies": core.store.list("strategies"),
            "types": {k: pick(v, "label", "description", "available", "params", "unavailable_reason")
                      for k, v in STRATEGY_TYPES.items()},
            "risk_defaults": RiskConfig().model_dump()}


class SaveStrategy(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it to change an existing strategy")
    name: str = Field(min_length=1, max_length=80)
    type: str = Field(description="One of the available strategy types")
    description: str = Field(default="", max_length=500)
    params: dict[str, float] = Field(default_factory=dict, description="Type parameters; omitted ones take their defaults")
    symbols: list[str] = Field(default_factory=list, max_length=300, description="Empty with no sectors means every stock")
    sectors: list[str] = Field(default_factory=list, max_length=50)
    stop_loss_pct: float | None = Field(default=8, description="null for no stop")
    take_profit_pct: float | None = None
    max_alloc_pct: float = 20
    max_open_positions: int = 5
    cash_reserve_pct: float = 10
    slippage_bps: float = 10


def _save_strategy(core: App, a: SaveStrategy) -> dict:
    cfg = StrategyConfig(name=a.name, type=a.type, description=a.description, params=a.params, symbols=a.symbols,
                         sectors=a.sectors, risk=RiskConfig(
                             stop_loss_pct=a.stop_loss_pct, take_profit_pct=a.take_profit_pct, max_alloc_pct=a.max_alloc_pct,
                             max_open_positions=a.max_open_positions, cash_reserve_pct=a.cash_reserve_pct,
                             slippage_bps=a.slippage_bps))
    return core.save_strategy(cfg, a.id)


class RunBacktest(Args):
    strategy_id: str = Field(min_length=1, max_length=40)
    symbols: list[str] | None = Field(default=None, max_length=300, description="Override the strategy's own stocks")
    start: date | None = None
    end: date | None = None
    capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))


def _backtest_summary(doc: dict, trades: int = 10) -> dict:
    return {"id": doc["id"], "strategy": doc["strategy"]["name"], "period": doc["period"], "stocks": len(doc["symbols"]),
            "metrics": doc["metrics"], "warnings": doc["warnings"], "data_sources": doc.get("data_sources"),
            "buy_and_hold_return_pct": (doc.get("buy_and_hold") or {}).get("return_pct"),
            "benchmark_return_pct": (doc.get("benchmark") or {}).get("return_pct"),
            "open_positions": doc["open_positions"][:20],
            "latest_trades": doc["trades"][-trades:], "trades_total": doc.get("trades_total", len(doc["trades"]))}


def _strategy_config(core: App, strategy_id: str) -> StrategyConfig:
    doc = core.store.get("strategies", strategy_id)
    if doc is None:
        raise NotFound("strategy not found")
    return StrategyConfig.model_validate({k: doc[k] for k in StrategyConfig.model_fields})


def _run_backtest(core: App, a: RunBacktest) -> dict:
    doc = core.backtest(_strategy_config(core, a.strategy_id), strategy_id=a.strategy_id, symbols=a.symbols,
                        start=a.start.isoformat() if a.start else None, end=a.end.isoformat() if a.end else None,
                        capital=a.capital)
    return _backtest_summary(doc)


class Compare(Args):
    strategy_ids: list[str] = Field(min_length=2, max_length=4)
    symbols: list[str] | None = Field(default=None, max_length=300)
    start: date | None = None
    end: date | None = None
    capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))


def _compare(core: App, a: Compare) -> dict:
    out = core.compare(a.strategy_ids, symbols=a.symbols, start=a.start.isoformat() if a.start else None,
                       end=a.end.isoformat() if a.end else None, capital=a.capital)
    return {"same": out["same"], "runs": [pick(r, "id", "name", "period", "stocks", "metrics", "warnings") for r in out["runs"]]}


class Backtests(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it for one run's details; leave out for the history")
    limit: int = Field(default=10, ge=1, le=30)


def _backtests(core: App, a: Backtests) -> dict:
    if a.id:
        doc = core.store.get("backtests", a.id)
        if doc is None:
            raise NotFound("backtest not found")
        return _backtest_summary(doc, trades=25)
    return {"runs": core.backtests()[:a.limit]}


def _signals(core: App, a: NoArgs) -> dict:
    return {"signals": core.active_signals(),
            "note": "Signals of the latest completed session, for the saved strategies. Informational only."}


def _paper_runs(core: App, a: NoArgs) -> dict:
    return {"runs": paper.runs_view(core)}


class StartRun(Args):
    strategy_id: str = Field(min_length=1, max_length=40)
    capital: Decimal = Field(gt=0, le=Decimal("1000000000"), description="Paper cash set aside for the run, in EGP")
    symbols: list[str] | None = Field(default=None, max_length=400)


def _start_run(core: App, a: StartRun) -> dict:
    run = paper.start_run(core, a.strategy_id, a.capital, a.symbols)
    return pick(run, "id", "name", "capital", "status", "last_date") | {"stocks": len(run["universe"])}


class RunStatus(Args):
    id: str = Field(min_length=1, max_length=40)
    status: Literal["active", "paused", "stopped"] = Field(description="'stopped' is final")


def _run_status(core: App, a: RunStatus) -> dict:
    return pick(paper.set_status(core, a.id, a.status), "id", "name", "status", "last_date")


# ---- alerts, research, journal -----------------------------------------------------------
def _alerts(core: App, a: NoArgs) -> dict:
    out = Extras(core).alerts()
    return {"alerts": out["alerts"], "recent_events": out["events"][:15], "kinds": ALERT_KINDS}


class SaveAlert(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it to change an existing alert")
    kind: Literal["price_above", "price_below", "change_pct_above", "change_pct_below", "volume_ratio_above",
                  "rsi_above", "rsi_below", "strategy_signal", "time_at"]
    symbol: str | None = Field(default=None, max_length=12, description="The stock; optional for time_at and strategy_signal")
    value: float | None = Field(default=None, description="The level: a price in EGP, a percent, a volume ratio or an RSI value")
    strategy_id: str | None = Field(default=None, max_length=40)
    at: str | None = Field(default=None, max_length=32, description="For time_at: HH:MM Cairo time (today if still ahead, else the "
                           "next trading day), or YYYY-MM-DD HH:MM")
    note: str = Field(default="", max_length=300, description="With wake_me: what to check when it fires. You will read it then.")
    active: bool = Field(default=True, description="False switches it off")
    wake_me: bool = Field(default=False, description="True: when it fires the app also wakes you (a watch), not only tells the user")


WHEN_IT_FIRES = {
    "events": "The app tells the user and, during the session, wakes you with a short review of this event alone, usually within "
              "a minute or two (from their open app, or from the server itself with the app closed, if they set that up).",
    "intraday": "The app tells the user and, during the session, wakes you with a short review of this event alone, usually within "
                "a minute or two (from their open app, or from the server itself with the app closed, if they set that up).",
    "after_close": "The app tells the user. Their autopilot reviews after the close only, so you are told of it at that review, not "
                   "at the moment. They can choose 'when a watch fires' in Settings → Assistant to have you woken at once.",
    "off": "The app tells the user. Their autopilot is off, so nothing wakes you: say so, and that Settings → Assistant → Autopilot "
           "→ 'when a watch fires' makes the app wake you.",
}


def _save_alert(core: App, a: SaveAlert) -> dict:
    extras = Extras(core)
    body = AlertIn(**a.model_dump(exclude={"id", "wake_me"}), wake=a.wake_me)
    if a.wake_me and a.active:
        if len(a.note.strip()) < 10:
            raise AlertError("Say in the note what to check when it fires: you will read it when the app wakes you.")
        mine = [x for x in extras.alerts()["alerts"] if x.get("wake") and x["active"] and x.get("by") == "assistant" and x["id"] != a.id]
        if len(mine) >= wakes.MAX_WATCHES:
            raise AlertError(f"{wakes.MAX_WATCHES} watches of yours are already on. Switch off the ones that no longer matter first.")
        true_now = extras.holds_now(body)
        if true_now:
            raise AlertError(f"That is already the case ({true_now}), so a watch on it would fire at once. Act on it now, or "
                             "watch for something that has not happened yet.")
    saved = extras.save_alert(body, a.id, by="assistant" if a.wake_me else None)
    if a.wake_me and a.active:
        saved = {**saved, "what_happens_when_it_fires": WHEN_IT_FIRES[prefs(core)["autopilot"]["mode"]] + " It fires once and is "
                 f"then off, and lapses by itself after {wakes.WATCH_DAYS} days."}
    return saved


class Research(Args):
    symbol: str | None = Field(default=None, max_length=12)
    query: str | None = Field(default=None, max_length=80)
    category: str | None = Field(default=None, max_length=40)
    limit: int = Field(default=15, ge=1, le=40)


def _research(core: App, a: Research) -> dict:
    items = Extras(core).research(symbol=a.symbol, q=a.query, category=a.category)
    return {"matching": len(items), "items": items[:a.limit]}


class SaveResearch(Args):
    id: str | None = Field(default=None, max_length=40)
    title: str = Field(min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="", max_length=120)
    published: date | None = None
    symbols: list[str] = Field(default_factory=list, max_length=50)
    sectors: list[str] = Field(default_factory=list, max_length=20)
    category: Literal["news", "disclosure", "announcement", "financials", "broker_report", "presentation",
                      "economic", "other"] = "news"
    summary: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=4000)
    sentiment: Literal["positive", "negative", "neutral"] = "neutral"
    importance: int = Field(default=2, ge=1, le=3)


def _save_research(core: App, a: SaveResearch) -> dict:
    return Extras(core).save_research(ResearchIn(**a.model_dump(exclude={"id"})), a.id)


class Journal(Args):
    symbol: str | None = Field(default=None, max_length=12)
    status: Literal["open", "closed"] | None = None
    limit: int = Field(default=15, ge=1, le=40)


def _journal(core: App, a: Journal) -> dict:
    items = Extras(core).journal(symbol=a.symbol, status=a.status)
    return {"matching": len(items), "entries": items[:a.limit]}


class SaveJournal(Args):
    id: str | None = Field(default=None, max_length=40)
    symbol: str | None = Field(default=None, max_length=12)
    strategy_id: str | None = Field(default=None, max_length=40)
    trade_seq: int | None = Field(default=None, ge=1, description="Ledger number of the trade this entry is about")
    entry_date: date | None = None
    thesis: str = Field(min_length=1, max_length=4000, description="Why this stock or trade")
    expected: str = Field(default="", max_length=2000)
    evidence: str = Field(default="", max_length=4000)
    exit_condition: str = Field(default="", max_length=2000)
    outcome: str = Field(default="", max_length=4000)
    lesson: str = Field(default="", max_length=4000)
    status: Literal["open", "closed"] = "open"


def _save_journal(core: App, a: SaveJournal) -> dict:
    return Extras(core).save_journal(JournalIn(**a.model_dump(exclude={"id"})), a.id)


class Delete(Args):
    kind: Literal["strategy", "alert", "research", "journal", "list"]
    id: str = Field(min_length=1, max_length=40)


def _delete(core: App, a: Delete) -> dict:
    extras = Extras(core)
    if a.kind == "strategy":
        core.delete_strategy(a.id)
    elif a.kind == "alert":
        extras.delete_alert(a.id)
    elif a.kind == "research":
        extras.delete_research(a.id)
    elif a.kind == "journal":
        extras.delete_journal(a.id)
    else:
        if not core.store.delete("categories", a.id):
            raise NotFound("list not found")
        core.audit("delete", "category", {"id": a.id})
    return {"deleted": a.kind, "id": a.id}


# ---- settings, records, knowledge, navigation ---------------------------------------------
def _settings(core: App, a: NoArgs) -> dict:
    from . import self_trading  # imported here because that module imports the assistant, which imports this one

    own = prefs(core)
    auto = own["autopilot"]
    return {"settings": core.app_settings(), "fee_schedule": core.fee_schedule().model_dump(mode="json"),
            "market_data": core.provider_status(), "data_quality": core.market.status(),
            "trading": "paper only: this application cannot send an order to a broker",
            # What the person saved in Settings → Assistant (they change it there, you cannot), and what is and is not
            # in place for you to trade by yourself: the same checklist that page shows them.
            "assistant": {"access": own["access"], "language": own["language"], "limits": own["limits"],
                          "daily_usd": own["daily_usd"], "monthly_usd": own["monthly_usd"],
                          "real_proposals_per_day": own["real_proposals_per_day"],
                          "autopilot": {k: auto[k] for k in ("mode", "account", "every_minutes", "max_per_day", "notify", "last_run")},
                          "trading_by_itself": self_trading.report(core)}}


class UpdateSettings(Args):
    starting_capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"),
                                             description="Used by the next portfolio reset and as the backtest default")
    benchmark: str | None = Field(default=None, max_length=12)


def _update_settings(core: App, a: UpdateSettings) -> dict:
    return core.update_app_settings(starting_capital=a.starting_capital, benchmark=a.benchmark)


class FeeLine(Args):
    code: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    rate_pct: Decimal = Field(default=Decimal("0"), ge=0, le=10, description="Percent of the trade's gross value")
    fixed: Decimal = Field(default=Decimal("0"), ge=0)
    minimum: Decimal = Field(default=Decimal("0"), ge=0)
    maximum: Decimal | None = Field(default=None, ge=0)
    applies_to: Literal["buy", "sell", "both"] = "both"
    enabled: bool = True


class UpdateFees(Args):
    items: list[FeeLine] = Field(min_length=1, max_length=20, description="The complete schedule: it replaces the current one")
    verified: bool = Field(default=False, description="True only if the user says they checked it against the broker's tariff")
    note: str = Field(default="", max_length=500)


def _update_fees(core: App, a: UpdateFees) -> dict:
    schedule = FeeSchedule(items=[FeeItem(**i.model_dump()) for i in a.items], verified=a.verified, note=a.note)
    return core.update_fee_schedule(schedule).model_dump(mode="json")


class Audit(Args):
    limit: int = Field(default=20, ge=1, le=60)


def _audit(core: App, a: Audit) -> dict:
    return {"entries": core.store.recent("audit", a.limit)}


# ---- the reference library ----------------------------------------------------------------
@dataclass(frozen=True)
class Reference:
    """One Markdown file of the library, cut into the sections the assistant reads."""
    name: str
    title: str
    about: str
    sections: tuple[tuple[str, str], ...]  # (heading, text) in the file's order

    @property
    def size(self) -> int:
        return sum(len(text) for _, text in self.sections)


def _cut(heading: str, text: str) -> list[tuple[str, str]]:
    """A section that fits in one call stays whole; a longer one is cut at blank lines."""
    if len(text) <= KNOWLEDGE_PART:
        return [(heading, text)]
    pieces: list[str] = []
    current = ""
    for block in re.split(r"\n[ \t]*\n", text):
        while len(block) > KNOWLEDGE_PART:  # a single block longer than one call: cut where it falls
            if current:
                pieces.append(current)
                current = ""
            pieces.append(block[:KNOWLEDGE_PART])
            block = block[KNOWLEDGE_PART:]
        if current and len(current) + 2 + len(block) > KNOWLEDGE_PART:
            pieces.append(current)
            current = ""
        current = f"{current}\n\n{block}" if current else block
    if current:
        pieces.append(current)
    return [(heading if n == 0 else f"{heading} (continued {n + 1})", piece) for n, piece in enumerate(pieces)]


@lru_cache(maxsize=1)
def library() -> tuple[Reference, ...]:
    """The references shipped with the app, read once per server instance.

    One Markdown file each: the title on the first line, one line saying what it covers on
    the second, then the text. `## ` headings divide it into sections; text before the first
    heading is the section "Overview".
    """
    out = []
    for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
        lines = path.read_text(encoding="utf-8").strip().splitlines()
        filled = [i for i, ln in enumerate(lines) if ln.strip()]
        title = lines[filled[0]].strip().lstrip("# ").strip() if filled else path.stem
        described = len(filled) > 1 and not lines[filled[1]].lstrip().startswith("#")
        about = lines[filled[1]].strip()[:240] if described else ""
        body = "\n".join(lines[filled[1 if described else 0] + 1:]) if filled else ""
        sections: list[tuple[str, str]] = []
        for part in re.split(r"(?m)^(?=## )", body):
            part = part.strip()
            if part:
                heading = part.splitlines()[0].lstrip("# ").strip() if part.startswith("## ") else "Overview"
                sections += _cut(heading, part)
        out.append(Reference(path.stem, title, about, tuple(sections)))
    return tuple(out)


def knowledge_index() -> list[dict]:
    return [{"name": r.name, "title": r.title, "about": r.about, "sections": len(r.sections), "characters": r.size}
            for r in library()]


ABOUT_THE_APP = ("app-guide", "whats-new")   # the app's own guide and its release notes: not trading references


def trading_references() -> list[str]:
    """The names of the references that teach a trading method: every one but the app's own guide and release notes."""
    return [r.name for r in library() if r.name not in ABOUT_THE_APP]


def library_note() -> str:
    """The list of references as the assistant's instructions carry it. Like the tool list, it is fixed for a release."""
    return "\n".join(f"- `{r.name}` ({len(r.sections)} sections): {r.title}. {r.about}" for r in library()) or "- (none yet)"


_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي", "ـ": None, "٫": ".",
                       **{chr(0x0660 + n): str(n) for n in range(10)}})
_MARKS = re.compile("[\u064b-\u065f\u0670]")


def fold(text: str) -> str:
    """Text as the search compares it: letter case, Arabic vowel marks and the spelling variants of
    alef, ya, hamza and ta marbuta are set aside, so a word is found however it was typed."""
    return _MARKS.sub("", unicodedata.normalize("NFKC", text).lower().translate(_FOLD))


_ARTICLE = re.compile(r"^(?:[وبفك]?ال|لل)(?=.{3})")  # "the", alone or joined to and / with / so / like / for
_FILLER = frozenset("""a an and are as at be by do does for from how in is it me my of on or say says tell that the this to
what when where which why with about اي ايه ما ماذا هو هي هل كيف ازاي في من على عن الي مع او ثم هذا هذه ده دي ان لو يعني ال""".split())


def _terms(query: str) -> list[str]:
    """The words to look for: no filler words, and an Arabic word without its article so that it
    matches with and without one."""
    words = [_ARTICLE.sub("", w) for w in re.findall(r"\d+(?:\.\d+)?|[^\W\d_]+", fold(query))]
    return list(dict.fromkeys(w for w in words if len(w) > 1 and w not in _FILLER))


def search_library(query: str, refs: Sequence[Reference]) -> list[dict]:
    """The sections that mention the query's words, best first.

    A word counts for more the fewer sections mention it, and more again in a heading, so a
    section about the subject comes before one that only touches it. Sections that score
    far below the best one are left out.
    """
    terms = _terms(query)
    rows = [(ref, n, heading, text, fold(heading), fold(text))
            for ref in refs for n, (heading, text) in enumerate(ref.sections, 1)]
    spread = {t: sum(t in row[5] for row in rows) for t in terms}
    found = []
    for order, (ref, n, heading, text, folded_heading, folded_text) in enumerate(rows):
        score, rarest = 0.0, None
        for t in terms:
            count = folded_text.count(t)
            if count:
                rarity = math.log(len(rows) / spread[t]) + 0.1
                score += rarity * (1 + min(count, 9) / 9 + 2 * (t in folded_heading))
                if rarest is None or spread[t] < spread[rarest]:
                    rarest = t
        if rarest is not None:
            line = next((ln.strip() for ln in text.splitlines() if rarest in fold(ln)), heading)
            found.append((-score, order, {"name": ref.name, "section": n, "title": heading, "mentions": line[:220]}))
    found.sort(key=lambda f: f[:2])
    return [match for score, _, match in found[:KNOWLEDGE_MATCHES] if score <= found[0][0] / 4]


class Knowledge(Args):
    name: str | None = Field(default=None, max_length=80, description="A reference's name. With nothing else, gives its "
                             "outline, or its whole text when it is short. Leave everything out to list the library")
    sections: list[Annotated[int, Field(ge=1, le=999)]] | None = Field(
        default=None, max_length=12, description="Section numbers from the reference's outline to read, with its name")
    query: str | None = Field(default=None, max_length=120, description="Words to look for, in Arabic or English. Searches "
                              "the whole library, or one reference when a name is given, and returns the sections to read")


def _knowledge(core: App, a: Knowledge) -> dict:
    refs = library()
    ref = None
    if a.name:
        wanted = a.name.strip().lower().removesuffix(".md")
        ref = next((r for r in refs if r.name.lower() == wanted), None)
        if ref is None:
            raise NotFound(f"no reference called {a.name}; available: {', '.join(r.name for r in refs) or 'none'}")
    if a.query and a.query.strip():
        matches = search_library(a.query, [ref] if ref else refs)
        note = ("Read the sections that fit with the reference's name and section numbers." if matches else
                "No section mentions these words. Try other words, in Arabic or English, or read a reference's outline.")
        return {"query": a.query, "matches": matches, "note": note}
    if ref is None:
        if a.sections:
            raise NotFound("give the reference's name together with the section numbers")
        return {"references": knowledge_index()}
    if a.sections:
        numbers = list(dict.fromkeys(a.sections))
        if max(numbers) > len(ref.sections):
            raise NotFound(f"{ref.name} has sections 1 to {len(ref.sections)}")
        out: list[dict] = []
        left: list[int] = []
        used = 0
        for n in numbers:
            heading, text = ref.sections[n - 1]
            if left or (out and used + len(text) > KNOWLEDGE_PART):
                left.append(n)
                continue
            out.append({"section": n, "title": heading, "text": text})
            used += len(text)
        result: dict = {"name": ref.name, "title": ref.title, "sections": out}
        if left:
            result["not_returned"] = {"sections": left, "note": "These did not fit in one answer. Ask for them in another call."}
        return result
    head = {"name": ref.name, "title": ref.title, "about": ref.about}
    if ref.size <= KNOWLEDGE_PART:
        return {**head, "text": "\n\n".join(text for _, text in ref.sections)}
    return {**head, "outline": [{"section": n, "title": heading, "characters": len(text)}
                                for n, (heading, text) in enumerate(ref.sections, 1)],
            "note": "Too long to return whole. Read the sections you need by number, several in one call if they are related."}


def _knowledge_label(a: Knowledge) -> str:
    if a.query and a.query.strip():
        return f"Searching the references for “{a.query.strip()[:40]}”"
    return f"Consulting the reference “{a.name}”" if a.name else "Checking the reference library"


class OpenPage(Args):
    page: Literal["dashboard", "market", "stock", "watchlist", "portfolio", "account", "trades", "strategies", "simulator",
                  "research", "journal", "alerts", "guide", "settings"]
    symbol: str | None = Field(default=None, max_length=12, description="Needed for the stock page")


def page_path(a: OpenPage) -> str:
    path = PAGES[a.page]
    return f"{path}?symbol={a.symbol.upper()}" if a.page == "stock" and a.symbol else path


def _open_page(core: App, a: OpenPage) -> dict:
    if a.page == "stock":
        if not a.symbol or core.market.instrument(a.symbol.upper()) is None:
            raise NotFound("give the symbol of a known stock to open its page")
    return {"opened": page_path(a)}


TOOLS: list[Tool] = [
    Tool("market_overview", "The market right now: indices, breadth, top gainers, losers and most active stocks, "
         "sector performance, whether the market is open and how fresh the prices are.", NoArgs, _market_overview,
         label=lambda a: "Reading the market overview"),
    Tool("find_stocks", "Search and rank the listed stocks by name, symbol or sector, with last price, day, week and "
         "month change and volume. Use it to screen (e.g. biggest movers in a sector).", FindStocks, _find_stocks,
         label=lambda a: f"Searching stocks{f' for {a.query}' if a.query else ''}{f' in {a.sector}' if a.sector else ''}"),
    Tool("screen_stocks", "Screen the whole market on technical conditions in one call: trend, RSI range, position against "
         "the 50 and 200-day averages, volume against its average, liquidity, monthly return, distance from the 12-month "
         "high. Use it to find candidates before looking at any single stock.", Screen, _screen,
         label=lambda a: "Screening the market"),
    Tool("stock_report", "Everything known about one stock: quote, technical and momentum read (trend, RSI, moving "
         "averages, support and resistance, returns), recent candles and the candle patterns detected in them, the user's "
         "holding in it, active strategy signals.",
         StockReport, _stock_report, label=lambda a: f"Looking at {a.symbol.upper()}"),
    Tool("candle_scan", "Japanese candlestick patterns the app detected across the market in the latest completed "
         "sessions (hammer, engulfing, stars, harami, doji, windows and more), with the level each defends and whether "
         "the next session confirmed it. Read the `candlesticks` reference before judging them.", CandleScan, _candle_scan,
         label=lambda a: f"Scanning for {a.direction + ' ' if a.direction else ''}candle patterns"),
    Tool("price_depth", "The live order book of one stock: the best bid and ask with their sizes, the spread, and the "
         "shares waiting on each side in total. The feed usually sends no price levels behind the best price: "
         "`top_only` names the sides for which that is so, and nothing can then be said about sizes at other prices. "
         "Needs the live market feed.",
         SymbolArg, _price_depth, label=lambda a: f"Reading the order book of {a.symbol.upper()}"),
    Tool("portfolio", "The paper portfolio: cash, holdings with cost and market value, gross and net profit, fees, "
         "sector allocation, concentration warnings and recent value history.", NoArgs, _portfolio,
         label=lambda a: "Reading the portfolio"),
    Tool("trades", "The paper ledger: the latest transactions with price, fees, cash movement and realized profit, and "
         "the totals. Each trade also carries the stock's price now (last, from the day last_as_of) and how far it "
         "has moved since the fill (since_pct, before fees).", Trades, _trades,
         label=lambda a: "Reading the trade ledger"),
    Tool("real_account", "The user's REAL brokerage account at EFG Hermes, which is separate from the paper portfolio: "
         "cash, total value, each holding with its cost, the broker's price, profit and the shares free to sell, and "
         "the checks the app made on those figures. Read-only: it cannot be traded from this app. Only the "
         "account's owner can see it; for anyone else it reports that it is unavailable.", NoArgs, _real_account,
         label=lambda a: "Reading the real brokerage account"),
    Tool("real_orders", "Real orders for the REAL brokerage account: whether proposals can be written now, the limits the "
         "owner set and how much of them was used today, the proposals waiting for the owner's decision, and what became "
         "of earlier ones at the broker. Also the owner's automatic box: whether your proposals are sent without them, "
         "the stocks, sizes and budget it allows, and the shares the automation holds with their stop-losses. Read it "
         "before every proposal. Only for the account's owner.", NoArgs, _real_orders,
         label=lambda a: "Reading the real orders"),
    Tool("propose_real_order", "Write a proposal for a REAL order (real money): one stock, buy or sell, whole shares, a "
         "limit price, your reasoning, and for a buy a stop-loss (and optionally a take-profit). It is checked against "
         "the owner's limits and the broker's figures, then it waits on the Real account page. Normally it is NOT sent: "
         "only the owner can approve it there. But when the owner has switched automatic orders on (see real_orders) and "
         "the proposal fits their box, it IS sent to the broker without them, within about a minute; the result tells "
         "you which of the two it is. Set hold_for_owner when the user wants to decide themselves. Use it only when the "
         "user asked for a real order to be prepared, or in a review of your own whose brief says the real account is "
         "part of it (the owner chooses in Settings → Assistant which account the autopilot works on).",
         ProposeRealOrder, _propose_real_order, account="real", kind="write",
         label=lambda a: f"Preparing a real {a.side.lower()} order for {a.qty:,} {a.symbol.upper()} at {a.limit_price}"),
    Tool("withdraw_real_order_proposal", "Take back a waiting proposal for a real order that you wrote and no longer stand behind.",
         WithdrawRealOrder, _withdraw_real_order, account="real", kind="write", label=lambda a: "Withdrawing a real order proposal"),
    Tool("preview_trade", "What a paper order would cost before placing it: fill price, every fee line, total cash, and "
         "whether it would be accepted.", TradeArgs, _preview_trade,
         label=lambda a: f"Pricing a {a.side.lower()} of {a.qty} {a.symbol.upper()}"),
    Tool("size_position", "How many shares to buy so that a stop-loss at a given price costs no more than a chosen share "
         "of the portfolio, within the user's limits and the cash available. Use it before buying. It works from the "
         "paper portfolio's value and cash: for a real order, work the size out from the real account's own figures.",
         Size, _size,
         label=lambda a: f"Sizing a position in {a.symbol.upper()}"),
    Tool("place_trade", "Record a paper trade in the ledger at the stock's latest price, with fees. Paper only: nothing "
         "is sent to a broker. The user's limits on your trading (size per trade and per stock, trades per day, cash "
         "kept) are enforced; a refused trade says which limit.", PlaceTrade, _place_trade, account="paper", kind="confirm",
         label=lambda a: f"{'Buy' if a.side == 'BUY' else 'Sell'} {a.qty:,} {a.symbol.upper()} (paper trade)"),
    Tool("protective_orders", "The stop-loss and take-profit orders on the holdings, how far the price is from each, and "
         "which holdings have no stop.", OrdersList, _orders, label=lambda a: "Reading the protective orders"),
    Tool("set_protective_order", "Put a stop-loss or a take-profit on a holding. The app carries it out by itself when "
         "the price is reached, also when nobody is looking. A new one replaces the old one of the same kind.", SetOrder,
         _set_order, account="paper", kind="confirm",
         label=lambda a: f"{'Stop-loss' if a.kind == 'stop' else 'Take-profit'} on {a.symbol.upper()} at {a.price:g}"),
    Tool("cancel_protective_order", "Cancel an open stop-loss or take-profit.", CancelOrder, _cancel_order, account="paper", kind="confirm",
         label=lambda a: "Cancel a protective order"),
    Tool("watchlist", "The stocks on the watchlist with their quotes, and the user's custom stock lists.", NoArgs, _watchlist,
         label=lambda a: "Reading the watchlist"),
    Tool("set_watch", "Add a stock to the watchlist or remove it.", SetWatch, _set_watch, kind="write",
         label=lambda a: f"{'Add' if a.watched else 'Remove'} {a.symbol.upper()} {'to' if a.watched else 'from'} the watchlist"),
    Tool("save_stock_list", "Create or change a custom list of stocks.", SaveList, _save_list, kind="write",
         label=lambda a: f"Save the stock list “{a.name}”"),
    Tool("strategies", "The saved strategies, the available strategy types with their parameters and ranges, and the "
         "default risk settings.", NoArgs, _strategies, label=lambda a: "Reading the strategies"),
    Tool("save_strategy", "Create or change a strategy: its type, parameters, stocks or sectors, and risk settings "
         "(stop-loss, take-profit, position size, cash reserve, slippage).", SaveStrategy, _save_strategy, kind="write",
         label=lambda a: f"Save the strategy “{a.name}”"),
    Tool("run_backtest", "Test a saved strategy on price history with fees and slippage. Returns the metrics, warnings "
         "and latest trades; the run is kept in the simulator's history.", RunBacktest, _run_backtest, kind="write",
         label=lambda a: "Run a backtest"),
    Tool("compare_strategies", "Backtest two to four saved strategies on the same stocks, period, capital and fees.",
         Compare, _compare, kind="write", label=lambda a: f"Compare {len(a.strategy_ids)} strategies"),
    Tool("backtests", "Earlier backtest runs: the history, or one run's metrics and trades by id.", Backtests, _backtests,
         label=lambda a: "Reading backtest results"),
    Tool("signals", "Entry and exit signals the saved strategies give on the latest completed session.", NoArgs, _signals,
         label=lambda a: "Reading today's strategy signals"),
    Tool("paper_runs", "Automatic paper-trading runs: status, capital, cash, open positions, profit, pending orders and notes.",
         NoArgs, _paper_runs, label=lambda a: "Reading the automatic runs"),
    Tool("start_paper_run", "Start an automatic paper-trading run: a saved strategy trades the paper portfolio by itself "
         "with the capital set aside for it.", StartRun, _start_run, account="paper", kind="confirm",
         label=lambda a: f"Start an automatic run with EGP {a.capital:,.0f}"),
    Tool("set_paper_run_status", "Pause, resume or stop an automatic run. Stopping is final.", RunStatus, _run_status,
         account="paper", kind="confirm", label=lambda a: {"active": "Resume", "paused": "Pause", "stopped": "Stop"}[a.status] + " an automatic run"),
    Tool("alerts", "The alerts, what kinds exist, and the alerts that fired recently. `wake` marks a watch (it wakes you when "
         "it fires) and `by` says who set it.", NoArgs, _alerts,
         label=lambda a: "Reading the alerts"),
    Tool("save_alert", "Create or change an alert on a price, day change, volume, RSI level, strategy signal or a time "
         "(kind time_at with `at`). The app checks it by itself, in code and at no cost, and tells the user when it fires. With "
         "wake_me it is a watch: when it fires the app also wakes YOU with a short review of that event, your note in front of "
         "you. Use a watch instead of looking again later: an entry level, the level that proves a trade wrong, a time to "
         "re-check. A watch fires once and is then off.",
         SaveAlert, _save_alert, kind="write",
         label=lambda a: (f"{'Set a watch' if a.wake_me else 'Save an alert'}"
                          f"{f' on {a.symbol.upper()}' if a.symbol else ''}")),
    Tool("research", "The research and news items the user saved, filtered by stock, text or category.", Research, _research,
         label=lambda a: "Reading saved research"),
    Tool("save_research", "Save or change a research or news item, linked to stocks and sectors.", SaveResearch,
         _save_research, kind="write", label=lambda a: f"Save the research item “{a.title[:50]}”"),
    Tool("journal", "The investment journal: why trades were made, what was expected and what was learned.", Journal,
         _journal, label=lambda a: "Reading the journal"),
    Tool("save_journal_entry", "Write or update a journal entry.", SaveJournal, _save_journal, kind="write",
         label=lambda a: f"Save a journal entry{f' on {a.symbol.upper()}' if a.symbol else ''}"),
    Tool("delete_item", "Delete a strategy, alert, research item, journal entry or custom stock list for good.", Delete,
         _delete, kind="confirm", label=lambda a: f"Delete a {a.kind}"),
    Tool("settings", "The app's settings: starting capital, the fee schedule and whether it was verified, the state of "
         "the market-data feed and data quality. Also your own settings as the user saved them in Settings → Assistant "
         "(access, limits, ceilings, the autopilot's schedule and account) and `trading_by_itself`: what is in place for "
         "you to trade by yourself and what is still missing, each with where the user sets it. Read it when asked why "
         "you did or did not act by yourself, or how to set that up.", NoArgs, _settings,
         label=lambda a: "Reading the settings"),
    Tool("update_settings", "Change the starting capital or the benchmark.", UpdateSettings, _update_settings,
         account="paper", kind="confirm", label=lambda a: "Change the settings"),
    Tool("update_fee_schedule", "Replace the fee schedule used for every later trade and backtest. Read the current one "
         "first and send the complete list.", UpdateFees, _update_fees, kind="confirm",
         label=lambda a: f"Replace the fee schedule ({len(a.items)} lines)"),
    Tool("reset_portfolio", "Start a fresh paper portfolio with the starting capital. The old ledger is kept but no "
         "longer active.", NoArgs, _reset_portfolio, account="paper", kind="confirm", label=lambda a: "Reset the paper portfolio"),
    Tool("audit_log", "The record of what was changed in this account and when.", Audit, _audit,
         label=lambda a: "Reading the activity log"),
    Tool("knowledge", "The app's reference library: how the app works, and the owner's trading references (books and "
         "notes). With no arguments it lists the references. With a name it gives that reference's outline, or the "
         "whole text when it is short. With a name and section numbers it returns those sections. With a query it "
         "finds the sections that mention the words.", Knowledge, _knowledge, label=_knowledge_label),
    Tool("open_page", "Open one of the app's screens for the user.", OpenPage, _open_page, kind="write",
         label=lambda a: f"Open the {a.page} page{f' for {a.symbol.upper()}' if a.symbol else ''}"),
]
BY_NAME = {t.name: t for t in TOOLS}


def _inline(schema: dict) -> dict:
    """A pydantic JSON schema with its references resolved in place and the noise removed."""
    defs = schema.get("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].rsplit("/", 1)[1]])
            return {k: walk(v) for k, v in node.items() if k not in ("title", "$defs")}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node
    return walk(schema)


def tool_specs() -> list[dict]:
    """The tool definitions sent to the model. Their order and content are fixed, which keeps the prompt cacheable."""
    return [{"name": t.name, "description": t.description, "input_schema": _inline(t.args.model_json_schema()),
             "eager_input_streaming": True} for t in TOOLS]


def parse(name: str, raw) -> tuple[Tool | None, Any, str | None]:
    """Find the tool and check its input. The model's input is never trusted as it arrives:
    it is validated against the tool's own schema before anything runs."""
    tool = BY_NAME.get(name)
    if tool is None:
        return None, None, f"There is no tool called {name}."
    try:
        return tool, tool.args.model_validate(raw if isinstance(raw, dict) else {}), None
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'input'}: {e['msg']}" for e in exc.errors()[:6])
        return tool, None, json.dumps({"INVALID_JSON": json.dumps(raw, default=str)[:2000], "problems": problems})


def render(result) -> str:
    """A tool result as compact JSON, bounded so one answer cannot flood the conversation."""
    text = json.dumps(r4(clean(result)), separators=(",", ":"), default=str, ensure_ascii=False)
    if len(text) > MAX_RESULT_CHARS:
        return json.dumps({"too_large": True, "characters": len(text),
                           "note": "The result was too large to return. Ask for less: a smaller limit, a filter, fewer candles."})
    return text
