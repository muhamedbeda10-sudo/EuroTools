"""Automatic real orders: the owner's standing approval, inside a box, while their app is open.

The third step towards real trading. Until now an order went to the broker only when the owner
approved that order. Here the owner may approve in advance: a proposal the assistant writes is sent
without waiting for them, provided it fits a box they drew. Nothing else changes. The order goes
through the very same checks, lock and single request as an order the owner approved by hand
(`real_orders.send_waiting`), and whatever does not fit the box simply waits for the owner as before.

The box (Settings → Real trading → Automatic orders)
    * the stocks it may trade, named one by one: there is no "any stock";
    * the most for one automatic order, and the most automatic buys in a day;
    * a budget: the most the automation may have in the market at once, counting the shares it holds
      at what they cost and its buy orders that are still open. What it has lost so far comes off the
      budget, so the budget is also the most it can ever lose;
    * every buy must carry a stop-loss, no further under its price than the owner allows;
    * it sells only shares it bought itself: the rest of the account is not its to touch;
    * a stock the app sold at its stop-loss or take-profit is not bought again by it the same day;
    * when it is down by more than the owner allows, it stops buying for the day (it can still sell).

It cannot be switched on before it is earned
    Automatic sending rests on the path a hand-approved order takes. So the switch stays locked until
    that path has worked for real: three orders the owner approved were accepted by the broker, and at
    least one of them was filled.

Only while the app is open
    Nothing here runs by itself on the server. The owner's open app asks for a look (`tick`) twice a
    minute during the session; each look follows the fills, carries out stop-losses and take-profits
    that were reached, and sends the proposals that fit the box. Close the app, lock the phone or switch
    the automation off, and it all stops: no new order, and no stop-loss either, until it runs again.

What a stop-loss here can and cannot do
    It is watched by the app, not left at the broker. When the live price reaches it, the app sends a
    sale priced a few levels into the bids, so that it fills; one that does not fill is cancelled and
    priced again. Shares the broker does not yet show as free to sell cannot be sold that way; the stop
    waits until it does. On EGX that is usually two sessions after the purchase, so the stop on a fresh
    purchase may not be able to act at once. After several failed attempts in a day the app stops trying
    and says so.

The automation's own book
    What the automation holds is kept apart (`settings/real_auto_book`), built from the fills of the
    orders it sent, and corrected downwards when the broker shows fewer shares than it thinks it has.
    Figures in it are before the broker's fees.
"""
from __future__ import annotations

import copy
import threading
from datetime import UTC, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import broker, real_orders
from .data.calendar import cairo_now, market_open
from .data.younit import YounitError
from .domain.money import ZERO, D, money, px
from .real_orders import COUNTED, OPEN_STATES, OrderError, OrderIn
from .services import App, NotFound, clean, now_iso
from .store.errors import ConflictError

SETTINGS = ("settings", "real_auto")
BOOK = ("settings", "real_auto_book")
PROOF_SENT, PROOF_FILLED = 3, 1   # owner-approved orders the broker accepted, and how many of them filled
MAX_SYMBOLS = 20
SENDS_PER_LOOK = 2                # proposals sent in one look; the rest go at the next, half a minute later
EXITS_PER_LOOK = 3                # ways out started in one look
EXIT_PATIENCE_SECONDS = 90.0      # a way-out order still unfilled after this is cancelled and priced afresh
EXIT_RETRY_SECONDS = 60.0         # between two attempts to get out of the same position
MAX_EXIT_TRIES = 6                # attempts to get out of one position in a day; then the owner is told to do it
CLAIM_SECONDS = 120.0             # a look that died while getting out of a position is forgotten after this
SETTLING_SECONDS = 600.0          # after a fill, the broker's holdings are given this long to show it
LIVE_SECONDS = 90.0               # a live price older than this is not acted on
BID_LEVELS = 5                    # how deep into the bids a way-out sale is priced
AUTO_RETRY_SECONDS = 300.0        # a proposal the last look could not send is tried again after this
MAX_AUTO_TRIES = 6                # and at most this many times; then it waits for the owner like any other

_looking = threading.Lock()       # one look at a time in this process; the database guards the rest


class _Busy(Exception):
    """Someone else changed the automation's book at the same moment: this look stops, the next starts afresh."""


# ---- the box ----------------------------------------------------------------------------
class AutoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    budget: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))
    max_order_value: Decimal | None = Field(default=None, gt=0, le=Decimal("100000000"))
    max_day_buys: int | None = Field(default=None, ge=1, le=50)
    max_loss: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))
    max_stop_pct: Decimal = Field(default=Decimal("8"), ge=Decimal("0.5"), le=Decimal("20"))
    symbols: list[str] = Field(default_factory=list, max_length=MAX_SYMBOLS)


