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
    * whether a proposal is one it may send is decided once, when the assistant writes it (`admit`):
      one that was told "this waits for the owner" keeps waiting, whatever changes afterwards;
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
    sale priced at the best bid (a few levels into the bids, should the feed ever send them); one that
    does not fill is cancelled and
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
# What an automatic order is tied to: it goes out only if neither of these changed since the look read them.
SWITCHES = (SETTINGS, real_orders.SETTINGS)
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
PRICE_GAP_PCT = 1.5               # the app's price and the broker's own must be this close for a stop to be acted on
BID_LEVELS = 5                    # how deep into the bids a way-out sale is priced
SHORT_LOOKS, SHORT_SECONDS = 3, 120.0   # the broker must show fewer shares at this many looks, over this long, to be believed
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
    # Optional: the most it may buy in one day, in money. Without it, the limit per order times the buys per day bounds it.
    max_day_value: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))
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
            "realized": str(saved.get("realized") or "0"), "paused": saved.get("paused"),
            # how much of each order's fills the book has counted: kept here, where nothing else writes
            "applied": saved.get("applied") or {}}


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
    before = chosen(core)
    symbols = sorted({s.strip().upper() for s in body.symbols if s.strip()})
    unknown = [s for s in symbols if core.market.instrument(s) is None]
    if unknown:
        raise OrderError(f"Not in the app's stock list: {', '.join(unknown[:10])}.")
    if body.budget is not None and body.max_order_value is not None and body.budget < body.max_order_value:
        raise OrderError("The budget cannot be smaller than the most allowed for one automatic order.")
    if body.budget is not None and body.max_loss is not None and body.max_loss > body.budget:
        raise OrderError("The loss at which it pauses cannot be larger than the budget.")
    if body.max_day_value is not None and body.max_order_value is not None and body.max_day_value < body.max_order_value:
        raise OrderError("The most it may buy in one day cannot be smaller than the most allowed for one automatic order.")
    after = {**body.model_dump(mode="json"), "symbols": symbols,
             "enabled_at": (before["enabled_at"] or _stamp()) if body.enabled else None}
    if "max_day_value" not in body.model_fields_set:
        # A page loaded before this limit existed saves the box without naming it: that must not remove it.
        after["max_day_value"] = before.get("max_day_value")
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
        if _automatic(rec) and rec["status"] == "sending":
            # an order that was leaving at that very moment cannot be called back from here
            notes.append(f"An automatic {rec['side'].lower()} of {rec['qty']:,} {rec['symbol']} was being sent as you stopped it. "
                         "Look at it on the Real account page, and cancel it there if it went out.")
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


def _booked(rec: dict) -> bool:
    """Whether the fills of this order move the automation's book.

    A buy does when the automation sent it: one the owner approved by hand is the owner's. A sale does when
    it is a sale of the automation's shares, whoever approved it: the app's own way out, or a sale the
    assistant wrote that the automation's shares could cover when it was written (`of_book`, set in `admit`).
    """
    if rec["side"] == "BUY":
        return _automatic(rec)
    return rec["origin"] == "automation" or bool(rec.get("of_book"))


def _in_flight(rec: dict) -> bool:
    """On its way, in doubt, or still open at the broker."""
    return rec["status"] in ("sending", "unknown") or (
        rec["status"] == "sent" and (rec.get("broker") or {}).get("state") in (None, *OPEN_STATES))


def _active_sale(rec: dict) -> bool:
    """A sale of the automation's shares that is in flight, or that the app wrote for itself and has yet to send."""
    if rec["side"] != "SELL" or not _booked(rec):
        return False
    return _in_flight(rec) or (rec["status"] == "proposed" and rec["origin"] == "automation")


def _applied(bk: dict, rec: dict) -> dict:
    return bk["applied"].get(rec["id"]) or {"qty": 0, "amount": "0"}


