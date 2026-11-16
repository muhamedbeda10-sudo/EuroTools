"""Real orders: prepared in the app, sent to the broker only when the account's owner approves each one.

This is the second step towards real trading. An order starts as a proposal: written by the
owner on the Real account page, or by the assistant. A proposal is words in the owner's own
data and moves nothing. It becomes an order at the broker in exactly one way: the owner opens
it, reads it and approves it (`approve`). The assistant has no tool that does that, and no
automatic run reaches this module.

What stands between a proposal and the exchange, every time, in this order
    1. The sign-in is the account's owner (`broker.may_view`).
    2. Real orders are switched on twice: on the server (LIVE_TRADING_ENABLED, off unless set)
       and by the owner in Settings, who must also have written the limits. Either switch
       stops everything at once.
    3. The order itself: a listed stock, whole shares, a limit price. Day orders only. There
       is no market order, because its cost cannot be bounded.
    4. The owner's limits: value per order, orders and value per day, the stocks allowed, and
       how far the price may sit on the costly side of the market.
    5. The broker's own facts, read at that moment: the money available for a buy, the shares
       free to sell for a sale, the price range the exchange accepts today.
    6. The session is running.
A proposal that fails any of these is not sent, and says which one.

Sent once
    Approval is written first (`sending`), together with the day's lock, so two approvals at
    the same moment cannot both go out. Then one request goes to the broker. If the broker
    says no, the order is `rejected` with its reason. If the request never left, it is
    `failed`. If it left and no clear answer came back, it is `unknown`: it is never sent
    again; the broker's own list is read to find it, and until that is settled no further
    order for the same stock and side can be approved.

The paper portfolio is untouched by all of this: nothing here writes to the paper ledger.
"""
from __future__ import annotations

import logging
import re
import threading
import time
import uuid
import weakref
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import broker
from .data.calendar import SESSION_CLOSE, cairo_now, is_trading_day, market_open
from .data.younit import OrderRefused, OrderUncertain, YounitError
from .domain.fees import compute_fees
from .domain.money import ZERO, D, money, px
from .services import App, NotFound, clean, now_iso
from .store.errors import ConflictError

SETTINGS = ("settings", "real_trading")
STATE = ("settings", "real_orders_state")   # how many proposals wait, and the trading profile: one small read for the menu
ID = re.compile(r"\d{6}[0-9a-f]{10}")
MAX_WAITING = 10            # proposals waiting for the owner at one time
MAX_ASSISTANT_PER_DAY = 20  # proposals the assistant may write in a day
STALE_SENDING_SECONDS = 120.0   # a send that never reported back is treated as doubtful after this
LIST_SECONDS = 10.0         # the broker's order list serves every look within this time
OPEN_STATES = ("open", "partial")
COUNTED = ("sending", "sent", "unknown")   # reached the broker, or may have: these use up the day's limits

_lists: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()   # client -> (monotonic time, profile id, rows)
_lists_lock = threading.Lock()
# One approval at a time in this process. The database's refusal of a stale write is what holds across
# servers; this holds where the store cannot refuse (a local run), and spares the broker a wasted look.
_approving = threading.Lock()
log = logging.getLogger("egx.real_orders")


class OrderError(ValueError):
    """The order cannot be prepared or sent as asked. The message says why."""


# ---- the owner's switch and limits ------------------------------------------------------
class LimitsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    max_order_value: Decimal | None = Field(default=None, gt=0, le=Decimal("100000000"))
    max_day_value: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))
    max_day_orders: int | None = Field(default=None, ge=1, le=200)
    price_band_pct: Decimal = Field(default=Decimal("2"), ge=Decimal("0.1"), le=Decimal("10"))
    symbols: list[str] = Field(default_factory=list, max_length=300)


class OrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(min_length=1, max_length=12)
    side: Literal["BUY", "SELL"]
    qty: int = Field(gt=0, le=100_000_000)
    price: Decimal = Field(gt=0, le=Decimal("10000000"))
    reason: str = Field(default="", max_length=600)
    # For a buy only. They are not sent to the broker: they are what the app watches the position by
    # when the order was sent automatically (see real_auto.py), and what the owner reads otherwise.
    stop_price: Decimal | None = Field(default=None, gt=0, le=Decimal("10000000"))
    target_price: Decimal | None = Field(default=None, gt=0, le=Decimal("10000000"))


def _price(order: OrderIn) -> Decimal:
    """The order's price as the exchange quotes prices: three decimals at most."""
    return px(order.price.quantize(Decimal("0.001")))


def _owner(core: App) -> None:
    if core.younit is None:
        raise NotFound("real orders need the Younit connection, which is not set up on the server")
    if not core.real_account_allowed:
        raise broker.NotAllowed("real orders are not enabled for this sign-in")


def limits(core: App) -> dict:
    """The owner's switch and limits. Anything unreadable there counts as "off"."""
    saved = core.store.get(*SETTINGS) or {}
    try:
        return LimitsIn.model_validate({k: saved[k] for k in LimitsIn.model_fields if k in saved}).model_dump(mode="json")
    except ValidationError:
        return LimitsIn().model_dump(mode="json")