class LevelsIn(BaseModel):
    """The levels one position of the automation's is watched by. It always has a stop-loss."""
    model_config = ConfigDict(extra="forbid")

    stop_price: Decimal = Field(gt=0, le=Decimal("10000000"))
    target_price: Decimal | None = Field(default=None, gt=0, le=Decimal("10000000"))


def chosen(core: App) -> dict:
    """The owner's box. Anything unreadable there counts as "off"."""
    saved = core.store.get(*SETTINGS) or {}
    try:
        box = AutoIn.model_validate({k: saved[k] for k in AutoIn.model_fields if k in saved}).model_dump(mode="json")
    except ValidationError:
        box = AutoIn().model_dump(mode="json")
    # Since when it has been on. Only what the assistant wrote after that moment is sent without the owner:
    # of anything written earlier it said "this waits for you", and that stays true.
    return {**box, "enabled_at": saved.get("enabled_at") if box["enabled"] else None}


def _stamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _before(stamp: str | None, other: str | None) -> bool:
    try:
        return datetime.fromisoformat(stamp) < datetime.fromisoformat(other)
    except (TypeError, ValueError):
        return True   # a time that cannot be read is not taken on trust


def _complete(box: dict) -> bool:
    return None not in (box["budget"], box["max_order_value"], box["max_day_buys"], box["max_loss"]) and bool(box["symbols"])


# ---- the book: what the automation holds, and what it has earned -------------------------
def _book(core: App) -> dict:
    saved = copy.deepcopy(core.store.get(*BOOK) or {})
    proof = saved.get("proof") or {}
    return {"rev": int(saved.get("rev") or 0), "proven_at": saved.get("proven_at"),
            "proof": {"sent": list(proof.get("sent") or []), "filled": list(proof.get("filled") or [])},
            "positions": saved.get("positions") or {}, "days": saved.get("days") or {},
            "realized": str(saved.get("realized") or "0"), "paused": saved.get("paused")}


def _keep(core: App, bk: dict) -> None:
    """Write the book, but only over the book this look started from.

    The database refuses a write over a document that changed since it was read. The count kept in the
    book says the same in the book's own terms, so it holds even where the database cannot tell.
    """
    stored = core.store.get(*BOOK) or {}
    if int(stored.get("rev") or 0) != bk["rev"]:
        raise _Busy
    bk["rev"] += 1
    bk["days"] = dict(sorted(bk["days"].items())[-15:])
    core.store.put(*BOOK, copy.deepcopy(bk))


def _earned(records: list[dict], bk: dict) -> dict:
    """Whether the hand-approved path has worked for real. Once it has, that stays true."""
    by_hand = {r["id"]: r for r in records if r.get("approved_by", "owner") == "owner"}

    def accepted(r: dict) -> bool:
        return r["status"] == "sent" and (r.get("broker") or {}).get("state") != "rejected"
    sent = sorted((set(bk["proof"]["sent"]) - set(by_hand)) | {i for i, r in by_hand.items() if accepted(r)})
    filled = sorted((set(bk["proof"]["filled"]) - set(by_hand))
                    | {i for i, r in by_hand.items() if accepted(r) and int((r.get("broker") or {}).get("executed_qty") or 0) > 0})
    proven = bool(bk["proven_at"]) or (len(sent) >= PROOF_SENT and len(filled) >= PROOF_FILLED)
    return {"proven": proven, "sent": len(sent), "filled": len(filled), "needed_sent": PROOF_SENT,
            "needed_filled": PROOF_FILLED, "ids": (sent[-30:], filled[-30:])}


def _note_proof(core: App, bk: dict, records: list[dict]) -> None:
    """Keep what has been earned so far: the records it is read from are looked at one month at a time."""
    if bk["proven_at"]:
        return
    earned = _earned(records, bk)
    sent, filled = earned["ids"]
    if (sent, filled) == (bk["proof"]["sent"], bk["proof"]["filled"]) and not earned["proven"]:
        return
    bk["proof"] = {"sent": sent, "filled": filled}
    with core.store.transaction():
        if earned["proven"]:
            bk["proven_at"] = now_iso()
            core.audit("earn", "real_auto", {"accepted": earned["sent"], "filled": earned["filled"]})
        _keep(core, bk)


