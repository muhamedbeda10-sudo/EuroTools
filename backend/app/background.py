"""The automation without a browser: the server takes the looks itself, on a timer, as the owner.

Automatic real orders (real_auto.py) run from the owner's open app. This module lets the same looks
happen with the app closed. A timer on the hosting platform calls one address every minute during
the session (`vercel.json`, `crons`); the server then does what the open app would have done: reads
the live prices, takes the automation's look, runs the assistant's review when one is due, and tells
the owner's devices what happened (push.py).

Whose hands the server works with
    The API holds no database credentials: every request reads and writes the signed-in person's own
    data with that person's sign-in. A timer has no sign-in. So the owner lends theirs, deliberately:
    in Settings they create a *background key*, which is their sign-in's renewal token, sealed with a
    key only the server can derive (push.secret). The sealed key is placed in the server's
    environment (BACKGROUND_KEY). With it the server signs in as the owner and nobody else, and the
    database applies the owner's own rules to everything it does, exactly as when the app is open.

What keeps it in hand
    * The timer's call is accepted only with the platform's own secret (CRON_SECRET).
    * The sealed key is useless outside this server: it cannot be opened without the server's secret,
      and it is never accepted from a request, only read from the environment.
    * The owner's switch is in their own data. Off, a look ends before it does anything. Creating a
      new key retires the old one at once.
    * Nothing here decides anything. What may be sent is decided where it always was: the owner's box
      and limits (real_auto.py, real_orders.py), checked at every look.

What it does not do
    It does not run outside the session, it does not keep the phone awake, and it cannot tell the
    owner that it has stopped: the app shows when the last background look was, and says so when
    there has been none for a few minutes during the session.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import threading
import time as clock
import uuid
from datetime import time

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import BaseModel, ConfigDict, Field

from . import assistant, push, real_auto, real_orders
from .config import Settings
from .data.calendar import cairo_now, is_trading_day, market_open
from .services import App, now_iso
from .store.errors import AuthError, ConflictError

log = logging.getLogger(__name__)

SWITCH = ("settings", "background")        # the owner's switch, and which key is the current one
BEAT = ("settings", "background_beat")     # when the server last looked, and what came of it
PREFIX = "bk1."
EARLIEST, LATEST = time(9, 40), time(15, 40)   # Cairo: a little before the opening bell to a while after the close
STALE_SECONDS = 4 * 60.0                   # no look for this long during the session is worth saying
# One call of the timer may run for five minutes at most. A review is begun only early in it, and what the review
# proposed is judged in the same call only while there is comfortably time left to finish sending an order.
REVIEW_LATEST_START, SECOND_LOOK_LATEST = 45.0, 235.0
_tokens: dict[str, tuple[str, float]] = {}  # the owner's short-lived sign-in, kept while this instance lives
_tokens_lock = threading.Lock()


class BackgroundError(ValueError):
    """Background running cannot be set up or used as asked. Shown to the person."""


class KeyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: str = Field(min_length=20, max_length=4000)


class SwitchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


# ---- the sealed key ----------------------------------------------------------------------
def seal(settings: Settings, payload: dict) -> str:
    key = push.derive(settings, "egx-intelligence/background/seal/v1")
    if key is None:
        raise BackgroundError("Background running needs a secret on the server, which is not set.")
    nonce = os.urandom(12)
    return PREFIX + push.b64(nonce + AESGCM(key).encrypt(nonce, json.dumps(payload).encode(), PREFIX.encode()))


def unseal(settings: Settings, sealed: str) -> dict | None:
    """What a background key holds, or None when it is not one of this server's."""
    key = push.derive(settings, "egx-intelligence/background/seal/v1")
    if key is None or not sealed.startswith(PREFIX):
        return None
    try:
        raw = push.unb64(sealed[len(PREFIX):].strip())
        payload = json.loads(AESGCM(key).decrypt(raw[:12], raw[12:], PREFIX.encode()))
    except (InvalidTag, ValueError):
        return None
    return payload if isinstance(payload, dict) and {"uid", "rt", "kid"} <= set(payload) else None