def readiness(core: App, chosen: dict | None = None) -> dict:
    """Whether an order could be sent at all right now, and if not, the one thing to do about it."""
    chosen = chosen or limits(core)
    server = bool(core.settings.live_trading_enabled)
    complete = None not in (chosen["max_order_value"], chosen["max_day_value"], chosen["max_day_orders"])
    why = None
    if not server:
        why = "Real orders are switched off on the server (LIVE_TRADING_ENABLED)."
    elif not chosen["enabled"]:
        why = "Real orders are switched off in Settings → Real trading."
    elif not complete:
        why = "Set the limits in Settings → Real trading first: value per order, value per day and orders per day."
    return {"server_on": server, "owner_on": bool(chosen["enabled"]), "limits_set": complete, "ready": why is None, "why_not": why}


def save_limits(core: App, body: LimitsIn) -> dict:
    _owner(core)
    if body.enabled and None in (body.max_order_value, body.max_day_value, body.max_day_orders):
        raise OrderError("To switch real orders on, set all three limits: value per order, value per day and orders per day.")
    if body.max_order_value is not None and body.max_day_value is not None and body.max_order_value > body.max_day_value:
        raise OrderError("The limit per order cannot be larger than the limit per day.")
    symbols = sorted({s.strip().upper() for s in body.symbols if s.strip()})
    unknown = [s for s in symbols if core.market.instrument(s) is None]
    if unknown:
        raise OrderError(f"Not in the app's stock list: {', '.join(unknown[:10])}.")
    before = limits(core)
    after = {**body.model_dump(mode="json"), "symbols": symbols}
    with core.store.transaction():
        core.store.put(*SETTINGS, after)
        core.audit("update", "real_trading_settings", {"before": before, "after": after})
    return settings_view(core)


def settings_view(core: App) -> dict:
    _owner(core)
    chosen = limits(core)
    return {"limits": chosen, **readiness(core, chosen)}


# ---- where the records live, and when --------------------------------------------------
def _coll(month: str) -> str:
    return f"real_orders_{month}"


def _session(now: datetime) -> str:
    """The trading day an order prepared now is meant for: today while today's session can still take it, else the next one."""
    day = now.date()
    if market_open(now) or (is_trading_day(day) and now.time() <= SESSION_CLOSE):
        return day.isoformat()
    day += timedelta(days=1)
    while not is_trading_day(day):
        day += timedelta(days=1)
    return day.isoformat()


def _over(session: str, now: datetime) -> bool:
    """Whether the session a proposal was written for has ended."""
    today = now.date().isoformat()
    return session < today or (session == today and not market_open(now) and now.time() > SESSION_CLOSE)


def _records(core: App, now: datetime) -> list[dict]:
    """This month's records, and last month's during the first days of a month. Newest first."""
    months = [f"{now:%Y%m}"]
    if now.day <= 5:
        months.append(f"{now.replace(day=1) - timedelta(days=1):%Y%m}")
    core.store.warm(lists=[_coll(m) for m in months])
    rows = [r for m in months for r in core.store.list(_coll(m))]
    return sorted(rows, key=lambda r: r["created_at"], reverse=True)


def _get(core: App, id: str) -> dict:
    if not ID.fullmatch(id or ""):
        raise NotFound("no such order")
    rec = core.store.get(_coll(id[:6]), id)
    if rec is None:
        raise NotFound("no such order")
    return rec


def _with_others(core: App, id: str, now: datetime) -> tuple[dict, list[dict]]:
    """One record and all the recent ones around it (the same object sits in the list)."""
    records = _records(core, now)
    rec = next((r for r in records if r["id"] == id), None)
    if rec is None:
        rec = _get(core, id)
        records.append(rec)
    return rec, records


def _put(core: App, rec: dict) -> None:
    core.store.put(_coll(rec["id"][:6]), rec["id"], rec)


def _summary(rec: dict) -> dict:
    """What the activity log keeps about an order."""
    out = {k: rec.get(k) for k in ("id", "symbol", "side", "qty", "price", "origin", "status")}
    if rec.get("approved_by"):
        out["approved_by"] = rec["approved_by"]
    if rec.get("stop"):
        out["stop"] = rec["stop"]
    if rec.get("broker", {}).get("order_id"):
        out["broker_order_id"] = rec["broker"]["order_id"]
    if rec.get("status_note"):
        out["note"] = rec["status_note"]
    return out


def _note_state(core: App, records: list[dict], profile_id: int | None = None) -> None:
    """Keep the small state document in step: the sessions of the proposals that wait, and the trading profile."""
    saved = core.store.get(*STATE) or {}
    wanted = {"sessions": sorted(r["session"] for r in records if r["status"] == "proposed"),
              "profile_id": profile_id or saved.get("profile_id")}
    if {k: saved.get(k) for k in wanted} != wanted:
        try:
            core.store.put(*STATE, wanted)
        except ConflictError:
            pass  # another window wrote it at the same moment; the next look puts it right