def _pending_buy_value(rec: dict, bk: dict) -> Decimal:
    """What an automatic buy may still put into the market, beyond what the book already counts."""
    if rec["side"] != "BUY" or not _automatic(rec):
        return ZERO
    if rec["status"] in ("sending", "unknown"):
        return D(rec["value"])
    if rec["status"] != "sent":
        return ZERO
    b = rec.get("broker") or {}
    reach = rec["qty"] if b.get("state") in (None, *OPEN_STATES) else int(b.get("executed_qty") or 0)
    return money(D(rec["price"]) * max(reach - int(_applied(bk, rec)["qty"]), 0))


def _exposure(bk: dict, records: list[dict]) -> Decimal:
    return money(sum((D(p["cost"]) for p in bk["positions"].values()), ZERO) + sum((_pending_buy_value(r, bk) for r in records), ZERO))


def _room(box: dict, bk: dict) -> Decimal:
    """What is left of the budget: the budget, less what the automation has lost so far."""
    return max(D(box["budget"]) + min(D(bk["realized"]), ZERO), ZERO)


def _apply_fills(core: App, records: list[dict], bk: dict, today: str) -> list[str]:
    """Bring the book up to date with what the broker filled. Each fill is counted once.

    What has been counted of each order is kept in the book itself, not on the order's record: the book is
    written only over the book it was read from, so nothing else that touches the record can undo the count.
    """
    notes = []
    for rec in records:
        if not _booked(rec) or rec["status"] != "sent":
            continue
        b = rec.get("broker") or {}
        done = int(b.get("executed_qty") or 0)
        seen = _applied(bk, rec)
        if done <= seen["qty"]:
            continue
        amount = money(D(str(b["average"])) * done) if b.get("average") else money(D(rec["price"]) * done)
        qty, cash = done - seen["qty"], amount - D(seen["amount"])
        symbol, positions = rec["symbol"], bk["positions"]
        if rec["side"] == "BUY":
            pos = positions.setdefault(symbol, {"qty": 0, "cost": "0", "stop": None, "target": None, "since": now_iso(),
                                                "stock_id": rec["stock_id"], "exit": None, "tries": None, "short": None})
            pos.update(qty=pos["qty"] + qty, cost=str(money(D(pos["cost"]) + cash)), touched=now_iso())
            if rec.get("stop") and (seen["qty"] == 0 or pos.get("stop") is None):
                # An order's levels are taken once, at its first fill, so a level the owner moved since is not put
                # back by the rest of the same order; a position without a stop takes them whenever it can. A later
                # buy may raise the position's stop, never lower it: only the owner moves a stop down.
                if pos.get("stop") is None or D(rec["stop"]) > D(pos["stop"]):
                    pos["stop"] = rec["stop"]
                if rec.get("target") and (seen["qty"] == 0 or pos.get("target") is None):
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
        bk["applied"][rec["id"]] = {"qty": done, "amount": str(amount)}
        _keep(core, bk)
        notes.append(f"{'Bought' if rec['side'] == 'BUY' else 'Sold'} {qty:,} {symbol} at about {float(cash / qty):g}.")
    known = {r["id"] for r in records}
    if any(i not in known for i in bk["applied"]):   # orders too old to be filled any further
        bk["applied"] = {i: v for i, v in bk["applied"].items() if i in known}
        _keep(core, bk)
    return notes


def _sweep(core: App, records: list[dict]) -> None:
    """A sale the automation wrote for itself and never sent (the look died in between) is closed, not left waiting."""
    for rec in records:
        if rec["status"] == "proposed" and rec["origin"] == "automation" and real_orders._age(rec.get("created_at")) > CLAIM_SECONDS:
            real_orders.discard(core, rec, "The app was interrupted before this sale was sent. Nothing was sent.")


def _unsettled(bk: dict, records: list[dict], symbol: str) -> bool:
    """Whether an order of the automation's in this stock is still in flight, or filled further than the book has counted."""
    for rec in records:
        if rec["symbol"] != symbol or not _booked(rec):
            continue
        if _in_flight(rec) or (rec["status"] == "sent" and int((rec.get("broker") or {}).get("executed_qty") or 0) > _applied(bk, rec)["qty"]):
            return True
    return False