def _exchange(settings: Settings, refresh_token: str) -> dict:
    """Renew a sign-in at Firebase. Returns {"id_token", "user_id", "expires_in"}."""
    emulator = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
    base = f"http://{emulator}/" if emulator else "https://"
    try:
        res = httpx.post(f"{base}securetoken.googleapis.com/v1/token", params={"key": settings.firebase_web_api_key or "none"},
                         data={"grant_type": "refresh_token", "refresh_token": refresh_token}, timeout=10.0)
    except httpx.HTTPError as exc:
        raise BackgroundError(f"The sign-in service could not be reached ({type(exc).__name__}).") from None
    if res.status_code != 200:
        try:
            said = str((res.json().get("error") or {}).get("message") or "")
        except ValueError:
            said = ""
        if any(word in said for word in ("TOKEN_EXPIRED", "INVALID_REFRESH_TOKEN", "USER_DISABLED", "USER_NOT_FOUND", "INVALID_GRANT")):
            raise BackgroundError("The sign-in behind the background key is no longer accepted: the password was changed, or the "
                                  "sign-in was ended. Create a new key in Settings.")
        raise BackgroundError(f"The sign-in service refused the server's request ({res.status_code}). The project's web key may "
                              "not allow requests that come from a server.")
    body = res.json()
    return {"id_token": body["id_token"], "user_id": body["user_id"], "expires_in": int(body.get("expires_in") or 3600)}


def _sign_in(settings: Settings, creds: dict) -> str:
    """The owner's sign-in for this look: renewed when the one in hand is close to running out."""
    name = hashlib.sha256(f"{creds['uid']}|{creds['rt']}".encode()).hexdigest()
    with _tokens_lock:
        held = _tokens.get(name)
        if held and held[1] - clock.monotonic() > 300:
            return held[0]
        signed = _exchange(settings, creds["rt"])
        if signed["user_id"] != creds["uid"]:
            raise BackgroundError("The background key signs in as someone else. Create a new key.")
        _tokens.clear()
        _tokens[name] = (signed["id_token"], clock.monotonic() + signed["expires_in"])
        return signed["id_token"]


def reset() -> None:
    """Forget the sign-in in hand (tests)."""
    with _tokens_lock:
        _tokens.clear()


# ---- the owner's side: the key, the switch, and what they are shown ---------------------
def _switch(core: App) -> dict:
    saved = core.store.get(*SWITCH) or {}
    return {"enabled": bool(saved.get("enabled")), "kid": saved.get("kid"), "made_at": saved.get("made_at")}


def _server_key(core: App) -> str:
    """How the key in the server's environment relates to this owner: none, unreadable, other, replaced or ok."""
    sealed = core.settings.background_key.strip()
    if not sealed:
        return "none"
    if not core.signed_in:
        return "ok" if sealed == "local" else "unreadable"
    creds = unseal(core.settings, sealed)
    if creds is None:
        return "unreadable"
    if creds["uid"] != core.uid:
        return "other"
    return "ok" if creds["kid"] == _switch(core)["kid"] else "replaced"


def view(core: App) -> dict:
    real_orders._owner(core)
    switch, now = _switch(core), cairo_now()
    beat = core.store.get(*BEAT)
    waiting = bool(switch["enabled"] and market_open(now) and (beat is None or real_orders._age(beat.get("at")) > STALE_SECONDS))
    return {"available": push.secret(core.settings) is not None, "timer_ready": bool(core.settings.cron_secret),
            "server_key": _server_key(core), "enabled": switch["enabled"], "key_made_at": switch["made_at"],
            "beat": beat, "silent": waiting, "market_open": market_open(now)}


def menu(core: App) -> bool:
    """For the open app: whether the server is taking looks by itself for this owner. One small read."""
    return bool(core.younit is not None and core.real_account_allowed and _switch(core)["enabled"])