def menu_state(core: App) -> dict:
    """For the menu and the top bar: no call to the broker, two small reads, and only for the owner."""
    if core.younit is None or not core.real_account_allowed:
        return {"allowed": False, "ready": False, "waiting": 0}
    now = cairo_now()
    sessions = (core.store.get(*STATE) or {}).get("sessions") or []
    return {"allowed": True, "ready": readiness(core)["ready"],
            "waiting": sum(1 for s in sessions if isinstance(s, str) and not _over(s, now))}   # a proposal goes with its session


def _used_today(records: list[dict], today: str, *, apart_from: str | None = None) -> tuple[int, Decimal]:
    """Today's use of the owner's limits. A way out of a position the automation holds is not counted: the limits
    bound what is put at stake, and a sale that could not be completed must not shut the owner's own orders out."""
    rows = [r for r in records if r.get("sent_day") == today and r["status"] in COUNTED and r["id"] != apart_from
            and not r.get("protective")]
    return len(rows), sum((D(r["value"]) for r in rows), ZERO)


def examine(core: App, order: OrderIn, records: list[dict], now: datetime, *, sending: bool,
            apart_from: str | None = None, protective: bool = False) -> dict:
    """Every check on one order. `problems` stop it; `notes` are for the reader; `facts` are what was read.

    With `sending`, this is the last look before the request goes out: the session must be running.
    `protective` marks a sale that gets the automation out of a position it holds (a stop-loss or a
    take-profit): the owner's limits on size and number, which exist to bound what is put at stake, do not
    hold it back. The switches, the broker's own facts and the price band still do.
    """
    problems: list[str] = []
    notes: list[str] = []
    facts: dict = {}
    chosen = limits(core)
    ready = readiness(core, chosen)
    if not ready["ready"]:
        problems.append(ready["why_not"])

    symbol = order.symbol.strip().upper()
    ins = core.market.instrument(symbol)
    listing = next((i for i in (core.market.feed or {}).get("instruments", [])
                    if i["symbol"] == symbol and i.get("listed", True) and i.get("stock_id") is not None), None)
    if ins is None or listing is None:
        return {"ok": False, "problems": [*problems, f"{symbol} is not a stock the broker lists for trading."], "notes": notes,
                "facts": facts}
    price = _price(order)
    if abs(order.price - price) > Decimal("0.000000001"):   # a finer price than the exchange quotes; rounding noise is let through
        problems.append("A price has at most three decimals.")
    if order.side == "BUY":
        if order.stop_price is not None and order.stop_price >= price:
            problems.append("A stop-loss must be under the buying price.")
        if order.target_price is not None and order.target_price <= price:
            problems.append("A take-profit must be above the buying price.")
    elif order.stop_price is not None or order.target_price is not None:
        problems.append("A stop-loss or a take-profit goes with a buy, not with a sale.")
    value = money(price * order.qty)
    fees = compute_fees(core.fee_schedule(), "buy" if order.side == "BUY" else "sell", value)["total"]
    facts.update(symbol=symbol, name=ins.get("name"), stock_id=listing["stock_id"], side=order.side, qty=order.qty,
                 price=price, value=value, est_fees=money(fees), fees_verified=core.fee_schedule().verified,
                 session=_session(now), market_open=market_open(now))
    if not core.fee_schedule().verified:
        notes.append("Fees are an estimate from the placeholder schedule in Settings; the broker's own charges apply.")

    # the owner's limits (they bound what is put at stake: a way out of a position is not held back by them)
    if not protective and chosen["symbols"] and symbol not in chosen["symbols"]:
        problems.append(f"{symbol} is not among the stocks allowed for real orders in Settings.")
    count, used = _used_today(records, now.date().isoformat(), apart_from=apart_from)
    facts.update(limits={k: chosen[k] for k in ("max_order_value", "max_day_value", "max_day_orders", "price_band_pct")},
                 day={"orders": count, "value": money(used)})
    if protective:
        pass   # a way out of a position is not held back by limits on what may be put in
    elif chosen["max_order_value"] is not None and value > D(chosen["max_order_value"]):
        problems.append(f"The order is worth {value:,.2f}; your limit per order is {D(chosen['max_order_value']):,.2f}.")
    if not protective and chosen["max_day_orders"] is not None and count + 1 > chosen["max_day_orders"]:
        problems.append(f"{count} real orders were already sent today; your limit is {chosen['max_day_orders']} a day.")
    if not protective and chosen["max_day_value"] is not None and used + value > D(chosen["max_day_value"]):
        problems.append(f"With this order, today's real orders would total {used + value:,.2f}; "
                        f"your limit per day is {D(chosen['max_day_value']):,.2f}.")
    doubt = next((r for r in records if r["status"] in ("unknown", "sending") and r["symbol"] == symbol
                  and r["side"] == order.side and r["id"] != apart_from), None)
    if doubt:
        problems.append(f"An earlier {order.side} order for {symbol} may or may not have reached the broker. "
                        "Settle that one first, so the same order is not placed twice.")

    # the broker's own facts, read now
    try:
        with ThreadPoolExecutor(3) as pool:   # three questions to the broker, asked together
            asked = [pool.submit(core.younit.buying_power, listing["stock_id"]),
                     pool.submit(core.younit.trading_limits, listing["stock_id"])]
            if order.side == "SELL":
                asked.append(pool.submit(lambda: broker.reading(core, fresh=True)["positions"]))
            power, allowed, *positions = (job.result() for job in asked)
        held = None
        if order.side == "SELL":
            position = next((p for p in positions[0] if p["stock_id"] == listing["stock_id"]), None)
            held = {"qty": position["qty"] if position else 0, "free": position["available"] if position else 0}
    except YounitError as exc:
        return {"ok": False, "problems": [*problems, f"The broker could not be asked about this order: {exc}"], "notes": notes,
                "facts": clean(facts)}
    known = core._last_price(symbol)
    reference = allowed["last"] or (float(known[0]) if known else None)
    facts.update(profile_id=power["profile_id"], buying_power=power["buying_power"], held=held, reference_price=reference,
                 min_price=allowed["min_price"], max_price=allowed["max_price"])
    if reference is None:
        problems.append(f"There is no current price for {symbol} to check the order against.")
    else:
        if order.side == "BUY" and order.stop_price is not None and float(order.stop_price) >= reference:
            problems.append(f"Its stop-loss ({float(order.stop_price):g}) is at or above the market ({reference:g}): "
                            "it would be bought already under its stop.")
        band = float(D(chosen["price_band_pct"]))
        gap = (float(price) - reference) / reference * 100
        facts["distance_pct"] = gap
        if order.side == "BUY" and gap > band:
            problems.append(f"The price is {gap:.1f}% above the market ({reference:g}); you allow at most {band:g}%.")
        if order.side == "SELL" and gap < -band:
            problems.append(f"The price is {-gap:.1f}% below the market ({reference:g}); you allow at most {band:g}%.")
    if allowed["min_price"] and float(price) < allowed["min_price"]:
        problems.append(f"The exchange accepts no price under {allowed['min_price']:g} for {symbol} today.")
    if allowed["max_price"] and float(price) > allowed["max_price"]:
        problems.append(f"The exchange accepts no price over {allowed['max_price']:g} for {symbol} today.")
    if order.side == "BUY":
        if power["buying_power"] is None:
            problems.append("The broker did not say how much can be spent, so the order cannot be checked against it.")
        elif float(value + fees) > power["buying_power"]:
            problems.append(f"The order needs about {value + fees:,.2f} with fees; the broker says {power['buying_power']:,.2f} can be spent.")
    elif order.qty > held["free"]:
        problems.append(f"{order.qty:,} shares cannot be sold: {held['free']:,} of the {held['qty']:,} held are free to sell now."
                        if held["qty"] else f"The account holds no {symbol} to sell.")

    if not facts["market_open"]:
        if sending:
            problems.append("The market is closed. A real order can be sent only while the session is running.")
        else:
            notes.append(f"The market is closed: this can be approved during the session of {facts['session']}, "
                         "and everything is checked again then.")
    return clean({"ok": not problems, "problems": problems, "notes": notes, "facts": facts})


