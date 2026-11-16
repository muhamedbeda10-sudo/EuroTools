"""Notifications to the owner's devices when the app is not on screen (Web Push).

Used for one thing: telling the owner of the brokerage account what the automation did with real
money, or that it needs them, when nobody is looking at the app. The installed app on a phone, or a
browser on a computer, subscribes once; the subscription is kept in the owner's own data.

How a message travels
    The browser gives the app an address at its own push service (Google's for Chrome and Android,
    Apple's for an installed app on an iPhone, Mozilla's for Firefox) and a public key. The server
    encrypts the message for that key (RFC 8291), signs the request as this application (VAPID,
    RFC 8292) and posts it to that address. The push service cannot read the message. The app's
    service worker shows it.

No account anywhere, and no key to keep
    The application's signing key is not stored: it is derived from a secret the server already has
    (see `secret`), so it is the same on every server instance and never leaves it.

What is sent
    A title and a sentence: which order, which stock, what became of it. Never a balance and never an
    account number.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import BaseModel, ConfigDict, Field

from . import real_orders
from .config import Settings
from .services import App, now_iso
from .store.errors import ConflictError

log = logging.getLogger(__name__)

SUBS = "push_subs"
SEEN = ("settings", "push_seen")     # which remarks were already sent, so the same one is not sent every minute
MAX_DEVICES = 8
MIN_SECRET = 16                      # a secret shorter than this is no secret: the features that need one stay off
MAX_REMARKS = 4                      # remarks told in one look; the rest are told at the next
SAME_REMARK_SECONDS = 30 * 60.0
RECORD_SIZE = 4096
# The push services browsers use. A subscription's address is written by the browser; the server posts
# only to these, so it cannot be pointed at anything else.
SERVICES = ("fcm.googleapis.com", "jmt17.google.com", "android.googleapis.com", "updates.push.services.mozilla.com",
            "push.services.mozilla.com", ".push.apple.com", ".notify.windows.com")
_P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


class PushError(ValueError):
    """Notifications cannot be set up as asked. Shown to the person."""


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ---- the server's own secret, and what is derived from it --------------------------------
def secret(settings: Settings) -> bytes | None:
    """What keys are derived from: BACKGROUND_SECRET when set, else the broker credentials the server holds.

    Either one exists only on the server. Without one there is nothing to derive a key from, and the
    features that need a key say they are not available.
    """
    material = settings.background_secret or (f"{settings.younit_trading_id}|{settings.younit_api_key}" if settings.younit_api_key else "")
    # The notification key's public half is sent to the push services with every message, so a short secret
    # could be guessed from it, and with it the sealed sign-in opened. A short one is treated as none at all.
    return material.encode() if len(material.strip()) >= MIN_SECRET else None


def derive(settings: Settings, purpose: str, length: int = 32) -> bytes | None:
    material = secret(settings)
    if material is None:
        return None
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=None, info=purpose.encode()).derive(material)


def _signing_key(settings: Settings) -> ec.EllipticCurvePrivateKey | None:
    seed = derive(settings, "egx-intelligence/push/vapid/v1")
    if seed is None:
        return None
    return ec.derive_private_key(int.from_bytes(seed, "big") % (_P256_ORDER - 1) + 1, ec.SECP256R1())


def _point(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def public_key(settings: Settings) -> str | None:
    """The application's public key, which a browser needs in order to subscribe."""
    key = _signing_key(settings)
    return b64(_point(key.public_key())) if key else None


# ---- the two standards -------------------------------------------------------------------
def encrypt(message: bytes, p256dh: str, auth: str, *, sender: ec.EllipticCurvePrivateKey | None = None,
            salt: bytes | None = None) -> bytes:
    """Encrypt one message for one subscription (RFC 8291, "aes128gcm"). `sender` and `salt` are given only by tests."""
    if len(message) > RECORD_SIZE - 17 - 86:
        raise PushError("the notification is too long")
    theirs = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(p256dh))
    sender = sender or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    ours = _point(sender.public_key())
    shared = sender.exchange(ec.ECDH(), theirs)
    ikm = HKDF(algorithm=hashes.SHA256(), length=32, salt=unb64(auth),
               info=b"WebPush: info\x00" + _point(theirs) + ours).derive(shared)
    key = HKDF(algorithm=hashes.SHA256(), length=16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(algorithm=hashes.SHA256(), length=12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(ikm)
    header = salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(ours)]) + ours
    return header + AESGCM(key).encrypt(nonce, message + b"\x02", None)   # 0x02: the last (and only) record