def standing(core: App, box: dict, bk: dict, records: list[dict]) -> dict:
    """Whether the automation may act at all right now, and if not, the one reason. Writes nothing."""
    earned = {k: v for k, v in _earned(records, bk).items() if k != "ids"}
    ready = real_orders.readiness(core)
    why = None
    if not ready["ready"]:
        why = ready["why_not"]
    elif not box["enabled"]:
        why = "Automatic orders are switched off in Settings → Real trading."
    elif not _complete(box):
        why = ("The automatic box is not complete: the budget, the limit per order, the buys per day, the loss at which "
               "it pauses, and the stocks it may trade.")
    elif not earned["proven"]:
        why = (f"Automatic orders unlock after {PROOF_SENT} orders you approved yourself were accepted by the broker and "
               f"at least {PROOF_FILLED} of them filled. So far: {earned['sent']} accepted, {earned['filled']} filled.")
    return {"on": why is None, "why_not": why, "proof": earned}


def menu(core: App) -> bool:
    """For the open app: whether to ask for looks at all. One small read; the look itself checks everything."""
    return bool(core.younit is not None and core.real_account_allowed and chosen(core)["enabled"])


def save(core: App, body: AutoIn) -> dict:
    real_orders._owner(core)
    symbols = sorted({s.strip().upper() for s in body.symbols if s.strip()})
    unknown = [s for s in symbols if core.market.instrument(s) is None]
    if unknown:
        raise OrderError(f"Not in the app's stock list: {', '.join(unknown[:10])}.")
    if body.budget is not None and body.max_order_value is not None and body.budget < body.max_order_value:
        raise OrderError("The budget cannot be smaller than the most allowed for one automatic order.")
    if body.budget is not None and body.max_loss is not None and body.max_loss > body.budget:
        raise OrderError("The loss at which it pauses cannot be larger than the budget.")
    before = chosen(core)
    after = {**body.model_dump(mode="json"), "symbols": symbols,
             "enabled_at": (before["enabled_at"] or _stamp()) if body.enabled else None}
    if body.enabled:
        hand = real_orders.limits(core)
        state = standing(core, after, _book(core), real_orders._records(core, cairo_now()))
        if state["why_not"]:
            raise OrderError(state["why_not"])
        if body.max_order_value > D(hand["max_order_value"]):
            raise OrderError("An automatic order cannot be allowed more than an order you approve yourself "
                             f"({D(hand['max_order_value']):,.2f}).")
        outside = [s for s in symbols if hand["symbols"] and s not in hand["symbols"]]
        if outside:
            raise OrderError(f"Not among the stocks you allow for real orders at all: {', '.join(outside)}.")
    with core.store.transaction():
        core.store.put(*SETTINGS, after)
        core.audit("update", "real_auto_settings", {"before": before, "after": after})
    return view(core)


def stop(core: App) -> dict:
    """The one-tap stop. Always allowed: it only reduces what is at stake.

    No further automatic order is sent, and the automation's buy orders still open at the broker are
    cancelled. What it already holds stays in the account, and is no longer watched.
    """
    real_orders._owner(core)
    box = chosen(core)
    if box["enabled"]:
        with core.store.transaction():
            core.store.put(*SETTINGS, {**box, "enabled": False, "enabled_at": None})
            core.audit("stop", "real_auto", {"holding": sorted(_book(core)["positions"])})
    notes = []
    for rec in real_orders._records(core, cairo_now()):
        if _automatic(rec) and rec["side"] == "BUY" and rec["status"] == "sent" and (rec.get("broker") or {}).get("state") in OPEN_STATES:
            try:
                real_orders.cancel(core, rec["id"])
                notes.append(f"Asked the broker to cancel the open buy of {rec['qty']:,} {rec['symbol']}.")
            except OrderError:
                pass   # it is no longer open
            except (YounitError, ConflictError) as exc:
                notes.append(f"The open buy of {rec['qty']:,} {rec['symbol']} could not be cancelled ({exc}). "
                             "Cancel it on the Real account page.")
    return {**view(core), "stop_notes": notes}


def set_levels(core: App, symbol: str, body: LevelsIn) -> dict:
    """The owner moves the stop-loss or the take-profit of a position the automation holds."""
    real_orders._owner(core)
    symbol = symbol.strip().upper()
    bk = _book(core)
    pos = bk["positions"].get(symbol)
    if pos is None:
        raise NotFound(f"the automation holds no {symbol}")
    if body.target_price is not None and body.target_price <= body.stop_price:
        raise OrderError("The take-profit must be above the stop-loss.")
    before = {"stop": pos.get("stop"), "target": pos.get("target")}
    pos.update(stop=str(px(body.stop_price)), target=str(px(body.target_price)) if body.target_price is not None else None,
               tries=None)
    try:
        with core.store.transaction():
            _keep(core, bk)
            core.audit("levels", "real_auto", {"symbol": symbol, "before": before,
                                               "after": {"stop": pos["stop"], "target": pos["target"]}})
    except _Busy:
        raise ConflictError("the automation changed this position at the same moment; look again") from None
    return view(core)