def check(core: App, order: OrderIn) -> dict:
    """What would stand in the way of this order, without writing anything down."""
    _owner(core)
    now = cairo_now()
    return examine(core, order, _records(core, now), now, sending=False)


def check_waiting(core: App, id: str) -> dict:
    """The last look at a waiting proposal before the owner approves it: as it would be judged on sending."""
    _owner(core)
    now = cairo_now()
    rec = _get(core, id)
    return {**examine(core, _as_order(rec), _records(core, now), now, sending=True, apart_from=id), "order": _public(rec)}


def _as_order(rec: dict) -> OrderIn:
    return OrderIn(symbol=rec["symbol"], side=rec["side"], qty=rec["qty"], price=Decimal(str(rec["price"])),
                   reason=rec.get("reason") or "",
                   stop_price=Decimal(str(rec["stop"])) if rec.get("stop") else None,
                   target_price=Decimal(str(rec["target"])) if rec.get("target") else None)


# ---- proposals --------------------------------------------------------------------------
def propose(core: App, order: OrderIn, origin: Literal["manual", "assistant", "automation"] = "manual",
            chat: str | None = None, *, protective: bool = False, hold: bool = False) -> dict:
    """Write a proposal down. Nothing is sent by this: it waits, for the owner or for the automation's next look.

    `automation` is the app's own way out of a position it holds (a stop-loss or a take-profit reached);
    such a proposal is written only by real_auto.py, which sends it at once.
    """
    _owner(core)
    now = cairo_now()
    records = _records(core, now)
    waiting = [r for r in records if r["status"] == "proposed" and not _over(r["session"], now)]
    if origin != "automation" and len([r for r in waiting if r["origin"] != "automation"]) >= MAX_WAITING:
        raise OrderError(f"{MAX_WAITING} proposals are already waiting for a decision. Decide on those first.")
    today = now.date().isoformat()
    if origin == "assistant":
        if sum(1 for r in records if r["origin"] == "assistant" and r["created_day"] == today) >= MAX_ASSISTANT_PER_DAY:
            raise OrderError(f"The assistant has already written {MAX_ASSISTANT_PER_DAY} proposals today, which is its limit.")
        if len(order.reason.strip()) < 15:
            raise OrderError("Say why: a proposal from the assistant needs its reasoning in a sentence or two.")
    result = examine(core, order, records, now, sending=False, protective=protective)
    if not result["ok"]:
        raise OrderError(" ".join(result["problems"]))
    facts = result["facts"]
    same = next((r for r in waiting if (r["symbol"], r["side"], r["qty"], px(Decimal(str(r["price"])))) ==
                 (facts["symbol"], order.side, order.qty, _price(order))), None)
    if same:
        raise OrderError("The same order is already waiting for a decision.")
    rec = {
        "id": f"{now:%Y%m}{uuid.uuid4().hex[:10]}", "created_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
        "created_day": today, "session": facts["session"],
        "origin": origin, "chat": chat, "symbol": facts["symbol"], "name": facts["name"], "stock_id": facts["stock_id"],
        "side": order.side, "qty": order.qty, "price": str(_price(order)), "value": str(money(_price(order) * order.qty)),
        "reason": order.reason.strip(), "status": "proposed", "status_note": None,
        "stop": str(px(order.stop_price)) if order.stop_price is not None else None,
        "target": str(px(order.target_price)) if order.target_price is not None else None,
        "protective": protective, "hold": hold,   # hold: written to wait for the owner, whatever the automatic box allows
        "checked": {"at": now_iso(), "notes": result["notes"],
                    "facts": {k: facts.get(k) for k in ("reference_price", "distance_pct", "est_fees", "buying_power", "held",
                                                        "min_price", "max_price")}},
    }
    with core.store.transaction():
        core.store.create(_coll(rec["id"][:6]), rec["id"], rec)
        core.audit("propose", "real_order", _summary(rec))
    _note_state(core, [rec, *records], facts.get("profile_id"))
    return _public(rec)