def _reconcile(core: App, bk: dict, held: dict, records: list[dict]) -> list[str]:
    """The broker's holdings are the truth: where it shows fewer shares than the book, the book gives way.

    But not on one reading. The account must show the shortfall at several looks in a row, some time apart,
    with no order of the automation's in that stock still in flight: a single odd answer from the broker, or a
    sale that filled a moment ago, must not make the app forget shares it is watching.
    """
    notes, changed = [], False
    for symbol, pos in list(bk["positions"].items()):
        if real_orders._age(pos.get("touched")) < SETTLING_SECONDS or _unsettled(bk, records, symbol):
            continue   # a fill this recent, or one still to come, may not show in the broker's holdings yet
        row = held.get(pos.get("stock_id")) or {}
        actual = int(row.get("qty") or 0) + int(row.get("unsettled") or 0)   # the most the account can be holding
        short = pos.get("short") or {}
        if actual >= pos["qty"]:
            if short:
                pos["short"], changed = None, True
            continue
        if short.get("actual") != actual:
            pos["short"], changed = {"actual": actual, "since": now_iso(), "looks": 1}, True
            continue
        short["looks"] += 1
        changed = True
        if short["looks"] < SHORT_LOOKS or real_orders._age(short["since"]) < SHORT_SECONDS:
            continue
        notes.append(f"The broker shows {actual:,} {symbol}, not the {pos['qty']:,} the automation counted: the rest left the "
                     "account outside it, and is no longer its to watch.")
        if actual <= 0:
            del bk["positions"][symbol]
        else:
            pos.update(cost=str(money(D(pos["cost"]) * actual / pos["qty"])), qty=actual, short=None)
    if changed:
        with core.store.transaction():
            _keep(core, bk)
            if notes:
                core.audit("reconcile", "real_auto", {"notes": notes})
    return notes


def _last(core: App, symbol: str) -> float | None:
    known = core._last_price(symbol)
    return float(known[0]) if known else None


def _live(core: App, symbol: str, now: datetime) -> float | None:
    """The price on screen, only when it is from the running session and fresh enough to act on.

    Fresh means this stock answered at the last reading of the feed. One that did not keeps its earlier
    figure on screen, and that figure is not acted on.
    """
    if not core.market.is_live(symbol) or symbol in (core.market.cache.get("live_stale") or ()):
        return None
    try:
        age = (now - datetime.fromisoformat(core.market.cache.get("live_as_of"))).total_seconds()
    except (TypeError, ValueError):
        return None
    return _last(core, symbol) if -60 <= age <= LIVE_SECONDS else None   # a reading stamped in the future is not a reading


def _price_now(core: App, symbol: str, pos: dict, now: datetime) -> tuple[float | None, str | None]:
    """The price a stop is judged by, and a remark when there is none to judge by.

    Two readings are taken: the app's live feed, which every account of the app can write to, and the broker's
    own price for that stock, which the server asks for itself. When both are there they must agree, and the
    lower is used. When they disagree nothing is sold and the owner is told: a wrong figure in the shared feed
    can then neither sell a position nor hide that its stop was reached. With only one of them, that one is used.
    """
    feed = _live(core, symbol, now)
    try:
        direct = core.younit.trading_limits(pos["stock_id"]).get("last") if market_open(now) else None
    except (YounitError, KeyError, TypeError):
        direct = None
    if feed is None or direct is None:
        return (direct if direct is not None else feed), None
    if abs(feed - direct) / direct * 100 > PRICE_GAP_PCT:
        return None, (f"The app's price for {symbol} ({feed:g}) and the broker's own ({direct:g}) disagree, so its stop-loss is "
                      "not being acted on. Look at it yourself on the Real account page.")
    return min(feed, direct), None


def _result(core: App, bk: dict, today: str, prices: dict | None = None) -> Decimal:
    """How the automation stands today: what today's sales made or lost, and what its holdings are up or down on their cost."""
    open_result = ZERO
    for symbol, pos in bk["positions"].items():
        last = (prices or {}).get(symbol) or _last(core, symbol)
        if last is not None:
            open_result += money(D(str(last)) * pos["qty"]) - D(pos["cost"])
    return money(D((bk["days"].get(today) or {}).get("realized", "0")) + open_result)


