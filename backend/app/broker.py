"""The owner's real brokerage account: who may see it, and a read-only look at it.

This module only looks: the cash, the holdings and what they are worth, read from Younit
(EFG Hermes) with the server's credentials. Orders are a separate matter, in `real_orders.py`,
and use the same rule for who the owner is.

Who may look
    The credentials open one person's brokerage account, while several people can sign in to
    the app. So the account is shown only to the sign-ins named in BROKER_ACCOUNT_UIDS on the
    server; for everybody else it does not exist. An empty list means nobody: being an
    administrator is not enough. A local run has no sign-in, so there is nobody to name: it may
    look only when the list contains the word `local`, which is never the default.

Nothing is stored
    The figures are read when a screen asks for them and kept in memory for a few seconds, so
    that several looks cost one call to the broker. The paper ledger and the real account never
    mix: no figure from here enters the paper portfolio, and no paper trade changes anything here.

The checks
    A reading is only worth building on if it is right, so every view carries the checks the app
    could make itself: do the holdings add up to the broker's own total, does the total equal
    cash plus stocks, and does the broker price each holding the way the app's feed does.
"""
from __future__ import annotations

import threading
import time
import weakref
from concurrent.futures import ThreadPoolExecutor

from .config import Settings
from .data.calendar import cairo_now, market_open
from .data.younit import YounitError
from .services import App, NotFound, clean

CACHE_SECONDS = 20.0      # one reading serves every look within this time
FRESH_SECONDS = 5.0       # a "refresh" still reuses a reading this recent
HOLDER_SECONDS = 3600.0   # whose account it is does not change during a session
PRICE_GAP_PCT = 1.0       # broker's price against the app's, before it is worth a remark
HOLDER_RETRY_SECONDS = 300.0  # after a failed look at whose account it is
LOCAL = "local"           # in BROKER_ACCOUNT_UIDS: a server without sign-in may look
MONEY_TOLERANCE = 1.0     # EGP: rounding, never a real difference
SUM_TOLERANCE_PCT = 0.5   # two readings a moment apart can differ by a tick

_lock = threading.Lock()
_readings: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()  # client -> (monotonic time, as_of, reading)
_holders: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()   # client -> (good until, holder)


class NotAllowed(PermissionError):
    """This sign-in is not the brokerage account's owner."""


def may_view(settings: Settings, uid: str | None, *, signed_in: bool) -> bool:
    """Whether a request may look at the real account. `uid` must already be proven genuine."""
    allowed = {u for u in settings.broker_account_uids.replace(",", " ").split() if u}
    if not signed_in:
        return LOCAL in allowed
    return bool(uid) and uid != LOCAL and uid in allowed


def access(core: App) -> dict:
    """What the screens need to decide whether to offer the real account at all. No call to the broker."""
    connected = core.younit is not None
    return {"connected": connected, "allowed": connected and core.real_account_allowed,
            "user_id": getattr(core.store, "uid", None)}


def _holder(client) -> dict | None:
    """Name and masked account number, so the owner can see which account is linked. Never a reason to fail."""
    cached = _holders.get(client)
    if cached and time.monotonic() < cached[0]:
        return cached[1]
    try:
        raw = client.account_holder()
    except YounitError:
        # keep what was known and do not ask again with every reading
        holder = cached[1] if cached else None
        _holders[client] = (time.monotonic() + HOLDER_RETRY_SECONDS, holder)
        return holder
    code = raw.get("account_code")
    holder = {"name": raw.get("name"), "account": f"•••{code[-3:]}" if code and len(code) > 3 else ("•••" if code else None)}
    _holders[client] = (time.monotonic() + HOLDER_SECONDS, holder)
    return holder


def _read(client, fresh: bool) -> tuple[float, str, dict]:
    """The broker's figures, read at most once per few seconds however many screens ask."""
    with _lock:
        cached = _readings.get(client)
        if cached and time.monotonic() - cached[0] < (FRESH_SECONDS if fresh else CACHE_SECONDS):
            return cached
        with ThreadPoolExecutor(3) as pool:
            summary = pool.submit(client.account_summary)
            positions = pool.submit(client.account_positions)
            holder = pool.submit(_holder, client)
            reading = {"summary": summary.result(), **positions.result(), "holder": holder.result()}
        cached = (time.monotonic(), cairo_now().isoformat(timespec="seconds"), reading)
        _readings[client] = cached
        return cached


def reading(core: App, *, fresh: bool = False) -> dict:
    """The broker's own figures for the account, for code that must check an order against them."""
    if core.younit is None or not core.real_account_allowed:
        raise NotAllowed("the real brokerage account is not enabled for this sign-in")
    return _read(core.younit, fresh)[2]


def forget(core: App) -> None:
    """Drop the last reading: an order was just sent or cancelled, so the account is no longer what it was."""
    with _lock:
        _readings.pop(core.younit, None)


def reset() -> None:
    """Forget every reading (tests)."""
    with _lock:
        _readings.clear()
        _holders.clear()


def _close(a: float, b: float, pct: float = 0.0) -> bool:
    return abs(a - b) <= max(MONEY_TOLERANCE, abs(b) * pct / 100)