def _close(core: App, id: str, status: str, action: str, *, only_origin: str | None = None) -> dict:
    rec = _get(core, id)
    if rec["status"] != "proposed":
        raise OrderError("This proposal is no longer waiting for a decision.")
    if only_origin and rec["origin"] != only_origin:
        raise OrderError("Only a proposal the assistant wrote can be withdrawn by it.")
    rec.update(status=status, decided_at=now_iso())
    with core.store.transaction():
        _put(core, rec)
        core.audit(action, "real_order", _summary(rec))
    now = cairo_now()
    _note_state(core, _records(core, now))
    return _public(rec)


def discard(core: App, rec: dict, why: str) -> None:
    """Close a proposal the automation wrote for itself and did not send. Nothing went to the broker."""
    if rec["status"] != "proposed" or rec["origin"] != "automation":
        return
    rec.update(status="failed", status_note=why, decided_at=now_iso())
    with core.store.transaction():
        _put(core, rec)
        core.audit("drop", "real_order", _summary(rec))


def note_auto(core: App, rec: dict, why: str) -> None:
    """Write on a waiting proposal that the automation tried to send it and why it could not. It still waits."""
    rec["auto"] = {"at": now_iso(), "n": int((rec.get("auto") or {}).get("n") or 0) + 1, "why": why[:400]}
    _put(core, rec)


def decline(core: App, id: str) -> dict:
    _owner(core)
    return _close(core, id, "declined", "decline")


def withdraw(core: App, id: str) -> dict:
    """The assistant takes back a proposal of its own that it no longer stands behind."""
    _owner(core)
    return _close(core, id, "withdrawn", "withdraw", only_origin="assistant")


# ---- sending ----------------------------------------------------------------------------
class ApproveIn(BaseModel):
    """What the owner saw when they approved: it must be what is stored, or nothing is sent."""
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(min_length=1, max_length=12)
    side: Literal["BUY", "SELL"]
    qty: int = Field(gt=0)
    price: Decimal = Field(gt=0)


def approve(core: App, id: str, seen: ApproveIn) -> dict:
    """The owner's yes. Checks everything once more with fresh figures, then sends the order to the broker, once."""
    _owner(core)
    with _approving:
        return _approve(core, id, seen)


def send_waiting(core: App, id: str, gate, touch: tuple = ()) -> dict:
    """Send a waiting proposal on the owner's standing approval instead of their yes to this one.

    Called from real_auto.py only, and only for what the owner's automatic box allows: `gate` is that box,
    asked once more at the last moment with the records as they are now. Everything the owner's own yes goes
    through applies here too: the same checks, the same day lock, the same single request to the broker.

    `touch` names documents the approval is tied to (the owner's switches): they are written back unchanged
    together with the approval, so the database refuses the whole of it if one of them changed since it was
    read. A stop the owner pressed while this was being checked therefore wins.
    """
    _owner(core)
    with _approving:
        # Everything is read again from the database for this one order, the day's lock first: a look that sends
        # several orders must judge each against what is true at that moment, not at the moment the look began.
        core.store.fresh()
        return _approve(core, id, None, by="auto", gate=gate, touch=touch)


