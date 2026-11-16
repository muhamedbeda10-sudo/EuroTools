"""Who is asking: the server's own check of a sign-in.

The database is opened with the server's own password, so nothing outside the server decides who may
read a row. Before it reads a single one for anybody, the server checks two things:

1. The token is genuine and current (`TokenVerifier`). A Firebase ID token is signed by Google with
   keys it publishes. The signature is verified against them, and the token must be for this
   project, issued by this project's sign-in service, and not expired. Nothing in a token that
   fails any of this is believed, including the account it names.

2. The account may use the app (`AccountGate`). Being able to sign in is not enough: an
   administrator opens an account, and can close it again (app/accounts.py). The record of that is
   a row in `egx.accounts`. An account without a row, or with a closed one, is not let in. The
   answer is kept for a minute, so closing an account takes effect within a minute.
"""
from __future__ import annotations

import base64
import json
import threading
import time

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
                    found, life = self._fetch()
                    usable = {kid: k for kid, k in found.items() if isinstance(k, dict) and k.get("n") and k.get("e")}
                    if not usable:
                        raise ValueError("the key service answered without a usable key")
                    self._keys = usable
                    self._expires = now + max(life, KEYS_MIN_AGE)
                except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
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
        return self.claims(token)["sub"]

    def claims(self, token: str) -> dict:
        """What a genuine, current token says (its account is `sub`). Anything else is AuthError."""
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
        return claims


class AccountGate:
    """Whether an account may use the app: its row in `egx.accounts`, read at most once a minute per server instance."""

    def __init__(self, db):
        self._db = db
        self._known: dict[str, tuple[bool, float]] = {}
        self._lock = threading.Lock()

    def forget(self, uid: str) -> None:
        """An account was just opened or closed here: do not go on believing what was read before."""
        with self._lock:
            self._known.pop(uid, None)

    def check(self, uid: str) -> None:
        """Returns when the account may use the app; AuthError when it may not."""
        now = time.monotonic()
        with self._lock:
            known = self._known.get(uid)
        if known and now - known[1] < (ALLOWED_FOR if known[0] else REFUSED_FOR):
            allowed = known[0]
        else:
            row = self._db.one("select active from egx.accounts where uid=%s", (uid,))
            allowed = bool(row and row[0])
            with self._lock:
                self._known[uid] = (allowed, now)
                while len(self._known) > 500:
                    self._known.pop(next(iter(self._known)))
        if not allowed:
            raise AuthError("not signed in, or this account is not allowed to use the app")