# ---- what may be sent without the owner -------------------------------------------------
def judge(rec: dict, records: list[dict], bk: dict, box: dict, today: str, *, birth: bool = False) -> list[str]:
    """Why this proposal may not be sent automatically; empty when it may. No call to the broker.

    `birth` is the judging done once, when the assistant has just written the proposal (`admit`). Only a
    proposal that passed then is ever sent by itself: one that was told "this waits for the owner" keeps
    waiting, whatever changes afterwards.
    """
    if rec["origin"] not in ("assistant", "automation"):
        return ["Only the assistant's proposals are sent automatically; this one waits for you."]
    if rec.get("hold"):
        return ["The assistant wrote it to wait for your own decision."]
    if rec["origin"] == "assistant":
        if not birth and not rec.get("auto_ok"):
            said = " ".join(rec.get("auto_why") or []) or "it was outside the automatic box."
            return [f"It waits for you, as it was told when it was written: {said}"]
        if _before(rec.get("created_at"), box.get("enabled_at")):
            return ["It was written before automatic orders were switched on, so it waits for you as it said it would."]
    pos = bk["positions"].get(rec["symbol"])
    selling = sum(r["qty"] for r in records if _active_sale(r) and r["symbol"] == rec["symbol"] and r["id"] != rec["id"])
    if rec["side"] == "SELL":
        if pos is None:
            return [f"The automation holds no {rec['symbol']}: it sells only shares it bought itself."]
        if rec["qty"] + selling > pos["qty"]:
            return [f"The automation holds {pos['qty']:,} {rec['symbol']}"
                    + (f", {selling:,} of them already being sold" if selling else "") + f"; this would sell {rec['qty']:,}."]
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
    if selling:
        out.append(f"The automation is selling {rec['symbol']} right now; it does not buy it at the same time.")
    elif pos and pos.get("stop") and price <= D(pos["stop"]):
        out.append(f"The automation's {rec['symbol']} is watched by a stop-loss at {float(pos['stop']):g}; a buy at or under that "
                   "would be bought under its own stop.")
    paused = bk.get("paused")
    if paused and paused.get("day") == today:
        out.append(f"The automation is not buying for the rest of today: {paused['why']}")
    if any(r["origin"] == "automation" and r["symbol"] == rec["symbol"] and r.get("created_day") == today for r in records):
        out.append(f"The app sold {rec['symbol']} at a stop-loss or take-profit today, or is trying to; "
                   "the automation does not buy it again the same day.")
    bought = [r for r in records if _automatic(r) and r["side"] == "BUY" and r.get("sent_day") == today and r["status"] in COUNTED]
    if len(bought) + 1 > box["max_day_buys"]:
        out.append(f"{len(bought)} automatic buys were already sent today; the limit is {box['max_day_buys']}.")
    spent = sum((D(r["value"]) for r in bought), ZERO)
    if box.get("max_day_value") and spent + value > D(box["max_day_value"]):
        out.append(f"Automatic buys worth {spent:,.2f} were already sent today; with this it would be {spent + value:,.2f}, over "
                   f"the {D(box['max_day_value']):,.2f} you allow in one day.")
    used, room = _exposure(bk, records), _room(box, bk)
    if used + value > room:
        out.append(f"The automation has {used:,.2f} in the market; with this it would be {used + value:,.2f}, over the "
                   f"{room:,.2f} left of its budget.")
    return out


def admit(core: App, id: str) -> dict:
    """Decide once, when the assistant has just written a proposal, whether it is one the automation may send.

    The answer is written on the proposal and told to the assistant, which tells the owner. It does not change
    later: a proposal that was outside the box then is never sent by itself, even if the box, the budget or the
    day changes. A sale that the automation's own shares could cover is also marked as theirs here, so that it
    comes off the automation's book whoever approves it.
    """
    real_orders._owner(core)
    now = cairo_now()
    box, bk = chosen(core), _book(core)
    records = real_orders._records(core, now)
    state = standing(core, box, bk, records)
    rec = next((r for r in records if r["id"] == id and r["status"] == "proposed" and r["origin"] == "assistant"), None)
    if rec is None:
        return {"will_be_sent_automatically": False, "why_not": ["It is not a waiting proposal of the assistant's."]}
    marks = {}
    if rec["side"] == "SELL":
        pos = bk["positions"].get(rec["symbol"])
        selling = sum(r["qty"] for r in records if _active_sale(r) and r["symbol"] == rec["symbol"] and r["id"] != id)
        if pos is not None and rec["qty"] + selling <= pos["qty"]:
            marks["of_book"] = True
    why = [state["why_not"]] if not state["on"] else judge(rec, records, bk, box, now.date().isoformat(), birth=True)
    if not why:
        marks["auto_ok"] = True
    else:
        marks["auto_why"] = why[:4]   # kept, so the page can say why it waits long after the reason has passed
    if marks:
        rec.update(marks)
        real_orders._put(core, rec)
    return {"will_be_sent_automatically": not why, "why_not": why}