def _approve(core: App, id: str, seen: ApproveIn | None, *, by: str = "owner", gate=None, touch: tuple = ()) -> dict:
    now = cairo_now()
    today = now.date().isoformat()
    # Read first, write last: the day's lock and the records are read before any check is made, and the
    # database refuses the write below if either changed in between. So an approval that slipped in while
    # this one was being checked makes this one fail, to be judged again against what is true now.
    lock = core.store.get("real_days", today) or {"n": 0}
    tied = [(key, core.store.get(*key)) for key in touch]
    rec, records = _with_others(core, id, now)
    if rec["status"] != "proposed":
        raise OrderError("This proposal is no longer waiting for a decision.")
    if _over(rec["session"], now):
        raise OrderError("This proposal was for a session that has ended. Prepare it again with today's price.")
    if seen is not None:   # a person approved it: it must be what they were looking at
        try:
            same = (seen.symbol.strip().upper(), seen.side, seen.qty, px(seen.price)) == \
                   (rec["symbol"], rec["side"], rec["qty"], px(Decimal(str(rec["price"]))))
        except InvalidOperation:
            same = False
        if not same:
            raise ConflictError("this proposal is not the one that was on screen; look at it again")
    if gate is not None:   # no person approved it: the owner's automatic box must allow it, as things stand now
        refused = gate(rec, records)
        if refused:
            raise OrderError(" ".join(refused))
    result = examine(core, _as_order(rec), records, now, sending=True, apart_from=id, protective=bool(rec.get("protective")))
    if not result["ok"]:
        raise OrderError(" ".join(result["problems"]))
    profile_id = result["facts"]["profile_id"]
    # What the broker lists before this order exists. Should the outcome be lost, only an order that is NOT
    # among these can be taken for this one. If the list cannot be read now, nothing is ever taken for it.
    try:
        _forget_list(core)
        before = sorted(o["order_id"] for o in _broker_list(core, profile_id))[-500:]
    except YounitError:
        before = None

    # The yes is recorded before the request goes out, together with the day's lock: of two approvals at
    # the same moment, the database lets one through and refuses the other. Nothing has been sent yet,
    # so a refusal here (409) truly means "nothing was sent".
    rec.update(status="sending", approved_at=now_iso(), sent_day=today, decided_at=now_iso(), approved_by=by,
               broker={"profile_id": profile_id, "order_id": None, "status": None, "state": None, "executed_qty": 0,
                       "average": None, "seen_at": None, "before": before})
    for key, doc in tied:   # where the database cannot refuse a stale write by itself, the comparison is made here
        if core.store.get(*key) != doc:
            raise ConflictError("a switch was changed while this order was being checked; nothing was sent")
    with core.store.transaction():
        core.store.put("real_days", today, {"n": lock["n"] + 1})
        for key, doc in tied:
            if doc is not None:
                core.store.put(*key, doc)   # unchanged: written only so that a change made meanwhile refuses all of this
        _put(core, rec)
        core.audit("approve", "real_order", _summary(rec))

    try:
        order_id = core.younit.place_limit_order(profile_id=profile_id, stock_id=rec["stock_id"], side=rec["side"],
                                                 qty=rec["qty"], price=float(rec["price"]))
    except OrderRefused as exc:
        rec.update(status="rejected", status_note=str(exc))
    except OrderUncertain as exc:
        rec.update(status="unknown", status_note=f"{exc}. It may or may not have been placed: it has not been sent again.")
    except YounitError as exc:
        rec.update(status="failed", status_note=str(exc))
    else:
        rec.update(status="sent", sent_at=now_iso())
        rec["broker"].update(order_id=order_id, state="open")
    # From here on the request has been made. Whatever happens below, the answer returned is what became of
    # it: a failure to write it down is never reported as "nothing was sent".
    written = _finish(core, rec)
    broker.forget(core)   # the account has just changed, or may have
    _forget_list(core)
    try:
        if rec["status"] == "sent" and written:
            _sync(core, records, now)   # the broker's first word on it, if it is already listed
        _note_state(core, records, profile_id)
    except Exception:  # noqa: BLE001 - the order's outcome must reach the owner whatever else goes wrong
        log.exception("real order %s: follow-up after sending failed", rec["id"])
    out = _public(rec)
    if not written:
        out["status_note"] = ((out["status_note"] + " ") if out["status_note"] else "") + \
            "This outcome could not be written to the record just now; the list below will catch up with the broker."
    return out


def _finish(core: App, rec: dict) -> bool:
    """Write down what became of a request to the broker. Returns whether the record now holds it.

    The record is written on its own, so nothing else can hold it back, and tried several times. It
    never raises: by now the request has been made, and the caller must be able to say what became of it.
    If it cannot be written, the record stays at "sending" and is settled from the broker's list later.
    """
    action = {"sent": "send", "rejected": "reject", "failed": "fail", "unknown": "doubt"}.get(rec["status"], "update")
    written = False
    for _ in range(4):
        try:
            _put(core, rec)
            written = True
            break
        except ConflictError:
            try:
                core.store.get(_coll(rec["id"][:6]), rec["id"])   # take the current version, then write over it
            except Exception:  # noqa: BLE001
                log.exception("real order %s: could not re-read the record", rec["id"])
        except Exception:  # noqa: BLE001
            log.exception("real order %s: could not write the outcome (%s)", rec["id"], rec["status"])
            time.sleep(0.3)
    for _ in range(3):   # the activity log is shared with everything else the app does: a collision is tried again
        try:
            core.audit(action, "real_order", _summary(rec))
            break
        except ConflictError:
            continue
        except Exception:  # noqa: BLE001
            log.exception("real order %s: could not write the activity log", rec["id"])
            break
    return written