# ---- what its orders did to the book ----------------------------------------------------
def _automatic(rec: dict) -> bool:
    return rec.get("approved_by") == "auto"


def _active_sale(rec: dict) -> bool:
    """A sale of the automation's that is waiting, on its way, in doubt, or still open at the broker."""
    if rec["side"] != "SELL" or not (_automatic(rec) or rec["origin"] == "automation"):
        return False
    return rec["status"] in ("proposed", "sending", "unknown") or (
        rec["status"] == "sent" and (rec.get("broker") or {}).get("state") in (None, *OPEN_STATES))


def _pending_buy_value(rec: dict) -> Decimal:
    """What an automatic buy may still put into the market, beyond what the book already counts."""
    if rec["side"] != "BUY" or not _automatic(rec):
        return ZERO
    if rec["status"] in ("sending", "unknown"):
        return D(rec["value"])
    if rec["status"] != "sent":
        return ZERO
    b = rec.get("broker") or {}
    reach = rec["qty"] if b.get("state") in (None, *OPEN_STATES) else int(b.get("executed_qty") or 0)
    return money(D(rec["price"]) * max(reach - int((rec.get("applied") or {}).get("qty") or 0), 0))


def _exposure(bk: dict, records: list[dict]) -> Decimal:
    return money(sum((D(p["cost"]) for p in bk["positions"].values()), ZERO) + sum((_pending_buy_value(r) for r in records), ZERO))


def _room(box: dict, bk: dict) -> Decimal:
    """What is left of the budget: the budget, less what the automation has lost so far."""
    return max(D(box["budget"]) + min(D(bk["realized"]), ZERO), ZERO)


def _apply_fills(core: App, records: list[dict], bk: dict, today: str) -> list[str]:
    """Bring the book up to date with what the broker filled of the automation's orders. Each fill is counted once."""
    notes = []
    for rec in records:
        if not _automatic(rec) or rec["status"] != "sent":
            continue
        b = rec.get("broker") or {}
        done = int(b.get("executed_qty") or 0)
        seen = rec.get("applied") or {"qty": 0, "amount": "0"}
        if done <= seen["qty"]:
            continue
        amount = money(D(str(b["average"])) * done) if b.get("average") else money(D(rec["price"]) * done)
        qty, cash = done - seen["qty"], amount - D(seen["amount"])
        symbol, positions = rec["symbol"], bk["positions"]
        if rec["side"] == "BUY":
            pos = positions.setdefault(symbol, {"qty": 0, "cost": "0", "stop": None, "target": None, "since": now_iso(),
                                                "stock_id": rec["stock_id"], "exit": None, "tries": None})
            pos.update(qty=pos["qty"] + qty, cost=str(money(D(pos["cost"]) + cash)), touched=now_iso())
            if rec.get("stop") and seen["qty"] == 0:
                # An order's levels are taken once, at its first fill, so a level the owner moved since is not put
                # back by the rest of the same order. A later buy may raise the position's stop, never lower it:
                # only the owner moves a stop down.
                if pos.get("stop") is None or D(rec["stop"]) > D(pos["stop"]):
                    pos["stop"] = rec["stop"]
                if rec.get("target"):
                    pos["target"] = rec["target"]
        elif symbol in positions:
            pos = positions[symbol]
            sold = min(qty, pos["qty"])
            basis = money(D(pos["cost"]) * sold / pos["qty"]) if pos["qty"] else ZERO
            gain = money(cash * sold / qty) - basis
            day = bk["days"].setdefault(today, {"realized": "0"})
            day["realized"] = str(money(D(day["realized"]) + gain))
            bk["realized"] = str(money(D(bk["realized"]) + gain))
            pos.update(qty=pos["qty"] - sold, cost=str(money(D(pos["cost"]) - basis)), touched=now_iso())
            if pos["qty"] <= 0:
                del positions[symbol]
        rec["applied"] = {"qty": done, "amount": str(amount)}
        with core.store.transaction():   # the fill and the book change together, or not at all
            real_orders._put(core, rec)
            _keep(core, bk)
        notes.append(f"{'Bought' if rec['side'] == 'BUY' else 'Sold'} {qty:,} {symbol} at about {float(cash / qty):g}.")
    return notes


def _sweep(core: App, records: list[dict]) -> None:
    """A sale the automation wrote for itself and never sent (the look died in between) is closed, not left waiting."""
    for rec in records:
        if rec["status"] == "proposed" and rec["origin"] == "automation" and real_orders._age(rec.get("created_at")) > CLAIM_SECONDS:
            real_orders.discard(core, rec, "The app was interrupted before this sale was sent. Nothing was sent.")