def make_key(core: App, body: KeyIn) -> dict:
    """Seal the owner's sign-in into a key for the server's environment. Creating one retires the one before it."""
    real_orders._owner(core)
    if not core.signed_in or not core.uid:
        raise BackgroundError("Background running is for the deployed app, where there is a sign-in to lend.")
    signed = _exchange(core.settings, body.refresh_token)
    if signed["user_id"] != core.uid:
        raise BackgroundError("That sign-in is not this account's.")
    kid = uuid.uuid4().hex[:12]
    sealed = seal(core.settings, {"uid": core.uid, "rt": body.refresh_token, "kid": kid, "at": now_iso()})
    with core.store.transaction():
        # a new key starts switched off: it does nothing until it is on the server and the owner switches it on
        core.store.put(*SWITCH, {"enabled": False, "kid": kid, "made_at": now_iso()})
        core.audit("key", "background", {"kid": kid})
    return {"key": sealed, **view(core)}


def set_enabled(core: App, body: SwitchIn) -> dict:
    real_orders._owner(core)
    switch = _switch(core)
    if body.enabled:
        if not core.settings.cron_secret:
            raise BackgroundError("The server's timer is not set up yet (CRON_SECRET).")
        state = _server_key(core)
        if state != "ok":
            raise BackgroundError({"none": "There is no background key on the server yet. Create one below and add it there.",
                                   "unreadable": "The background key on the server cannot be read by this server. Create a new one.",
                                   "other": "The background key on the server belongs to another sign-in.",
                                   "replaced": "The key on the server is an older one. Put the latest key there, or create a new one."}[state])
    if switch["enabled"] != body.enabled:
        with core.store.transaction():
            core.store.put(*SWITCH, {**switch, "enabled": body.enabled})
            core.audit("switch", "background", {"enabled": body.enabled})
    return view(core)


# ---- the timer's side --------------------------------------------------------------------
def check_timer(settings: Settings, header: str | None) -> None:
    """Only the platform's own timer may wake the server: it sends the secret the platform holds."""
    if not settings.cron_secret or not hmac.compare_digest((header or "").encode(), f"Bearer {settings.cron_secret}".encode()):
        raise AuthError("not the timer")


def wake(settings: Settings, build_core, model, *, firestore: bool, may_review=None) -> dict:
    """The timer rang. Sign in as the owner and take a look; say plainly why not, when not."""
    now = cairo_now()
    if not (is_trading_day(now.date()) and EARLIEST <= now.time() <= LATEST):
        return {"ran": False, "why": "outside the session"}
    sealed = settings.background_key.strip()
    if not sealed:
        return {"ran": False, "why": "no background key on the server"}
    if not firestore:   # a local run has no sign-in to lend: it looks only when told to in so many words
        return look(build_core(None, None), model, may_review=may_review) if sealed == "local" else \
            {"ran": False, "why": "no background key on the server"}
    creds = unseal(settings, sealed)
    if creds is None:
        log.warning("background: the key in the environment cannot be opened by this server")
        return {"ran": False, "why": "the background key on the server cannot be read"}
    try:
        token = _sign_in(settings, creds)
    except BackgroundError as exc:
        log.warning("background: %s", exc)
        return {"ran": False, "why": str(exc)}
    return look(build_core(creds["uid"], token), model, kid=creds["kid"], may_review=may_review)


def _prices(core: App, out: dict) -> None:
    """Read the prices the look will judge by. Whatever goes wrong here, the look goes on: a stop-loss is not
    skipped because a price could not be read, it is judged by what the broker itself says for that stock."""
    try:
        if market_open(cairo_now()):
            core.poll_live()
        elif core.provider_status().get("refresh_due"):
            done = core.refresh_feed()   # the session's final bars, a batch at each look until none are left
            out["data"] = {k: done.get(k) for k in ("updated", "remaining")}
        core.bootstrap()                 # see what was just read
    except Exception as exc:  # noqa: BLE001 - anything at all: the look must still reach the automation and leave word
        log.warning("background: prices could not be read (%s)", type(exc).__name__)
        out["data_problem"] = (str(exc) or type(exc).__name__)[:300]