def cancel(core: App, id: str) -> dict:
    """Ask the broker to cancel an order of ours that is still open. Allowed whatever the switches say: it only reduces what is at stake."""
    _owner(core)
    now = cairo_now()
    rec, records = _with_others(core, id, now)
    _sync(core, records, now)
    if rec["status"] != "sent" or rec["broker"].get("state") not in OPEN_STATES:
        raise OrderError("Only an order that is still open at the broker can be cancelled.")
    try:
        core.younit.cancel_order(rec["broker"]["order_id"], rec["broker"]["profile_id"])
        outcome = "accepted"
    except OrderRefused as exc:
        raise OrderError(f"The broker did not cancel it: {exc}") from None
    except OrderUncertain as exc:
        outcome = f"no clear answer ({exc})"
    rec["cancel"] = {"asked_at": now_iso(), "outcome": outcome}
    with core.store.transaction():
        _put(core, rec)
        core.audit("cancel", "real_order", {**_summary(rec), "outcome": outcome})
    _forget_list(core)
    broker.forget(core)
    _sync(core, records, now)
    return _public(rec)


def not_placed(core: App, id: str) -> dict:
    """The owner looked at the broker's own app and the doubtful order is not there: close it."""
    _owner(core)
    now = cairo_now()
    rec, records = _with_others(core, id, now)
    problem = _sync(core, records, now)
    if rec["status"] not in ("unknown", "sending"):
        raise OrderError("This order is not in doubt." if rec["status"] != "sent" else
                         "It was found in the broker's list: it was placed. Nothing was changed.")
    if rec["status"] == "sending":
        raise OrderError("This order is being sent right now. Look again in a moment.")
    if problem:
        raise OrderError("The broker's order list could not be read just now, so the app could not look for this order "
                         "itself. Try again in a moment.")
    rec.update(status="not_placed", status_note="Checked by the owner at the broker: it was not placed.")
    with core.store.transaction():
        _put(core, rec)
        core.audit("settle", "real_order", _summary(rec))
    return _public(rec)


# ---- what the broker says became of them ------------------------------------------------
def _age(stamp: str | None) -> float:
    try:
        return (datetime.fromisoformat(now_iso()) - datetime.fromisoformat(stamp)).total_seconds()
    except (TypeError, ValueError):
        return float("inf")


def _state(row: dict, qty: int) -> str:
    """The broker's word for an order, read as one of a few states.

    Only a word that plainly says the order is over ends it. A word in between ("pending cancel", "cancel
    rejected") or an unfamiliar one leaves it open, and the word itself is always shown beside the state.
    """
    word = (row.get("status") or "").lower()
    done = row.get("executed_qty", 0)
    waiting = any(w in word for w in ("pending", "request", "wait", "process", "new"))
    if qty and done >= qty:
        return "filled"
    if not waiting:
        if row.get("rejected") or ("reject" in word and "cancel" not in word):
            return "rejected"
        if "cancel" in word and "reject" not in word and "not" not in word:
            return "cancelled"
        if "expire" in word:
            return "expired"
        if ("execut" in word or "fill" in word) and "not" not in word and "partial" not in word and not done:
            return "filled"
    return "partial" if done > 0 or "partial" in word else "open"


def _forget_list(core: App) -> None:
    with _lists_lock:
        _lists.pop(core.younit, None)


def _broker_list(core: App, profile_id: int) -> list[dict]:
    with _lists_lock:
        cached = _lists.get(core.younit)
        if cached and cached[1] == profile_id and time.monotonic() - cached[0] < LIST_SECONDS:
            return cached[2]
        rows = core.younit.orders(profile_id)
        _lists[core.younit] = (time.monotonic(), profile_id, rows)
        return rows


def reset() -> None:
    """Forget what the broker last listed (tests)."""
    with _lists_lock:
        _lists.clear()


def _store_change(core: App, rec: dict, action: str | None) -> None:
    """Write a record the broker's lists changed. Another window doing the same at the same moment is not a problem."""
    try:
        with core.store.transaction():
            _put(core, rec)
            if action:
                core.audit(action, "real_order", _summary(rec))
    except ConflictError:
        pass


