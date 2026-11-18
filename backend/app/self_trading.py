"""Trading by itself: what is in place for the assistant to act without being asked, and what is not.

The pieces were already there, each with its own switch, on three settings pages: the autopilot's schedule and
the access level (assistant_prefs.py), the spending ceilings (assistant.py), the radar (radar.py), real orders
and their limits (real_orders.py), the automatic box (real_auto.py), and the server's own looks with the app
closed (background.py). This module reads them together and says, in one list, which are in place and which are
missing, so that the settings page can show one checklist and the assistant can explain itself.

It only reads. It switches nothing on, decides nothing, and sends nothing: every switch it names is the
owner's, set where it always was.
"""
from __future__ import annotations

from . import background, broker, real_auto, real_orders
from .assistant import reached, spending
from .assistant_prefs import autopilot_account, autopilot_blocked, prefs
from .services import App
from .wakes import WOKEN

SCHEDULE_SAYS = {
    "after_close": "One review after each completed session.",
    "events": "A review after each close, and a short one whenever something the app watches for it happens.",
}
ACCESS_NAMES = {"full": "Full access", "confirm": "Ask me first", "read": "Look only"}


def report(core: App, spend: dict | None = None) -> dict:
    """What stands between the saved settings and the assistant trading by itself, said for the person.

    One row for each thing that must be in place: `state` is "ok", "missing" (it will not act by itself until this
    is done) or "note" (it works, with a limit worth knowing). Worked out here, from what is saved and what the
    app enforces, so that the settings page and the assistant itself (the `settings` tool) say the same thing.
    It changes nothing and decides nothing: every switch named here is the owner's, and stays where it was.
    """
    chosen = prefs(core)
    auto, access = chosen["autopilot"], chosen["access"]
    mode, account = auto["mode"], autopilot_account(core, auto)
    owner = bool(broker.access(core)["allowed"])
    rows: list[dict] = []

    def row(key: str, state: str, title: str, detail: str, **more) -> None:
        rows.append({"key": key, "state": state, "title": title, "detail": detail, **more})

    row("schedule", "ok" if mode != "off" else "missing", "A schedule for its own reviews",
        "Off: it acts only when you ask it to." if mode == "off" else
        SCHEDULE_SAYS.get(mode) or f"A review after each close, one every {auto['every_minutes']} minutes while the market is open, "
                                   "and a short one when a watch fires.")
    row("access", "ok" if access == "full" else "missing", "It may act without asking",
        "Full access: in a review it carries out what it decides, inside your limits." if access == "full" else
        f"Set to “{ACCESS_NAMES.get(access, access)}”: in its own reviews it only looks and reports. It trades by itself "
        "only with Full access.", **({} if access == "full" else {"fix": "access"}))
    hit = reached(core)
    spend = spend or spending(core)
    each, a_day = spend["autopilot"]["review_usd"], None
    if each is not None:
        a_day = each * spend["autopilot"]["reviews_a_day"]
    if hit:
        row("budget", "missing", "Room under your spending ceilings", hit[1])
    elif mode != "off" and a_day is not None and chosen["daily_usd"] > 0 and a_day > chosen["daily_usd"]:
        row("budget", "note", "Room under your spending ceilings",
            f"This schedule can run {spend['autopilot']['reviews_a_day']} reviews a day, about USD {a_day:,.2f} at what a review "
            f"cost this week, and your ceiling for one day is USD {chosen['daily_usd']:,.2f}: the later reviews of a day will be held back.")
    else:
        row("budget", "ok", "Room under your spending ceilings",
            f"USD {spend['today_usd']:,.2f} spent today"
            + (f" of USD {chosen['daily_usd']:,.2f}" if chosen["daily_usd"] > 0 else " (no daily ceiling)")
            + f"; USD {spend['month_usd']:,.2f} this month"
            + (f" of USD {chosen['monthly_usd']:,.2f}." if chosen["monthly_usd"] > 0 else " (no monthly ceiling)."))
    if owner and background.menu(core):
        row("closed", "ok", "It keeps going with the app closed",
            "During the session the server looks every minute by itself: it runs the reviews, carries out the stop-losses and "
            "take-profits (paper and automatic real ones), and brings the automatic paper runs up to date.")
    elif owner:
        row("closed", "note", "It keeps going with the app closed",
            "Not yet: reviews, stop-losses and automatic runs happen only while the app is open on one of your devices. "
            "Switch on “Running without the app open” to hand that to the server.", href="/settings?tab=real")
    else:
        row("closed", "note", "It keeps going with the app closed",
            "Reviews, stop-losses and automatic runs happen while the app is open on one of your devices.")

    radar = chosen["radar"]
    if not radar["on"]:
        row("radar", "note", "The radar watches the market for it",
            "Off: between its reviews it hears only of the watches it or you set. Switch the radar on to have the app go over "
            "the live prices for it every minute.", fix="radar")
    elif mode in WOKEN:
        row("radar", "ok", "The radar watches the market for it",
            "On: during the session the app goes over the live prices once a minute, your own stocks closely"
            + (" and the rest of the market loosely" if radar["market"] else "") + ", and wakes it for what stands out"
            + (", after a small model has sorted what is worth it." if radar["triage"] else "."))
    elif mode != "off":
        row("radar", "note", "The radar watches the market for it",
            "On, but with reviews after the close only it does not wake it: what it finds is told to that review. Choose a "
            "schedule that wakes it to have it act at once.")
    else:
        row("radar", "note", "The radar watches the market for it",
            "On, and it starts with the schedule: with no reviews of its own there is nobody to tell.")

    blocked = autopilot_blocked(core, auto)
    real_part = owner and account in ("real", "both")
    proposals, automatic = False, False
    if blocked:
        row("real_account", "missing", "The real account can be reached", blocked)
    elif real_part:
        ready = real_orders.readiness(core)
        row("real_orders", "ok" if ready["ready"] else "missing", "Real orders are switched on",
            "On, inside the limits you set for every real order." if ready["ready"] else ready["why_not"], href="/settings?tab=real")
        allowed = int(chosen["real_proposals_per_day"])
        row("proposals", "ok" if allowed else "missing", "It may write real-order proposals",
            f"Up to {allowed} a day." if allowed else "You allow it none in a day (0), so on the real account it only looks and reports.")
        proposals = bool(ready["ready"] and allowed)
        if ready["ready"]:
            box = real_auto.brief(core)
            automatic = bool(box["on"] and proposals)
            row("automatic", "ok" if box["on"] else "missing", "Its real orders are sent without you",
                "On: a proposal that fits your box goes to the broker within a minute or two. One that does not fit waits for you."
                if box["on"] else f"{box['why_not']} Until then every proposal waits for your approval on the Real account page.",
                href="/settings?tab=real")
        else:
            row("automatic", "missing", "Its real orders are sent without you",
                "Needs real orders switched on first. Then you draw the automatic box: the stocks, the most per order, a budget "
                "and a stop-loss on every buy.", href="/settings?tab=real")

    acts = mode != "off" and access == "full" and not hit and not blocked
    if mode == "off":
        level, headline = "off", "Off. The assistant acts only when you ask it to."
    elif blocked:
        level, headline = "blocked", "No review runs: the real account it is set to cannot be reached."
    elif hit:
        level, headline = "held", "Held back: a spending ceiling you set has been reached."
    elif not acts:
        level, headline = "looks", "It reviews by itself and reports, but changes nothing."
    elif account == "paper":
        level, headline = "paper", "It trades the paper portfolio by itself, inside your limits."
    else:
        paper_too = "It trades the paper portfolio by itself. " if account == "both" else ""
        asked = " when your instructions ask for real orders" if account == "both" else ""
        if automatic:
            level, headline = "automatic", (f"{paper_too}On the real account, what it decides{asked} and fits your box is sent to "
                                           "the broker without you.")
        elif proposals:
            level, headline = "proposals", (f"{paper_too}On the real account it writes proposals{asked}; each one waits for your "
                                           "approval.")
        else:
            level, headline = ("paper" if account == "both" else "looks"), f"{paper_too}On the real account it only looks and reports."
    return {"level": level, "headline": headline, "mode": mode, "account": account, "access": access, "owner": owner,
            "missing": sum(1 for r in rows if r["state"] == "missing"), "rows": rows}