def _reconcile(core: App, bk: dict, held: dict) -> list[str]:
    """The broker's holdings are the truth: where it shows fewer shares than the book, the book gives way."""
    notes = []
    for symbol, pos in list(bk["positions"].items()):
        if real_orders._age(pos.get("touched")) < SETTLING_SECONDS:
            continue   # a fill this recent may not show in the broker's holdings yet
        row = held.get(pos.get("stock_id")) or {}
        actual = int(row.get("qty") or 0) + int(row.get("unsettled") or 0)   # the most the account can be holding
        if actual >= pos["qty"]:
            continue
        notes.append(f"The broker shows {actual:,} {symbol}, not the {pos['qty']:,} the automation counted: the rest left the "
                     "account outside it, and is no longer its to watch.")
        if actual <= 0:
            del bk["positions"][symbol]
        else:
            pos.update(cost=str(money(D(pos["cost"]) * actual / pos["qty"])), qty=actual)
    if notes:
        with core.store.transaction():
            _keep(core, bk)
            core.audit("reconcile", "real_auto", {"notes": notes})
    return notes


def _last(core: App, symbol: str) -> float | None:
    known = core._last_price(symbol)
    return float(known[0]) if known else None


def _live(core: App, symbol: str, now: datetime) -> float | None:
    """The price on screen, only when it is from the running session and fresh enough to act on."""
    if not core.market.is_live(symbol):
        return None
    try:
        age = (now - datetime.fromisoformat(core.market.cache.get("live_as_of"))).total_seconds()
    except (TypeError, ValueError):
        return None
    return _last(core, symbol) if age <= LIVE_SECONDS else None


def _result(core: App, bk: dict, today: str, prices: dict | None = None) -> Decimal:
    """How the automation stands today: what today's sales made or lost, and what its holdings are up or down on their cost."""
    open_result = ZERO
    for symbol, pos in bk["positions"].items():
        last = (prices or {}).get(symbol) or _last(core, symbol)
        if last is not None:
            open_result += money(D(str(last)) * pos["qty"]) - D(pos["cost"])
    return money(D((bk["days"].get(today) or {}).get("realized", "0")) + open_result)


# ---- what may be sent without the owner -------------------------------------------------
def judge(rec: dict, records: list[dict], bk: dict, box: dict, today: str) -> list[str]:
    """Why this proposal may not be sent automatically; empty when it may. No call to the broker."""
    if rec["origin"] not in ("assistant", "automation"):
        return ["Only the assistant's proposals are sent automatically; this one waits for you."]
    if rec.get("hold"):
        return ["The assistant wrote it to wait for your own decision."]
    if rec["origin"] == "assistant" and _before(rec.get("created_at"), box.get("enabled_at")):
        return ["It was written before automatic orders were switched on, so it waits for you as it said it would."]
    if rec["side"] == "SELL":
        pos = bk["positions"].get(rec["symbol"])
        others = sum(r["qty"] for r in records if _active_sale(r) and r["symbol"] == rec["symbol"] and r["id"] != rec["id"])
        if pos is None:
            return [f"The automation holds no {rec['symbol']}: it sells only shares it bought itself."]
        if rec["qty"] + others > pos["qty"]:
            return [f"The automation holds {pos['qty']:,} {rec['symbol']}"
                    + (f", {others:,} of them already being sold" if others else "") + f"; this would sell {rec['qty']:,}."]
        return []
    if rec["origin"] != "assistant":
        return ["The app itself never buys: a buy comes from the assistant or from you."]
    out = []
    price, value = D(rec["price"]), D(rec["value"])
    if rec["symbol"] not in box["symbols"]:
        out.append(f"{rec['symbol']} is not among the stocks the automation may trade.")
    if value > D(box["max_order_value"]):
        out.append(f"It is worth {value:,.2f}; an automatic order may be at most {D(box['max_order_value']):,.2f}.")
    if not rec.get("stop"):
        out.append("An automatic buy needs a stop-loss.")
    else:
        gap = (price - D(rec["stop"])) / price * 100
        if gap > D(box["max_stop_pct"]):
            out.append(f"Its stop-loss is {gap:.1f}% under the price; you allow at most {D(box['max_stop_pct']):g}%.")
    paused = bk.get("paused")
    if paused and paused.get("day") == today:
        out.append(f"The automation is not buying for the rest of today: {paused['why']}")
    if any(r["origin"] == "automation" and r["symbol"] == rec["symbol"] and r.get("created_day") == today for r in records):
        out.append(f"The app sold {rec['symbol']} at a stop-loss or take-profit today, or is trying to; "
                   "the automation does not buy it again the same day.")
    buys = sum(1 for r in records if _automatic(r) and r["side"] == "BUY" and r.get("sent_day") == today and r["status"] in COUNTED)
    if buys + 1 > box["max_day_buys"]:
        out.append(f"{buys} automatic buys were already sent today; the limit is {box['max_day_buys']}.")
    used, room = _exposure(bk, records), _room(box, bk)
    if used + value > room:
        out.append(f"The automation has {used:,.2f} in the market; with this it would be {used + value:,.2f}, over the "
                   f"{room:,.2f} left of its budget.")
    return out