def view(core: App, *, fresh: bool = False) -> dict:
    """The real account as the screens show it: summary, holdings joined to the app's own prices, and checks."""
    if core.younit is None:
        raise NotFound("the real account needs the Younit connection, which is not set up on the server")
    if not core.real_account_allowed:
        raise NotAllowed("the real brokerage account is not enabled for this sign-in")
    read_at, as_of, reading = _read(core.younit, fresh)
    summary = reading["summary"]

    feed = core.market.feed or {}
    by_id = {i["stock_id"]: i["symbol"] for i in feed.get("instruments", []) if i.get("stock_id") is not None}
    holdings = []
    for p in reading["positions"]:
        # The broker's own id is the surest match; its code is the fallback (funds arrive without a usable one).
        symbol = by_id.get(p["stock_id"]) or p["symbol"]
        ins = core.market.instrument(symbol) if symbol else None
        known = core._last_price(symbol) if ins else None
        app_price = float(known[0]) if known else None
        gap = (p["price"] - app_price) / app_price * 100 if app_price and p["price"] else None
        value = p["value"] if p["value"] is not None else (p["price"] * p["qty"] if p["price"] is not None else None)
        gain = p["unrealized"] if p["unrealized"] is not None else (
            value - p["cost"] if value is not None and p["cost"] is not None else None)
        holdings.append({
            "symbol": symbol if ins else None, "code": p["symbol"], "name": (ins or {}).get("name") or p["name"],
            "sector": (ins or {}).get("sector"), "in_app": ins is not None,
            "qty": p["qty"], "available": p["available"], "unsettled": p["unsettled"], "frozen": p["frozen"],
            "avg_cost": p["avg_cost"], "cost": p["cost"], "price": p["price"], "value": value,
            "unrealized": gain,
            "unrealized_pct": p["unrealized_pct"] if p["unrealized_pct"] is not None else (
                gain / p["cost"] * 100 if gain is not None and p["cost"] else None),
            "app_price": app_price, "app_price_as_of": known[1] if known else None, "price_gap_pct": gap,
            "price_differs": gap is not None and abs(gap) > PRICE_GAP_PCT, "suspended": p["suspended"],
        })
    holdings.sort(key=lambda h: -(h["value"] or 0))

    held = sum(h["value"] for h in holdings if h["value"] is not None)
    cash, stocks, total = summary["cash"], summary["stocks"], summary["total"]
    # Shares of the account are taken of cash plus holdings, so they add up to 100% whatever the broker's total includes.
    base = (cash or 0) + (stocks if stocks is not None else held) or total
    for h in holdings:
        h["weight_pct"] = h["value"] / base * 100 if base and h["value"] is not None else None

    checks = []

    def check(ok: bool, label: str, detail: str) -> None:
        checks.append({"ok": ok, "label": label, "detail": detail})

    reference = stocks if stocks is not None else reading["stocks_value"]
    if reference is None:
        check(False, "Holdings against the broker's total", "The broker gave no total for the holdings, so the list could not be checked.")
    elif _close(held, reference, SUM_TOLERANCE_PCT):
        check(True, "Holdings against the broker's total",
              f"The {len(holdings)} holding{'' if len(holdings) == 1 else 's'} listed add up to the broker's own figure.")
    else:
        check(False, "Holdings against the broker's total",
              f"The holdings listed add up to {held:,.2f} but the broker states {reference:,.2f}. The list may be incomplete "
              "(funds are not always listed), or prices moved between the two readings: refresh to check again.")
    if None in (cash, stocks, total):
        check(False, "Total against cash plus stocks", "The broker left out one of cash, stocks or total, so they could not be compared.")
    elif _close(total, cash + stocks, 0.1):
        check(True, "Total against cash plus stocks", "The broker's total equals its cash plus its stocks.")
    else:
        check(False, "Total against cash plus stocks",
              f"The broker's total is {total:,.2f} but cash plus stocks is {cash + stocks:,.2f} "
              f"(a difference of {total - cash - stocks:,.2f}). The total may include funds or money that is not settled yet.")
    priced = [h for h in holdings if h["price_gap_pct"] is not None]
    apart = [h for h in priced if h["price_differs"]]
    if apart:
        check(False, "Broker prices against the app's feed",
              f"{', '.join(h['symbol'] for h in apart[:8])}: priced more than {PRICE_GAP_PCT:g}% apart. After the close the broker "
              "may use the official closing price while the app shows the last trade.")
    elif priced:
        check(True, "Broker prices against the app's feed",
              f"All {len(priced)} holding{'' if len(priced) == 1 else 's'} the app can price agree within {PRICE_GAP_PCT:g}%.")

    notes = []
    outside = [h for h in holdings if not h["in_app"]]
    if outside:
        notes.append(f"{len(outside)} holding{'' if len(outside) == 1 else 's'} ({', '.join(h['name'] for h in outside[:5])}) "
                     "not in the app's stock list, such as funds: shown at the broker's price, without the app's analysis.")
    waiting = [h for h in holdings if h["unsettled"] > 0]
    if waiting:
        parts = ["{:,} {}".format(h["unsettled"], h["symbol"] or h["name"]) for h in waiting[:8]]
        notes.append(f"Not settled yet: {', '.join(parts)}. Shares can be sold once they show under “Free to sell”.")
    halted = [h for h in holdings if h["suspended"]]
    if halted:
        notes.append(f"Trading is suspended in {', '.join(h['symbol'] or h['name'] for h in halted[:8])}.")

    return clean({
        "mode": "real", "read_only": True, "as_of": as_of, "age_seconds": round(time.monotonic() - read_at),
        "market_open": market_open(), "holder": reading["holder"], "currency": summary["currency"],
        "summary": {"cash": cash, "stocks": stocks, "total": total, "held_value": held,
                    "cost": sum(h["cost"] for h in holdings if h["cost"] is not None),
                    "realized": summary["realized"], "unrealized": summary["unrealized"],
                    "unrealized_pct": summary["unrealized_pct"],
                    "cash_weight_pct": cash / base * 100 if base and cash is not None else None},
        "holdings": holdings, "checks": checks, "notes": notes,
    })
