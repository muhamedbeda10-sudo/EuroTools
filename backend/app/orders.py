"""Protective orders: a stop-loss or a take-profit on a holding, carried out by the app itself.

An order is a standing instruction to sell when a price is reached. It is paper only,
like everything here: when it triggers, an ordinary SELL is written to the ledger with
the usual fees. Orders are what make it reasonable to leave a position unattended, by a
person or by the assistant.

How a trigger is judged
* On a completed session after the one the order was placed in, the day's whole range
  counts: a stop triggers if the low reached it and fills at the stop, or at the open if
  the stock gapped below it (the same rule as the backtester); a target mirrors that.
* During a running session, and for the session the order was placed in, only the latest
  price counts: the day's low or high may have happened before the order existed, and
  the app only sees prices while it is open. A touch that reverses between two looks is
  caught once that session is complete, except on the placement day itself.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Literal

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from . import wakes
from .domain.ledger import LedgerError, build_trade, replay
from .domain.money import D, px
from .services import App, NotFound, now_iso

ISO = "%Y-%m-%d"
NAMES = {"stop": "Stop-loss", "target": "Take-profit"}


class OrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(min_length=1, max_length=12)
    kind: Literal["stop", "target"]
    price: Decimal = Field(gt=0, le=Decimal("10000000"))
    qty: int | None = Field(default=None, gt=0, le=100_000_000)
    note: str = Field(default="", max_length=300)


def list_orders(core: App, status: str | None = "open") -> list[dict]:
    rows = sorted(core.store.list("orders"), key=lambda o: o["created_at"], reverse=True)
    return [o for o in rows if status in (None, "all") or o["status"] == status]


def place(core: App, body: OrderIn, origin: str = "manual") -> dict:
    symbol = body.symbol.upper()
    if core.market.instrument(symbol) is None:
        raise NotFound(f"unknown stock {symbol}")
    with core.store.transaction():
        held = replay(core.store.list(core._ledger_coll())).positions.get(symbol)
        if held is None or held.qty == 0:
            raise LedgerError(f"there are no {symbol} shares in the portfolio to protect")
        qty = body.qty or held.qty
        if qty > held.qty:
            raise LedgerError(f"only {held.qty} {symbol} are held")
        known = core._last_price(symbol)
        if known is None:
            raise LedgerError(f"no price data for {symbol}")
        last, as_of = known
        price = px(body.price)
        if body.kind == "stop" and price >= last:
            raise LedgerError(f"a stop-loss must be below the latest price ({last:f}); at {price:f} it would sell at once")
        if body.kind == "target" and price <= last:
            raise LedgerError(f"a take-profit must be above the latest price ({last:f}); at {price:f} it would sell at once")
        for old in core.store.list("orders"):  # one stop and one target per stock: a new one replaces the old
            if old["status"] == "open" and old["symbol"] == symbol and old["kind"] == body.kind:
                core.store.put("orders", old["id"], {**old, "status": "cancelled", "closed_at": now_iso(), "reason": "replaced"})
        order = {"id": uuid.uuid4().hex[:12], "symbol": symbol, "kind": body.kind, "price": str(price), "qty": qty,
                 "note": body.note.strip(), "origin": origin, "status": "open", "created_at": now_iso(),
                 "created_session": as_of, "checked_through": None}
        core.store.put("orders", order["id"], order)
        core.audit("place", "protective_order", {k: order[k] for k in ("id", "symbol", "kind", "price", "qty", "origin")})
        return order


def cancel(core: App, order_id: str) -> dict:
    with core.store.transaction():
        order = core.store.get("orders", order_id)
        if order is None:
            raise NotFound("order not found")
        if order["status"] != "open":
            raise LedgerError(f"this order is already {order['status']}")
        order.update(status="cancelled", closed_at=now_iso(), reason="cancelled by the user")
        core.store.put("orders", order_id, order)
        core.audit("cancel", "protective_order", {"id": order_id, "symbol": order["symbol"]})
        return order


def _trigger(order: dict, bars: pd.DataFrame, settled: pd.Timestamp | None) -> tuple[pd.Timestamp, Decimal] | None:
    """The session and price at which the order fills, or None. Advances `checked_through` over completed sessions."""
    level, stop = D(order["price"]), order["kind"] == "stop"
    first = pd.Timestamp(order["created_session"])
    done = pd.Timestamp(order["checked_through"]) if order["checked_through"] else None
    for day, bar in bars[bars.index >= first].iterrows():
        if done is not None and day <= done:
            continue
        complete = settled is not None and day <= settled
        opened, high, low, close = (D(float(bar[k])) for k in ("open", "high", "low", "close"))
        if day == first or not complete:
            if (close <= level) if stop else (close >= level):
                return day, close
        elif stop and low <= level:
            return day, min(opened, level)
        elif not stop and high >= level:
            return day, max(opened, level)
        if complete:
            order["checked_through"] = day.strftime(ISO)
    return None


def process(core: App) -> dict:
    """Carry out every open order whose price has been reached. Safe to call any number of times."""
    open_orders = [o for o in core.store.list("orders") if o["status"] == "open"]
    if not open_orders:
        return {"filled": [], "cancelled": 0}
    filled, cancelled = [], 0
    with core.store.transaction():
        coll = core._ledger_coll()
        txs = core.store.list(coll)
        schedule = core.fee_schedule()
        for order in sorted(open_orders, key=lambda o: o["created_at"]):
            before = dict(order)
            symbol = order["symbol"]
            position = replay(txs).positions.get(symbol)
            held = position.qty if position is not None else 0
            if held == 0:  # sold some other way: nothing left to protect
                order.update(status="cancelled", closed_at=now_iso(), reason="the position was closed")
                cancelled += 1
            else:
                bars = core.market.bars(symbol)
                hit = _trigger(order, bars, core.market.settled_until(symbol)) if bars is not None and len(bars) else None
                if hit:
                    day, price = hit
                    qty = min(order["qty"], held)
                    tx = build_trade(replay(txs), schedule, side="SELL", symbol=symbol, qty=qty, price=px(price))
                    iso = day.strftime(ISO)
                    tx.update(ts=now_iso(), trade_date=iso, price_date=iso, price_source=core.market.source(symbol), mode="paper",
                              note=f"{NAMES[order['kind']]} at {D(order['price']):f}" + (f": {order['note']}" if order["note"] else ""),
                              origin=f"order:{order['id']}", client_order_id=None)
                    saved = core.store.append(coll, tx)
                    txs.append(saved)
                    order.update(status="filled", closed_at=now_iso(),
                                 filled={"seq": saved["seq"], "price": tx["price"], "date": iso, "qty": qty})
                    core.audit("fill", "protective_order", {"id": order["id"], "symbol": symbol, "kind": order["kind"],
                                                           "qty": qty, "price": tx["price"], "seq": saved["seq"]})
                    filled.append({"id": order["id"], "symbol": symbol, "kind": order["kind"], "qty": qty,
                                   "price": float(tx["price"]), "date": iso, "seq": saved["seq"],
                                   "message": f"{NAMES[order['kind']]} on {symbol}: sold {qty:,} at {float(tx['price']):g}"})
            if order != before:
                core.store.put("orders", order["id"], order)
    wakes.note_paper_fills(core, filled)   # the assistant hears that a position went, when events wake it
    return {"filled": filled, "cancelled": cancelled}


def view(core: App, order: dict) -> dict:
    """An order with how far the latest price is from it."""
    known = core._last_price(order["symbol"])
    last = float(known[0]) if known else None
    level = float(order["price"])
    return {**order, "price": level, "name": NAMES[order["kind"]], "last": last,
            "distance_pct": (level / last - 1) * 100 if last else None}