# ---- getting out of a position ----------------------------------------------------------
def _exit_price(core: App, symbol: str, pos: dict, last: float, band_pct: float, at_least: float | None) -> Decimal:
    """A price for getting out now: a few levels into the bids, so that it fills.

    Never further under the market than the owner's price band, never under the lowest price the exchange
    takes today, and for a take-profit never under the target. A level of the book is a price the exchange
    is quoting, so it is a valid one to send. Without a readable book, the last traded price is used.
    """
    try:
        allowed = core.younit.trading_limits(pos["stock_id"])
    except YounitError:
        allowed = {}
    reference = allowed.get("last") or last
    floor = max(reference * (1 - max(band_pct - 0.05, 0) / 100), allowed.get("min_price") or 0, at_least or 0)
    try:
        bids = sorted((lv["price"] for lv in core.depth(symbol).get("bids", []) if lv.get("price") and lv["price"] >= floor),
                      reverse=True)
    except (NotFound, YounitError):
        bids = []
    return px(Decimal(str(bids[:BID_LEVELS][-1]))) if bids else px(Decimal(str(max(last, at_least or 0))))


def _way_out(core: App, symbol: str, pos: dict, bk: dict, records: list[dict], box: dict, today: str,
             last: float | None, held: dict | None, band_pct: float) -> tuple[dict | None, str | None]:
    """Carry out a stop-loss or a take-profit that was reached. Returns the order sent, and anything the owner should read."""
    claim = pos.get("exit")
    if claim:
        rec = next((r for r in records if r["id"] == claim.get("order")), None)
        if rec is None:
            if real_orders._age(claim.get("at")) < CLAIM_SECONDS:
                return None, None                     # another look is getting out of it right now
        elif _active_sale(rec):
            if rec["status"] == "unknown":
                return None, (f"The sale of {symbol} may or may not have reached the broker. Settle it on the Real account "
                              "page: until then the app sends no other sale of it.")
            waited = real_orders._age(rec.get("sent_at"))
            if rec["status"] == "sent" and rec["broker"].get("state") in OPEN_STATES and EXIT_PATIENCE_SECONDS < waited < float("inf"):
                try:
                    real_orders.cancel(core, rec["id"])   # not filled at that price: take it back, to be priced afresh
                except (OrderError, YounitError) as exc:
                    return None, f"The unfilled sale of {symbol} could not be cancelled: {exc}"
                return None, f"The sale of {symbol} at {float(rec['price']):g} did not fill; it was cancelled, to be priced again."
            return None, None                         # it is on its way, or resting at the broker
        pos["exit"] = None                            # that attempt is over: look at the position afresh

    stop, target = (float(pos[k]) if pos.get(k) else None for k in ("stop", "target"))
    if stop is None and target is None:
        return None, None
    if last is None:
        return None, f"There is no live price for {symbol} right now, so its stop-loss is not being watched."
    if stop is not None and last <= stop:
        kind, why = "stop-loss", f"Stop-loss: the price reached {last:g}, at or under the stop at {stop:g}."
    elif target is not None and last >= target:
        kind, why = "take-profit", f"Take-profit: the price reached {last:g}, at or over the target at {target:g}."
    else:
        return None, None

    tries = pos.get("tries") if (pos.get("tries") or {}).get("day") == today else {"day": today, "n": 0, "at": None}
    if tries["n"] >= MAX_EXIT_TRIES:
        return None, (f"{symbol} is at its {kind} and {tries['n']} attempts to sell it today did not complete. "
                      "The app has stopped trying: sell it yourself on the Real account page.")
    if real_orders._age(tries["at"]) < EXIT_RETRY_SECONDS:
        return None, None
    if held is None:
        return None, f"{symbol} reached its {kind}, but the broker's holdings could not be read just now."
    selling = sum(r["qty"] for r in records if _active_sale(r) and r["symbol"] == symbol)
    qty = min(pos["qty"] - selling, int((held.get(pos.get("stock_id")) or {}).get("available") or 0))
    if qty <= 0:
        return None, None if selling else (
            f"{symbol} reached its {kind}, but the broker does not show its shares as free to sell yet. "
            "The app sells as soon as it does.")
    price = _exit_price(core, symbol, pos, last, band_pct, target if kind == "take-profit" else None)

    # Claim the way out in the book before anything is written or sent: of two looks at the same moment, one gets it.
    pos["exit"] = {"at": now_iso(), "order": None}
    pos["tries"] = {"day": today, "n": tries["n"] + 1, "at": now_iso()}
    _keep(core, bk)
    try:
        made = real_orders.propose(core, OrderIn(symbol=symbol, side="SELL", qty=qty, price=price, reason=why), "automation",
                                   protective=True)
    except (OrderError, YounitError) as exc:
        pos["exit"] = None
        _keep(core, bk)
        return None, f"The sale of {symbol} at its {kind} could not be prepared: {exc}"
    pos["exit"]["order"] = made["id"]
    _keep(core, bk)
    try:
        return real_orders.send_waiting(core, made["id"], lambda rec, rows: judge(rec, rows, bk, box, today)), None
    except OrderError as exc:   # refused before anything was sent
        real_orders.discard(core, real_orders._get(core, made["id"]), f"Not sent: {exc}")
        pos["exit"] = None
        _keep(core, bk)
        return None, f"The sale of {symbol} at its {kind} was not sent: {exc}"