def _may_go_on(core: App, kid: str | None) -> str | None:
    """Why the look must stop here, read from the database as it is this instant; None when it may go on."""
    switch = _switch(core)
    if not switch["enabled"]:
        return "background running is switched off"
    if kid is not None and switch["kid"] != kid:
        return "the key on the server was replaced by a newer one"
    if core.younit is None or not core.real_account_allowed:
        return "this sign-in is not the brokerage account's owner"
    return None


def look(core: App, model, *, kid: str | None = None, may_review=None) -> dict:
    """One look by the server for one owner: prices, the automation, the assistant's review when due.

    `may_review(core)` says whether this person may use the assistant at all, as the open app's own route asks.
    """
    started = clock.monotonic()
    why_not = _may_go_on(core, kid)
    if why_not:
        return {"ran": False, "why": why_not}
    out: dict = {"ran": True}
    result: dict = {"ran": False, "why": "the look failed before it reached the automation"}
    pushed = {"sent": 0, "failed": 0, "removed": 0}
    review = None
    try:
        _prices(core, out)
        # the automation's look, and word of it to the owner's devices
        result = real_auto.tick(core)
        pushed = push.report(core, result)
        # The assistant's review comes last, because it can take minutes, and only while there is time for it
        # and for what follows inside this one call.
        if model is not None and clock.monotonic() - started < REVIEW_LATEST_START and (may_review is None or may_review(core)):
            try:
                review = assistant.run_autopilot(core, model)
            except Exception as exc:  # noqa: BLE001 - a review that failed must not hide what the look did
                log.exception("background: the assistant's review failed")
                review = {"ran": True, "error": f"{type(exc).__name__}"}
            if review.get("ran") and review.get("error"):
                push.send(core, "Autopilot", f"The assistant's review stopped: {review['error']}", tag="autopilot")
            elif review.get("ran") and review.get("changes") and clock.monotonic() - started < SECOND_LOOK_LATEST:
                # What it just proposed is judged now, not a minute from now. Minutes may have passed: everything is
                # read again first, the owner's switches included, and the prices are read anew.
                core.store.fresh()
                stopped = _may_go_on(core, kid)
                if stopped:
                    out["after_review"] = stopped
                else:
                    _prices(core, out)
                    again = real_auto.tick(core)
                    for k, v in push.report(core, again).items():
                        pushed[k] += v
                    result = {**again, "notes": [*result.get("notes", []), *again.get("notes", [])],
                              "sent": [*result.get("sent", []), *again.get("sent", [])],
                              "exits": [*result.get("exits", []), *again.get("exits", [])]}
    finally:   # word of the look is left whatever happened in it, so the app can tell a look that failed from none at all
        out.update(auto={"ran": bool(result.get("ran")), "why": result.get("why"), "sent": len(result.get("sent") or []),
                         "exits": len(result.get("exits") or [])},
                   pushed=pushed, review={k: review.get(k) for k in ("ran", "reason", "changes", "error")} if review else None)
        _beat(core, result, out)
    return out


def _beat(core: App, result: dict, out: dict) -> None:
    """Leave word of this look where the open app will read it."""
    try:
        # "busy" means another look was at it in that very moment: the server did look, and there is nothing to explain
        core.store.put(*BEAT, {"at": now_iso(), "ran": bool(result.get("ran") or result.get("busy")),
                               "why": None if result.get("busy") else result.get("why"),
                               "sent": out["auto"]["sent"], "exits": out["auto"]["exits"], "notes": (result.get("notes") or [])[:8],
                               "data_problem": out.get("data_problem")})
    except ConflictError:
        pass   # another look wrote its own at the same moment