def _gate(core: App, bk: dict, today: str):
    """The owner's box, standing in for the owner at the last moment before an order goes out.

    It is asked inside the approval, after everything was read afresh: the switches and the box it judges by are
    the very documents the approval is tied to, so what it allows is what is true when the order is committed.
    """
    def gate(rec: dict, rows: list[dict]) -> list[str]:
        box = chosen(core)
        state = standing(core, box, bk, rows)
        return [state["why_not"]] if not state["on"] else judge(rec, rows, bk, box, today)
    return gate


# ---- getting out of a position ----------------------------------------------------------
def _exit_price(core: App, symbol: str, pos: dict, last: float, band_pct: float, at_least: float | None) -> Decimal:
    """A price for getting out now: a few levels into the bids, so that it fills.

    The feed sends the best bid alone (see data/depth.py), so in practice this is the best bid.

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


def _tries(pos: dict, today: str, kind: str) -> dict:
    """How often a way out of this kind was tried today. A stop-loss and a take-profit are counted apart."""
    kept = pos.get("tries") if (pos.get("tries") or {}).get("day") == today else None
    if kept is None:
        kept = pos["tries"] = {"day": today}
    return kept.setdefault(kind, {"n": 0, "at": None})


def _cancel_resting(core: App, records: list[dict], symbol: str, side: str) -> tuple[int, list[str]]:
    """Take back the automation's own orders of one side that rest unfilled at the broker. Returns how many, and what went wrong."""
    done, problems = 0, []
    for rec in records:
        if rec["symbol"] != symbol or rec["side"] != side or not _booked(rec) or rec["status"] != "sent" \
                or (rec.get("broker") or {}).get("state") not in OPEN_STATES:
            continue
        try:
            real_orders.cancel(core, rec["id"])
            done += 1
        except OrderError:
            pass   # it is no longer open
        except YounitError as exc:
            problems.append(f"The resting {side.lower()} order for {rec['qty']:,} {symbol} could not be cancelled: {exc}")
    return done, problems