def _sync(core: App, records: list[dict], now: datetime) -> str | None:
    """Bring the records up to date with the broker's lists. Returns a message when the broker could not be asked."""
    today = now.date().isoformat()
    # A send that never reported back is in doubt. That is true whether or not the broker can be asked now.
    for rec in records:
        if rec["status"] == "sending" and _age(rec.get("approved_at")) > STALE_SENDING_SECONDS:
            rec.update(status="unknown", status_note="The app was interrupted while sending this order. "
                                                     "It may or may not have been placed: it has not been sent again.")
            _store_change(core, rec, "doubt")
    # Followed: everything in doubt, and every order sent today or still open, whatever state it was last read
    # as. So a state read wrongly from an unfamiliar word puts itself right at the next look.
    live = [r for r in records if r["status"] == "unknown"
            or (r["status"] == "sent" and (r.get("sent_day") == today or r["broker"].get("state") in (None, *OPEN_STATES)))]
    profile_id = next((r["broker"]["profile_id"] for r in live if r.get("broker", {}).get("profile_id")), None)
    if not live or profile_id is None:
        return None
    try:
        rows = _broker_list(core, profile_id)
        history = None
        taken = {r["broker"]["order_id"] for r in records if r.get("broker", {}).get("order_id")}
        for rec in live:
            before = (rec["status"], {k: v for k, v in rec["broker"].items() if k != "seen_at"}, rec.get("status_note"))
            if rec["status"] == "unknown":
                # Was it placed after all? Only an order that fits exactly, belongs to no other record, and was not
                # at the broker before this one was sent can be it. Without that earlier list, nothing is taken for it.
                earlier = rec["broker"].get("before")
                fits = [] if earlier is None else [
                    o for o in rows if o["order_id"] not in taken and o["order_id"] not in earlier
                    and o["stock_id"] == rec["stock_id"] and o["side"] == rec["side"] and o["qty"] == rec["qty"]
                    and o["price"] is not None and abs(o["price"] - float(rec["price"])) < 0.0005]
                if len(fits) != 1:
                    continue
                rec.update(status="sent", sent_at=rec.get("approved_at"),
                           status_note="Found in the broker's list: an order just like it, which was not there before, so it was placed.")
                rec["broker"]["order_id"] = fits[0]["order_id"]
                taken.add(fits[0]["order_id"])
            row = next((o for o in rows if o["order_id"] == rec["broker"]["order_id"]), None)
            if row is None and rec["broker"].get("state") in (None, *OPEN_STATES):   # gone from the current list: how did it end?
                if history is None:
                    history = core.younit.order_history(profile_id)
                row = next((o for o in history if o["order_id"] == rec["broker"]["order_id"]), None)
            if row is not None:
                rec["broker"].update(status=row["status"], state=_state(row, rec["qty"]), executed_qty=row["executed_qty"],
                                     average=row["average"])
                if row.get("reject_reason"):
                    rec["status_note"] = row["reject_reason"]
            elif rec["sent_day"] < today and rec["broker"].get("state") in (None, *OPEN_STATES):
                # a day order from an earlier day that the broker no longer lists anywhere
                rec["broker"]["state"] = "ended"
            after = (rec["status"], {k: v for k, v in rec["broker"].items() if k != "seen_at"}, rec.get("status_note"))
            if after != before:
                rec["broker"]["seen_at"] = now_iso()
                _store_change(core, rec, "settle" if rec["status"] != before[0] else None)
    except YounitError as exc:
        return f"The broker's order list could not be read just now ({exc}). The states shown are the last ones seen."
    return None


# ---- what the screens and the assistant see ---------------------------------------------
def _public(rec: dict) -> dict:
    out = {k: rec.get(k) for k in ("id", "created_at", "session", "origin", "chat", "symbol", "name", "side", "qty", "reason",
                                   "status", "status_note", "sent_at", "decided_at", "checked", "cancel")}
    out.update(price=float(rec["price"]), value=float(rec["value"]),
               stop=float(rec["stop"]) if rec.get("stop") else None, target=float(rec["target"]) if rec.get("target") else None,
               approved_by=rec.get("approved_by"), protective=bool(rec.get("protective")), hold=bool(rec.get("hold")),
               auto=rec.get("auto"), auto_ok=bool(rec.get("auto_ok")), of_book=bool(rec.get("of_book")))
    b = rec.get("broker") or {}
    out["broker"] = {k: b.get(k) for k in ("order_id", "status", "state", "executed_qty", "average", "seen_at")} if b else None
    out["can_cancel"] = rec["status"] == "sent" and b.get("state") in OPEN_STATES
    out["in_doubt"] = rec["status"] in ("unknown", "sending")
    return clean(out)


def view(core: App) -> dict:
    """Everything about real orders for the owner: the switches, the limits and today's use of them, what waits, what was sent."""
    _owner(core)
    now = cairo_now()
    records = _records(core, now)
    for rec in records:
        if rec["status"] == "proposed" and _over(rec["session"], now):
            rec.update(status="expired", decided_at=now_iso())
            try:
                with core.store.transaction():
                    _put(core, rec)
                    core.audit("expire", "real_order", _summary(rec))
            except ConflictError:
                pass
    problem = _sync(core, records, now)
    _note_state(core, records)
    chosen = limits(core)
    count, used = _used_today(records, now.date().isoformat())
    return clean({
        **readiness(core, chosen), "limits": chosen, "market_open": market_open(now), "session": _session(now),
        "today": {"orders": count, "value": money(used)}, "sync_problem": problem,
        "waiting": [_public(r) for r in records if r["status"] == "proposed"],
        "orders": [_public(r) for r in records if r["status"] != "proposed"][:60],
    })
