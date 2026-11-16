"""Wake-ups: the app watches for the assistant, and wakes it when what it asked about happens.

A review by the assistant costs money every time; a rule checked by the app costs nothing. So instead of
having the assistant look again every so many minutes, it can leave the watching to the app:

- An alert may be marked "wake the assistant" (`wake`), by the assistant itself (its `save_alert` tool) or by
  the person on the Alerts page. The app checks it in code as prices update, with the app open or, for the
  brokerage account's owner, from the server's own looks.
- When it fires, what happened is put in a small queue here. The autopilot then runs a short review about
  that event only ("event"), in the modes that wake it; otherwise the next review is told of it.
- The automation's own way out of a real position (a stop-loss or take-profit sale it sent) is queued the
  same way, so the assistant hears that the position is going. Not when the owner set the autopilot to the
  paper portfolio only: the real account is then none of a review's business, and waking it would cost for nothing.

Nothing here calls the model or sends an order: it only remembers what happened until a review reads it.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from .assistant_prefs import prefs
from .data.calendar import CAIRO
from .services import App, now_iso, retry_conflict

QUEUE = ("settings", "assistant_wakes")
MAX_PENDING = 12          # what waits for one review; older ones give way
MAX_WATCHES = 12          # the wake alerts the assistant may have switched on at once
WATCH_DAYS = 14           # a wake alert that has not fired by then is switched off
EVENT_GAP_SECONDS = 300   # at least this long after any review before an event wakes it, so a burst is one review
EVENT_HOURS = 20          # what happened longer ago than this is no longer news: it is dropped, not told
WOKEN = ("events", "intraday")   # the autopilot modes in which an event starts a review of its own
log = logging.getLogger("egx.wakes")


def _hours_old(event: dict) -> float:
    try:
        return (datetime.now(UTC) - datetime.fromisoformat(event["ts"])).total_seconds() / 3600
    except (KeyError, TypeError, ValueError):
        return 0.0


def pending(core: App) -> list[dict]:
    """What waits for the assistant, without what has grown too old to act on."""
    return [e for e in (core.store.get(*QUEUE) or {}).get("pending") or [] if _hours_old(e) < EVENT_HOURS]


def listening(core: App) -> bool:
    """Whether anything is kept for the assistant at all: with the autopilot off there is no review to tell."""
    return prefs(core)["autopilot"]["mode"] != "off"


def add(core: App, events: list[dict]) -> None:
    """Queue what happened. Called inside the caller's own unit of work, so it is kept or dropped with it."""
    if events:
        core.store.put(*QUEUE, {"pending": [*pending(core), *events][-MAX_PENDING:]})


def take(core: App) -> list[dict]:
    """What waits, handed to the review that claims it: called inside the claim, so two reviews never both get it."""
    waiting = pending(core)
    if (core.store.get(*QUEUE) or {}).get("pending"):
        core.store.put(*QUEUE, {"pending": []})   # the stale ones go with it
    return waiting


def give_back(core: App, events: list[dict]) -> None:
    """A review that failed before it did anything returns what it was told, so the next one hears of it.
    Never raises: this runs after a failure, and must not hide it."""
    try:
        retry_conflict(add)(core, events)
    except Exception:  # noqa: BLE001
        log.exception("wakes: what a failed review was told could not be kept for the next one")


def wakes_now(core: App) -> bool:
    """Whether an event starts a review of its own for this person, or only waits for their next one."""
    return prefs(core)["autopilot"]["mode"] in WOKEN


def note_exits(core: App, result: dict) -> int:
    """After a look by the automation: each sale it sent on its own way out of a position is queued for the
    assistant, when events wake it and its reviews have the real account in them. Never raises: word of a look
    must not break the look."""
    try:
        exits = [o for o in (result.get("exits") or []) if o.get("status") == "sent"]
        # An exit exists only for the account's owner, so what they chose is what counts: set to the paper portfolio
        # only, the autopilot is not told about the real account.
        if not exits or not wakes_now(core) or prefs(core)["autopilot"]["account"] == "paper":
            return 0
        events = [{"ts": now_iso(), "kind": "real_exit", "symbol": o["symbol"], "note": "",
                   "message": f"The app sent a sale of {o['qty']:,} {o['symbol']} at {float(o['price']):g} on the real account, "
                              f"on its own way out of the position: {str(o.get('reason') or '').strip()[:200]}"}
                  for o in exits]
        retry_conflict(add)(core, events)
        return len(events)
    except Exception:  # noqa: BLE001
        log.exception("wakes: the automation's exits could not be queued for the assistant")
        return 0


def lines(events: list[dict]) -> list[str]:
    """What happened, one line each, for the assistant's brief."""
    out = []
    for e in events:
        try:
            when = f"{datetime.fromisoformat(e['ts']).astimezone(CAIRO):%Y-%m-%d %H:%M} Cairo time"
        except (KeyError, TypeError, ValueError):
            when = "a moment ago"
        note = f" Your note when you set it: “{e['note']}”" if e.get("note") else ""
        out.append(f"- {when}: {e.get('message') or e.get('kind')}.{note}")
    return out