def _way_out(core: App, symbol: str, pos: dict, bk: dict, records: list[dict], today: str, last: float | None,
             held: dict | None, band_pct: float, still_on, doubt: str | None = None) -> tuple[dict | None, str | None]:
    """Carry out a stop-loss or a take-profit that was reached. Returns the order sent, and anything the owner should read.

    `still_on()` is asked just before anything is written or sent: it reads the switches and the box afresh,
    and returns the box, or None when the owner has switched something off since this look began.
    """
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
        return None, f"The automation's {symbol} has no stop-loss. Set one on the Real account page (Move levels)."
    if last is None:
        return None, doubt or f"There is no fresh price for {symbol} right now, so its stop-loss is not being watched."
    if stop is not None and last <= stop:
        kind, level, why = "stop-loss", "stop", f"Stop-loss: the price reached {last:g}, at or under the stop at {stop:g}."
    elif target is not None and last >= target:
        kind, level, why = "take-profit", "target", f"Take-profit: the price reached {last:g}, at or over the target at {target:g}."
    else:
        return None, None

    tries = _tries(pos, today, level)
    if tries["n"] >= MAX_EXIT_TRIES:
        return None, (f"{symbol} is at its stop-loss and {tries['n']} sales of it today did not complete. "
                      "The app has stopped trying: sell it yourself on the Real account page." if level == "stop" else
                      f"{symbol} reached its take-profit, but {tries['n']} sales at it today did not fill. The app leaves the "
                      "take-profit for today; the stop-loss still stands.")
    if real_orders._age(tries["at"]) < EXIT_RETRY_SECONDS:
        return None, None
    doubtful = [r for r in records if r["symbol"] == symbol and _active_sale(r) and r["status"] in ("sending", "unknown")]
    if doubtful:
        return None, (f"{symbol} reached its {kind}, but an earlier sale of it may or may not have reached the broker. Settle that "
                      "one on the Real account page: until then the app sends no other sale of it.")
    # Other orders of the automation's in this stock must not stand in the way: a sale resting above the market
    # would keep the stop from selling, and a buy still open would buy more of what is being sold.
    sales, problems = _cancel_resting(core, records, symbol, "SELL")
    buys, more = _cancel_resting(core, records, symbol, "BUY") if level == "stop" else (0, [])
    if sales or buys or problems or more:
        tries["at"] = None
        return None, " ".join([f"{symbol} reached its {kind} while {sales + buys} other order(s) of the automation's in it rested "
                               "at the broker; they were cancelled, and the sale follows at the next look."] * bool(sales + buys)
                              + problems + more)
    if held is None:
        return None, f"{symbol} reached its {kind}, but the broker's holdings could not be read just now."
    qty = min(pos["qty"], int((held.get(pos.get("stock_id")) or {}).get("available") or 0))
    if qty <= 0:
        return None, (f"{symbol} reached its {kind}, but the broker does not show its shares as free to sell yet. "
                      "The app sells as soon as it does.")
    if still_on() is None:
        return None, f"{symbol} reached its {kind}, but automatic orders were switched off while this look was running."
    price = _exit_price(core, symbol, pos, last, band_pct, target if level == "target" else None)

    # Claim the way out in the book before anything is written or sent: of two looks at the same moment, one gets it.
    pos["exit"] = {"at": now_iso(), "order": None}
    tries["at"] = now_iso()
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
        sent = real_orders.send_waiting(core, made["id"], _gate(core, bk, today), touch=SWITCHES)
    except OrderError as exc:   # refused before anything was sent
        real_orders.discard(core, real_orders._get(core, made["id"]), f"Not sent: {exc}")
        pos["exit"] = None
        _keep(core, bk)
        return None, f"The sale of {symbol} at its {kind} was not sent: {exc}"
    tries["n"] += 1             # only a sale that went to the broker counts as a try
    _keep(core, bk)
    return sent, None


# ---- one look ---------------------------------------------------------------------------
def tick(core: App) -> dict:
    """One look by the automation. The owner's open app asks for it, or the server's timer; it does nothing unless everything allows it."""
    real_orders._owner(core)
    if not _looking.acquire(blocking=False):
        return {"ran": False, "busy": True, "why": "Another look is running."}
    done: dict = {"sent": [], "exits": [], "notes": []}
    try:
        return _tick(core, done)
    except (_Busy, ConflictError):
        if done["sent"] or done["exits"]:   # what this look did before the collision is still told
            return clean({"ran": True, **done, "notes": [*done["notes"], "This look stopped early: another window was working on "
                                                        "the same thing. The next look carries on."][:12], "paused": None})
        return {"ran": False, "busy": True, "why": "Another window was working on the same thing; the next look starts afresh."}
    finally:
        _looking.release()