def authorization(settings: Settings, endpoint: str, contact: str, *, now: float | None = None) -> str:
    """The header that tells the push service which application is sending (VAPID, RFC 8292)."""
    key = _signing_key(settings)
    if key is None:
        raise PushError("notifications need a secret on the server")
    address = urlsplit(endpoint)
    claims = {"aud": f"{address.scheme}://{address.netloc}", "exp": int(now or time.time()) + 12 * 3600, "sub": contact}
    signed = b64(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode()) + "." + \
        b64(json.dumps(claims, separators=(",", ":")).encode())
    r, s = decode_dss_signature(key.sign(signed.encode(), ec.ECDSA(hashes.SHA256())))
    return f"vapid t={signed}.{b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}, k={public_key(settings)}"


def contact(settings: Settings) -> str:
    """Who the push service may write to about this application: the app's own address, never a person's."""
    host = settings.public_host or os.environ.get("VERCEL_PROJECT_PRODUCTION_URL") or "euro-tools-delta.vercel.app"
    return f"https://{host}"


# ---- the owner's devices -----------------------------------------------------------------
class Keys(BaseModel):
    model_config = ConfigDict(extra="ignore")

    p256dh: str = Field(min_length=80, max_length=120)
    auth: str = Field(min_length=16, max_length=64)


class SubscriptionIn(BaseModel):
    """What a browser hands the page when it subscribes (PushSubscription.toJSON())."""
    model_config = ConfigDict(extra="ignore")

    endpoint: str = Field(min_length=20, max_length=1000)
    keys: Keys
    label: str = Field(default="", max_length=80)


class EndpointIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    endpoint: str = Field(min_length=20, max_length=1000)


def _allowed(endpoint: str) -> bool:
    address = urlsplit(endpoint)
    host = (address.hostname or "").lower()
    return address.scheme == "https" and any(host == s or (s.startswith(".") and host.endswith(s)) for s in SERVICES)


def _id(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode()).hexdigest()[:24]


def status(core: App) -> dict:
    real_orders._owner(core)
    key = public_key(core.settings)
    devices = core.store.list(SUBS) if key else []
    return {"available": key is not None, "public_key": key,
            "devices": [{"id": d["id"], "label": d.get("label") or "A device", "since": d.get("created_at")} for d in devices]}


def subscribe(core: App, body: SubscriptionIn) -> dict:
    real_orders._owner(core)
    if public_key(core.settings) is None:
        raise PushError("Notifications need a secret on the server, which is not set.")
    if not _allowed(body.endpoint):
        raise PushError("This browser's notification service is not one the app sends to.")
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(body.keys.p256dh))
        if len(unb64(body.keys.auth)) != 16:
            raise ValueError
    except ValueError:
        raise PushError("The browser's notification keys could not be read.") from None
    known = {d["id"] for d in core.store.list(SUBS)}
    doc = {"id": _id(body.endpoint), "endpoint": body.endpoint, "keys": body.keys.model_dump(), "label": body.label.strip(),
           "created_at": now_iso()}
    if doc["id"] not in known and len(known) >= MAX_DEVICES:
        raise PushError(f"{MAX_DEVICES} devices already receive notifications. Remove one first.")
    core.store.put(SUBS, doc["id"], doc)
    if doc["id"] not in known:
        core.audit("subscribe", "push", {"label": doc["label"]})
    return status(core)


def unsubscribe(core: App, body: EndpointIn) -> dict:
    real_orders._owner(core)
    if core.store.delete(SUBS, _id(body.endpoint)):
        core.audit("unsubscribe", "push", {})
    return status(core)