# ---- one look ---------------------------------------------------------------------------
def tick(core: App) -> dict:
    """One look by the automation. The owner's open app asks for it; it does nothing unless everything allows it."""
    real_orders._owner(core)
    if not _looking.acquire(blocking=False):
        return {"ran": False, "busy": True, "why": "Another look is running."}
    try:
        return _tick(core)
    except (_Busy, ConflictError):
        return {"ran": False, "busy": True, "why": "Another window was working on the same thing; the next look starts afresh."}
    finally:
        _looking.release()


def _tick(core: App) -> dict:
    now = cairo_now()
    today = now.date().isoformat()
    box, bk = chosen(core), _book(core)
    records = real_orders._records(core, now)
    _note_proof(core, bk, records)
    state = standing(core, box, bk, records)
    if not state["on"]:
        return {"ran": False, "why": state["why_not"]}
    if not market_open(now):
        return {"ran": False, "why": "The market is closed.", "market_open": False}
    notes: list[str] = []
    problem = real_orders._sync(core, records, now)
    if problem:
        notes.append(problem)
    notes += _apply_fills(core, records, bk, today)
    _sweep(core, records)
    held = None
    if bk["positions"]:
        try:
            held = {p["stock_id"]: p for p in broker.reading(core)["positions"]}
            notes += _reconcile(core, bk, held)
        except YounitError as exc:
            notes.append(f"The broker's holdings could not be read just now ({exc}).")
    prices = {symbol: _live(core, symbol, now) for symbol in bk["positions"]}

    # the brake: down by more than the owner allows, it buys nothing more today
    result = _result(core, bk, today, prices)
    if result < -D(box["max_loss"]) and (bk.get("paused") or {}).get("day") != today:
        bk["paused"] = {"day": today, "why": f"it is down {-result:,.2f}, more than the {D(box['max_loss']):,.2f} you allow."}
        with core.store.transaction():
            _keep(core, bk)
            core.audit("pause", "real_auto", {"result": str(result), "limit": box["max_loss"]})
        notes.append(f"The automation stopped buying for today: {bk['paused']['why']}")

    # ways out first: a stop-loss matters more than a new purchase
    exits, sent = [], []
    band = float(D(real_orders.limits(core)["price_band_pct"]))
    for symbol in sorted(bk["positions"]):
        if len(exits) >= EXITS_PER_LOOK:
            break
        order, note = _way_out(core, symbol, bk["positions"][symbol], bk, records, box, today, prices.get(symbol), held, band)
        if note:
            notes.append(note)
        if order:
            exits.append(order)
            records = real_orders._records(core, now)

    # then the assistant's proposals that fit the box, oldest first
    waiting = [r for r in records if r["status"] == "proposed" and r["origin"] == "assistant" and not real_orders._over(r["session"], now)]
    for rec in reversed(waiting):
        if len(sent) >= SENDS_PER_LOOK:
            break
        tried = rec.get("auto") or {}
        if tried and (tried.get("n", 0) >= MAX_AUTO_TRIES or real_orders._age(tried.get("at")) < AUTO_RETRY_SECONDS):
            continue
        current = next((r for r in records if r["id"] == rec["id"]), rec)
        if current["status"] != "proposed" or judge(current, records, bk, box, today):
            continue   # it waits for the owner; the page says why
        try:
            done = real_orders.send_waiting(core, rec["id"], lambda r, rows: judge(r, rows, bk, box, today))
        except OrderError as exc:   # refused before anything was sent: it still waits, and says why
            real_orders.note_auto(core, real_orders._get(core, rec["id"]), str(exc))
            notes.append(f"{rec['side']} {rec['qty']:,} {rec['symbol']} was not sent automatically: {exc}")
            continue
        sent.append(done)
        records = real_orders._records(core, now)
    paused = bk.get("paused") if (bk.get("paused") or {}).get("day") == today else None
    return clean({"ran": True, "sent": sent, "exits": exits, "notes": notes[:12], "paused": paused})