def _tick(core: App, done: dict) -> dict:
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
    notes: list[str] = done["notes"]
    problem = real_orders._sync(core, records, now)
    if problem:
        notes.append(problem)
    notes += _apply_fills(core, records, bk, today)
    _sweep(core, records)
    held = None
    if bk["positions"]:
        try:
            held = {p["stock_id"]: p for p in broker.reading(core, fresh=True)["positions"]}
            if not problem:   # without the orders' latest word, a fill could be taken for shares that left the account
                notes += _reconcile(core, bk, held, records)
        except YounitError as exc:
            notes.append(f"The broker's holdings could not be read just now ({exc}).")
    read = {symbol: _price_now(core, symbol, pos, now) for symbol, pos in bk["positions"].items()}
    prices, doubts = {s: p for s, (p, _) in read.items()}, {s: why for s, (_, why) in read.items() if why}

    # the brake: down by more than the owner allows, it buys nothing more today
    result = _result(core, bk, today, prices)
    if result < -D(box["max_loss"]) and (bk.get("paused") or {}).get("day") != today:
        bk["paused"] = {"day": today, "why": f"it is down {-result:,.2f}, more than the {D(box['max_loss']):,.2f} you allow."}
        with core.store.transaction():
            _keep(core, bk)
            core.audit("pause", "real_auto", {"result": str(result), "limit": box["max_loss"]})
        notes.append(f"The automation stopped buying for today: {bk['paused']['why']}")

    def still_on() -> dict | None:
        """The switches and the box as they are in the database this instant, not as they were when the look began."""
        nonlocal records
        core.store.fresh()
        latest = chosen(core)
        records = real_orders._records(core, now)
        return latest if standing(core, latest, bk, records)["on"] else None

    # ways out first: a stop-loss matters more than a new purchase
    band = float(D(real_orders.limits(core)["price_band_pct"]))
    for symbol in sorted(bk["positions"]):
        if len(done["exits"]) >= EXITS_PER_LOOK:
            break
        order, note = _way_out(core, symbol, bk["positions"][symbol], bk, records, today, prices.get(symbol), held, band, still_on,
                               doubts.get(symbol))
        if note:
            notes.append(note)
        if order:
            done["exits"].append(order)
            records = real_orders._records(core, now)

    # then the assistant's proposals that fit the box, oldest first
    waiting = [r["id"] for r in records if r["status"] == "proposed" and r["origin"] == "assistant" and r.get("auto_ok")
               and not real_orders._over(r["session"], now)]
    for id in reversed(waiting):
        if len(done["sent"]) >= SENDS_PER_LOOK:
            break
        rec = next((r for r in records if r["id"] == id), None)
        tried = (rec or {}).get("auto") or {}
        if rec is None or rec["status"] != "proposed" or (
                tried and (tried.get("n", 0) >= MAX_AUTO_TRIES or real_orders._age(tried.get("at")) < AUTO_RETRY_SECONDS)):
            continue
        if judge(rec, records, bk, box, today):
            continue   # it waits; the page says why
        latest = still_on()   # read afresh before each order: a stop pressed a moment ago holds from here on
        if latest is None:
            notes.append("Automatic orders were switched off while this look was running; nothing more was sent.")
            break
        box = latest
        try:
            sent = real_orders.send_waiting(core, id, _gate(core, bk, today), touch=SWITCHES)
        except OrderError as exc:   # refused before anything was sent: it still waits, and says why
            real_orders.note_auto(core, real_orders._get(core, id), str(exc))
            notes.append(f"{rec['side']} {rec['qty']:,} {rec['symbol']} was not sent automatically: {exc}")
            continue
        done["sent"].append(sent)
        records = real_orders._records(core, now)
    paused = bk.get("paused") if (bk.get("paused") or {}).get("day") == today else None
    return clean({"ran": True, "sent": done["sent"], "exits": done["exits"], "notes": notes[:12], "paused": paused})


# ---- what the screens and the assistant see ---------------------------------------------
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
        tries = pos.get("tries") if (pos.get("tries") or {}).get("day") == today else {}
        positions.append({
            "symbol": symbol, "name": (core.market.instrument(symbol) or {}).get("name"), "qty": pos["qty"],
            "cost": D(pos["cost"]), "avg_cost": D(pos["cost"]) / pos["qty"] if pos["qty"] else None,
            "stop": stop, "target": target, "last": last, "value": value,
            "result": value - D(pos["cost"]) if value is not None else None,
            "live": _live(core, symbol, now) is not None, "selling": symbol in selling,
            "at_stop": bool(stop is not None and last is not None and last <= stop),
            "gave_up": (tries.get("stop") or {}).get("n", 0) >= MAX_EXIT_TRIES, "since": pos.get("since")})
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
                  "bought": sum((D(r["value"]) for r in records if _automatic(r) and r["side"] == "BUY" and r.get("sent_day") == today
                                 and r["status"] in COUNTED), ZERO),
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