# ---- sending -----------------------------------------------------------------------------
def _deliver(core: App, device: dict, payload: bytes, post) -> str:
    """Send one message to one device. Returns "sent", "failed" or "gone" (the browser dropped the subscription)."""
    try:
        if not _allowed(device["endpoint"]):
            raise PushError("not a push service")
        res = post(device["endpoint"], content=encrypt(payload, device["keys"]["p256dh"], device["keys"]["auth"]),
                   headers={"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "3600",
                            "Urgency": "high", "Authorization": authorization(core.settings, device["endpoint"], contact(core.settings))},
                   timeout=5.0)
    except (httpx.HTTPError, PushError, ValueError, KeyError) as exc:
        log.warning("push: one device could not be reached (%s)", type(exc).__name__)
        return "failed"
    if res.status_code in (404, 410):
        return "gone"
    if res.status_code >= 400:
        log.warning("push: the service answered %s", res.status_code)
        return "failed"
    return "sent"


def send(core: App, title: str, message: str, *, tag: str | None = None, url: str = "/account", post=None) -> dict:
    """Send one notification to every device of the owner, all at once. Never raises: a notification must not break what it reports."""
    out = {"sent": 0, "failed": 0, "removed": 0}
    try:
        if _signing_key(core.settings) is None:
            return out
        devices = core.store.list(SUBS)[:MAX_DEVICES]
        if not devices:
            return out
        payload = json.dumps({"title": title[:120], "body": message[:600], "tag": tag, "url": url}, ensure_ascii=False).encode()
        post = post or httpx.post
        with ThreadPoolExecutor(len(devices)) as pool:   # together, so one slow service does not hold the others up
            outcomes = list(pool.map(lambda d: _deliver(core, d, payload, post), devices))
        for device, outcome in zip(devices, outcomes, strict=True):
            if outcome == "gone":
                try:
                    core.store.delete(SUBS, device["id"])
                except ConflictError:
                    pass
                out["removed"] += 1
            else:
                out[outcome] += 1
    except Exception:  # noqa: BLE001 - reporting must never take down what it reports on
        log.exception("push: notifications could not be sent")
    return out


def test(core: App, post=None) -> dict:
    real_orders._owner(core)
    return send(core, "EGX Intelligence", "Notifications work on this device. This is what a real-order notice looks like.",
                tag="test", post=post)


def _order_line(order: dict) -> tuple[str, str]:
    what = f"{'Buy' if order['side'] == 'BUY' else 'Sell'} {order['qty']:,} {order['symbol']} at {order['price']:g}"
    title = "Automatic sale" if order.get("origin") == "automation" else "Automatic order"
    if order["status"] == "sent":
        return title, f"{what} was sent to the broker."
    if order["status"] == "rejected":
        return title, f"{what} was refused by the broker. {order.get('status_note') or ''}".strip()
    if order["status"] == "failed":
        return title, f"{what} could not be sent. {order.get('status_note') or ''}".strip()
    return f"{title}: needs you", f"{what}: no clear answer came back. Open the Real account page before anything else."


def report(core: App, result: dict, post=None) -> dict:
    """Tell the owner's devices what a look by the automation did: each order it sent, and each remark, once in a while.

    A remark is marked as told only once a device has taken it. One that could not be delivered, or that did not
    fit in this look, is told at the next: "sell it yourself" must not be lost because a push service was busy.
    """
    total = {"sent": 0, "failed": 0, "removed": 0}
    try:
        if not result.get("ran") or not (result.get("sent") or result.get("exits") or result.get("notes")):
            return total
        if _signing_key(core.settings) is None or not core.store.list(SUBS):
            return total

        def tell(title: str, message: str, tag: str) -> bool:
            got = send(core, title, message, tag=tag, post=post)
            for k, v in got.items():
                total[k] += v
            return got["sent"] > 0
        for order in [*result.get("exits", []), *result.get("sent", [])][:8]:
            tell(*_order_line(order), f"order-{order['id']}")
        notes = result.get("notes") or []
        if notes:
            seen = core.store.get(*SEEN) or {}
            fresh = {k: v for k, v in seen.items() if real_orders._age(v) < SAME_REMARK_SECONDS}
            told = 0
            for note in notes:
                key = hashlib.sha256(note.encode()).hexdigest()[:16]
                if key in fresh or told >= MAX_REMARKS:
                    continue
                told += 1
                if tell("Automatic orders", note, f"note-{key}"):
                    fresh[key] = now_iso()
            if fresh != seen:
                try:
                    core.store.put(*SEEN, fresh)
                except ConflictError:
                    pass   # another look wrote it at the same moment: at worst a remark arrives twice
    except Exception:  # noqa: BLE001
        log.exception("push: the look could not be reported")
    return total