# ---- what the screens and the assistant see ---------------------------------------------
def outlook(core: App, id: str) -> dict:
    """Whether one waiting proposal will be sent automatically, and if not, why. For the assistant, right after it wrote one."""
    real_orders._owner(core)
    now = cairo_now()
    box, bk = chosen(core), _book(core)
    records = real_orders._records(core, now)
    state = standing(core, box, bk, records)
    rec = next((r for r in records if r["id"] == id and r["status"] == "proposed"), None)
    if rec is None or not state["on"]:
        return {"will_be_sent_automatically": False, "why_not": [state["why_not"] or "It is not a waiting proposal."]}
    why = judge(rec, records, bk, box, now.date().isoformat())
    return {"will_be_sent_automatically": not why, "why_not": why}


def view(core: App) -> dict:
    """The automation for its owner: the box, whether it is on, what it holds, and what it will do with what waits."""
    real_orders._owner(core)
    now = cairo_now()
    today = now.date().isoformat()
    box, bk = chosen(core), _book(core)
    records = real_orders._records(core, now)
    try:
        _note_proof(core, bk, records)
    except (_Busy, ConflictError):
        pass   # another window wrote it down at the same moment
    state = standing(core, box, bk, records)
    selling = {r["symbol"] for r in records if _active_sale(r)}
    positions = []
    for symbol, pos in sorted(bk["positions"].items()):
        last = _last(core, symbol)
        value = money(D(str(last)) * pos["qty"]) if last is not None else None
        stop, target = (float(pos[k]) if pos.get(k) else None for k in ("stop", "target"))
        tries = pos.get("tries") if (pos.get("tries") or {}).get("day") == today else None
        positions.append({
            "symbol": symbol, "name": (core.market.instrument(symbol) or {}).get("name"), "qty": pos["qty"],
            "cost": D(pos["cost"]), "avg_cost": D(pos["cost"]) / pos["qty"] if pos["qty"] else None,
            "stop": stop, "target": target, "last": last, "value": value,
            "result": value - D(pos["cost"]) if value is not None else None,
            "live": _live(core, symbol, now) is not None, "selling": symbol in selling,
            "at_stop": bool(stop is not None and last is not None and last <= stop),
            "gave_up": bool(tries and tries["n"] >= MAX_EXIT_TRIES), "since": pos.get("since")})
    used = _exposure(bk, records)
    waiting = {}
    if state["on"]:
        for rec in records:
            if rec["status"] == "proposed" and not real_orders._over(rec["session"], now):
                why = judge(rec, records, bk, box, today)
                waiting[rec["id"]] = {"automatic": not why, "why_not": why}
    paused = bk.get("paused") if (bk.get("paused") or {}).get("day") == today else None
    room = _room(box, bk) if box["budget"] else None
    return clean({
        "box": box, "complete": _complete(box), **state, "paused": paused, "market_open": market_open(now),
        "budget": {"limit": D(box["budget"]) if box["budget"] else None, "lost": max(-D(bk["realized"]), ZERO), "room": room,
                   "used": used, "free": max(room - used, ZERO) if room is not None else None},
        "today": {"buys": sum(1 for r in records if _automatic(r) and r["side"] == "BUY" and r.get("sent_day") == today
                              and r["status"] in COUNTED),
                  "realized": D((bk["days"].get(today) or {}).get("realized", "0")), "result": _result(core, bk, today)},
        "realized": D(bk["realized"]), "positions": positions, "waiting": waiting,
    })


def brief(core: App) -> dict:
    """The automation as the assistant needs to know it before it writes a proposal."""
    full = view(core)
    return {"on": full["on"], "why_not": full["why_not"], "box": full["box"], "budget": full["budget"], "today": full["today"],
            "paused": full["paused"],
            "positions": [{k: p[k] for k in ("symbol", "qty", "avg_cost", "stop", "target", "last", "result", "selling")}
                          for p in full["positions"]]}
