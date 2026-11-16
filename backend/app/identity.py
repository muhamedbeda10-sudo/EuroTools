"""Who is asking: the server's own check of a sign-in.

With Firestore the server could pass a sign-in token on and let the database decide whether it was
genuine. The Postgres database is opened with the server's own password, so that question is the
server's to answer now, before it reads a single row for anybody. Two things are checked:

1. The token is genuine and current (`TokenVerifier`). A Firebase ID token is signed by Google with
   keys it publishes. The signature is verified against them, and the token must be for this
   project, issued by this project's sign-in service, and not expired. Nothing in a token that
   fails any of this is believed, including the account it names.

2. The account may use the app (`AccountGate`). Being able to sign in is not enough: an
   administrator opens an account for EGX Intelligence (`egxAccounts`) or for the quality system
   (`users`), and can close it again. Those records stay where the administrator keeps them, in
   Firestore, and are asked with the caller's own token, as before. The answer is kept for a
   minute, so closing an account takes effect within a minute, and is kept in the database for the
   hours in which the sign-in service cannot be asked at all.
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
from datetime import UTC, datetime, timedelta

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers

from .store.errors import AuthError, StoreUnavailable

KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
KEYS_MIN_AGE = 60.0          # an unknown key id makes the keys be read again, but not more often than this
KEYS_DEFAULT_LIFE = 3600.0
CLOCK_LEEWAY = 60            # seconds a clock may be off by
ALLOWED_FOR = 60.0           # how long "this account may use the app" is believed without asking again
REFUSED_FOR = 15.0
GRACE = timedelta(hours=24)  # how old the last known answer may be when the sign-in service cannot be asked


def _b64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _fetch_keys() -> tuple[dict, float]:
    """Google's current signing keys and for how many seconds they may be kept."""
    res = httpx.get(KEYS_URL, timeout=10.0)
    res.raise_for_status()
    life = KEYS_DEFAULT_LIFE
    for piece in res.headers.get("cache-control", "").split(","):
        name, _, value = piece.strip().partition("=")
        if name == "max-age" and value.isdigit():
            life = float(value)
    return {k["kid"]: k for k in res.json().get("keys", []) if k.get("kty") == "RSA" and k.get("kid")}, life


class TokenVerifier:
    """Checks Firebase ID tokens for one project. Safe to share between requests."""

    def __init__(self, project_id: str, *, fetch_keys=_fetch_keys, now=time.time):
        if not project_id:
            raise ValueError("a project is needed to verify sign-ins for")
        self._project = project_id
        self._fetch, self._now = fetch_keys, now
        self._keys: dict[str, dict] = {}
        self._fetched = self._expires = 0.0
        self._lock = threading.Lock()

    def _key(self, kid: str):
        with self._lock:
            now = time.monotonic()
            unknown = kid not in self._keys and now - self._fetched >= KEYS_MIN_AGE
            if unknown or now >= self._expires or not self._fetched:
                try:
                    self._keys, life = self._fetch()
                    self._expires = now + max(life, KEYS_MIN_AGE)
                except (httpx.HTTPError, ValueError, KeyError):
                    if not self._keys:
                        raise StoreUnavailable("sign-ins cannot be checked right now; try again in a moment") from None
                    self._expires = now + KEYS_MIN_AGE   # keep the keys there are, and ask again soon
                self._fetched = now
            jwk = self._keys.get(kid)
        if jwk is None:
            return None
        return RSAPublicNumbers(int.from_bytes(_b64(jwk["e"]), "big"), int.from_bytes(_b64(jwk["n"]), "big")).public_key()

    def verify(self, token: str) -> str:
        """The account a genuine, current token is for. Anything else is AuthError."""
        refused = AuthError("invalid sign-in token")
        try:
            head64, body64, sig64 = token.split(".")
            head, claims, signature = json.loads(_b64(head64)), json.loads(_b64(body64)), _b64(sig64)
        except Exception:  # noqa: BLE001 - any malformed token is the same answer
            raise refused from None
        if not isinstance(head, dict) or not isinstance(claims, dict) or head.get("alg") != "RS256" or not isinstance(head.get("kid"), str):
            raise refused
        key = self._key(head["kid"])
        if key is None:
            raise refused
        try:
            key.verify(signature, f"{head64}.{body64}".encode(), padding.PKCS1v15(), hashes.SHA256())
        except InvalidSignature:
            raise refused from None
        now = self._now()
        uid = claims.get("sub")

        def number(name):
            value = claims.get(name)
            return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
        if claims.get("aud") != self._project or claims.get("iss") != f"https://securetoken.google.com/{self._project}":
            raise refused
        if not isinstance(uid, str) or not uid or "/" in uid or len(uid) > 128:
            raise refused
        if number("exp") is None or number("iat") is None or number("iat") > now + CLOCK_LEEWAY:
            raise refused
        if number("exp") <= now - CLOCK_LEEWAY:
            raise AuthError("the sign-in has expired; sign in again")
        if number("auth_time") is not None and number("auth_time") > now + CLOCK_LEEWAY:
            raise refused
        return uid


def ask_firestore(project_id: str, uid: str, token: str) -> bool | None:
    """Does an administrator's record say this account may use the app? None when it cannot be asked.

    Asked with the caller's own token, which the Firestore rules let read exactly two things about
    itself: its `egxAccounts` document, and its `users` document while that account is active.
    """
    emulator = os.environ.get("FIRESTORE_EMULATOR_HOST")
    root = f"{'http://' + emulator if emulator else 'https://firestore.googleapis.com'}/v1/projects/{project_id}/databases/(default)/documents"
    unknown = False
    for coll in ("egxAccounts", "users"):
        try:
            res = _http.get(f"{root}/{coll}/{uid}", headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError:
            unknown = True
            continue
        if res.status_code == 200:
            try:
                if res.json()["fields"]["active"]["booleanValue"] is True:
                    return True
            except (ValueError, KeyError, TypeError):
                pass
        elif res.status_code not in (401, 403, 404):
            unknown = True     # refusing requests (429) or failing (5xx): this is not an answer about the account
    return None if unknown else False


_http = httpx.Client(timeout=10.0)


class AccountGate:
    """Whether an account may use the app, asked at most once a minute per server instance."""

    def __init__(self, db, ask):
        self._db, self._ask = db, ask                    # ask(uid, token) -> True | False | None
        self._known: dict[str, tuple[bool, float]] = {}
        self._lock = threading.Lock()

    def check(self, uid: str, token: str) -> None:
        """Returns when the account may use the app; AuthError when it may not; StoreUnavailable when nobody can say."""
        now = time.monotonic()
        with self._lock:
            known = self._known.get(uid)
        if known and now - known[1] < (ALLOWED_FOR if known[0] else REFUSED_FOR):
            allowed = known[0]
        else:
            allowed = self._ask(uid, token)
            if allowed is None:
                row = self._db.one("select active, checked_at from egx.accounts where uid=%s", (uid,))
                if row is None or datetime.now(UTC) - row[1] > GRACE:
                    raise StoreUnavailable("the sign-in service cannot be asked about this account right now; try again in a moment")
                allowed = bool(row[0])
            else:
                self._db.one("insert into egx.accounts (uid, active, checked_at) values (%s,%s,now()) on conflict (uid) do update "
                             "set active=excluded.active, checked_at=excluded.checked_at returning uid", (uid, allowed))
            with self._lock:
                self._known[uid] = (allowed, now)
                while len(self._known) > 500:
                    self._known.pop(next(iter(self._known)))
        if not allowed:
            raise AuthError("not signed in, or this account is not allowed to use the app")
