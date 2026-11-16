"""Running without a browser, and telling the owner's devices: the timer, the sealed key, the look, the notifications (no network)."""
import json
import time as clock_module
from datetime import datetime, timedelta

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app import assistant, background, broker, push, real_orders, services
from app.config import Settings
from app.data.calendar import CAIRO
from app.data.feed import Feed
from tests.test_broker import FakeBroker, client
from tests.test_real_auto import COMI, a_floor, bought, core_of, holds, on, orders, price, suggest

TIMER = {"Authorization": "Bearer the-platforms-secret"}
SERVER = {"cron_secret": "the-platforms-secret", "background_key": "local", "background_secret": "only-this-server-knows"}
PHONE = "https://fcm.googleapis.com/fcm/send/abc123"


@pytest.fixture(autouse=True)
def _fresh():
    for module in (Feed, broker, real_orders, background):
        module.reset()
    services._DEPTH_CACHE.clear()
    yield
    for module in (Feed, broker, real_orders, background):
        module.reset()


@pytest.fixture()
def floor(tmp_path, monkeypatch):
    """The floor of the automation's tests, on a server that is set up to wake by itself."""
    with a_floor(tmp_path, monkeypatch, **SERVER) as c:
        c.posted = []
        monkeypatch.setattr(push.httpx, "post", lambda url, **kw: c.posted.append((url, kw)) or httpx.Response(201))
        yield c


def device(endpoint=PHONE):
    """A browser's subscription, with the browser's own keys so that a test can read what it is sent."""
    key = ec.generate_private_key(ec.SECP256R1())
    auth = b"0123456789abcdef"
    body = {"endpoint": endpoint, "keys": {"p256dh": push.b64(push._point(key.public_key())), "auth": push.b64(auth)}, "label": "Phone"}
    return body, key, auth


def read(body: bytes, key, auth: bytes) -> dict:
    """What the browser does with a message: the receiving side of RFC 8291, written out independently."""
    salt, size, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    sender = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), body[21:21 + idlen])
    shared = key.exchange(ec.ECDH(), sender)
    ikm = HKDF(algorithm=hashes.SHA256(), length=32, salt=auth,
               info=b"WebPush: info\x00" + push._point(key.public_key()) + body[21:21 + idlen]).derive(shared)
    cek = HKDF(algorithm=hashes.SHA256(), length=16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(algorithm=hashes.SHA256(), length=12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(ikm)
    plain = AESGCM(cek).decrypt(nonce, body[21 + idlen:], None)
    assert size == 4096 and plain.endswith(b"\x02")
    return json.loads(plain[:-1])


def wake(c, headers=TIMER):
    return c.get("/api/v1/background/look", headers=headers)


def switch(c, enabled=True):
    return c.put("/api/v1/background", json={"enabled": enabled})


# ---- notifications: the two standards ---------------------------------------------------
def test_a_message_is_encrypted_as_the_standard_says():
    """RFC 8291, section 5: the same keys, salt and text must give the same bytes."""
    sender = ec.derive_private_key(int.from_bytes(push.unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"), ec.SECP256R1())
    body = push.encrypt(b"When I grow up, I want to be a watermelon",
                        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
                        sender=sender, salt=push.unb64("DGv6ra1nlYgDCS1FRnbzlw"))
    assert push.b64(body) == ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_"
                              "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
    # and a fresh one, with keys of its own each time, is read back by the receiving side
    sub, key, auth = device()
    one, two = (push.encrypt("أمر آلي: بيع 10 COMI".encode(), sub["keys"]["p256dh"], sub["keys"]["auth"]) for _ in range(2))
    assert one != two and AESGCM  # never the same bytes twice
    with pytest.raises(push.PushError, match="too long"):
        push.encrypt(b"x" * 4000, sub["keys"]["p256dh"], sub["keys"]["auth"])


def test_the_server_signs_as_one_application_with_a_key_it_never_stores():
    here, there = Settings(background_secret="only-this-server-knows"), Settings(background_secret="another-server")
    assert push.public_key(Settings()) is None                                   # no secret, no key, no notifications
    key = push.public_key(here)
    assert key == push.public_key(Settings(background_secret="only-this-server-knows")) != push.public_key(there)
    assert len(push.unb64(key)) == 65 and push.unb64(key)[0] == 4                # an uncompressed P-256 point
    # without a secret of its own, the broker credentials the server already holds stand in
    assert push.public_key(Settings(younit_trading_id="tid", younit_api_key="k")) not in (None, key)

    header = push.authorization(here, PHONE, "https://app.example", now=1_800_000_000)
    token, k = header.removeprefix("vapid t=").split(", k=")
    head, claims, signature = token.split(".")
    assert k == key and json.loads(push.unb64(head)) == {"typ": "JWT", "alg": "ES256"}
    assert json.loads(push.unb64(claims)) == {"aud": "https://fcm.googleapis.com", "exp": 1_800_000_000 + 12 * 3600, "sub": "https://app.example"}
    raw = push.unb64(signature)
    public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), push.unb64(key))
    public.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                  f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))       # raises unless the signature is the application's
    assert "@" not in push.contact(here)                                        # the sender named is the app, never a person


# ---- notifications: the owner's devices -------------------------------------------------
def test_only_the_owners_devices_subscribe_and_only_at_a_browsers_push_service(floor, tmp_path):
    c = floor
    sub, key, auth = device()
    seen = c.get("/api/v1/background").json()["push"]
    assert seen["available"] and seen["public_key"] == push.public_key(Settings(**SERVER)) and seen["devices"] == []
    for bad in ("http://fcm.googleapis.com/x/123456789012", "https://example.com/push/123456789012", "https://fcm.googleapis.com.evil.example/x/1234567",
                "https://169.254.169.254/latest/meta-data/x"):
        res = c.post("/api/v1/push/subscribe", json={**sub, "endpoint": bad})
        assert res.status_code == 422 and "not one the app sends to" in res.json()["detail"], bad
    assert c.post("/api/v1/push/subscribe", json={**sub, "keys": {"p256dh": "A" * 87, "auth": sub["keys"]["auth"]}}).status_code == 422
    made = c.post("/api/v1/push/subscribe", json=sub).json()
    assert [d["label"] for d in made["devices"]] == ["Phone"]
    assert len(c.post("/api/v1/push/subscribe", json=sub).json()["devices"]) == 1          # the same device again is the same device
    apple, _, _ = device("https://web.push.apple.com/QGh5c2lv")
    assert len(c.post("/api/v1/push/subscribe", json=apple).json()["devices"]) == 2

    # a test message reaches both, readable only by the device it is for
    assert c.post("/api/v1/push/test").json() == {"sent": 2, "failed": 0, "removed": 0}
    (url, sent), _ = sorted(c.posted, key=lambda p: p[0])
    assert url == PHONE and sent["headers"]["Content-Encoding"] == "aes128gcm" and sent["headers"]["TTL"] == "3600"
    assert sent["headers"]["Authorization"].startswith("vapid t=")
    assert read(sent["content"], key, auth)["body"].startswith("Notifications work on this device")
    # a device the browser has dropped is forgotten; one that fails is counted and kept
    c.posted.clear()
    push.httpx.post = lambda url, **kw: httpx.Response(410 if "apple" in url else 500)
    assert c.post("/api/v1/push/test").json() == {"sent": 0, "failed": 1, "removed": 1}
    assert c.post("/api/v1/push/unsubscribe", json={"endpoint": PHONE}).json()["devices"] == []

    with client(tmp_path / "other", FakeBroker(), live_trading_enabled=True, broker_account_uids="", **SERVER) as stranger:
        for method, path, body in (("get", "/api/v1/background", None), ("post", "/api/v1/push/subscribe", sub), ("post", "/api/v1/push/test", None),
                                   ("post", "/api/v1/push/unsubscribe", {"endpoint": PHONE}), ("put", "/api/v1/background", {"enabled": True}),
                                   ("post", "/api/v1/background/key", {"refresh_token": "r" * 40})):
            assert stranger.request(method, path, json=body).status_code == 403, path


# ---- the timer --------------------------------------------------------------------------
def test_only_the_platforms_timer_wakes_the_server(floor, tmp_path):
    c = floor
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "the-platforms-secret"}, {"Authorization": "Bearer "}):
        assert wake(c, headers).status_code == 401
    assert wake(c).json() == {"ran": False, "why": "background running is switched off"}     # the owner has not switched it on
    with client(tmp_path / "unset", FakeBroker(), live_trading_enabled=True) as bare:        # no secret set: nobody can ring
        assert bare.get("/api/v1/background/look", headers={"Authorization": "Bearer "}).status_code == 401
        assert bare.get("/api/v1/background/look", headers=TIMER).status_code == 401
        assert bare.put("/api/v1/background", json={"enabled": True}).status_code == 422
    with client(tmp_path / "nokey", FakeBroker(), live_trading_enabled=True, cron_secret="the-platforms-secret") as c2:
        assert wake(c2).json()["ran"] is False                                               # a timer, but no key to work with
        res = c2.put("/api/v1/background", json={"enabled": True})
        assert res.status_code == 422 and "no background key on the server" in res.json()["detail"]


def test_with_the_app_closed_the_server_takes_the_looks_the_app_would_have(floor):
    c = floor
    on(c)
    assert switch(c).json()["enabled"] is True and c.get("/api/v1/status").json()["real_orders"]["background"] is True
    sub, key, auth = device()
    c.post("/api/v1/push/subscribe", json=sub)
    told, _ = suggest(c)                                                           # the assistant wrote it; nobody has the app open
    polls = c.fake.live_calls
    c.clock["now"] += timedelta(seconds=30)
    out = wake(c).json()
    assert out["ran"] and out["auto"] == {"ran": True, "why": None, "sent": 1, "exits": 0} and out["pushed"]["sent"] == 1
    assert c.fake.live_calls == polls + 1                                          # it read the prices itself first
    assert c.fake.sent == [{"profile_id": 4242, "stock_id": 1, "side": "BUY", "qty": 10, "price": COMI}]
    assert orders(c)[told["proposal"]["id"]]["approved_by"] == "auto"
    said = read(c.posted[-1][1]["content"], key, auth)
    assert said == {"title": "Automatic order", "body": "Buy 10 COMI at 35.9 was sent to the broker.",
                    "tag": f"order-{told['proposal']['id']}", "url": "/account"}
    beat = c.get("/api/v1/background").json()
    assert beat["beat"]["ran"] and beat["beat"]["sent"] == 1 and not beat["silent"] and beat["server_key"] == "ok"

    # a stop-loss is carried out without anybody watching, on a price the server fetched itself
    real_orders.reset()
    next(o for o in c.fake.book if o["side"] == "BUY" and o["stock_id"] == 1).update(status="Executed", executed_qty=10, average=COMI)
    wake(c)
    holds(c, (1, "COMI", 10, 10, COMI))
    c.clock["now"] += timedelta(seconds=40)
    c.fake.live_prices["COMI"] = 33.5
    out = wake(c).json()
    assert out["auto"]["exits"] == 1 and c.fake.sent[-1] == {"profile_id": 4242, "stock_id": 1, "side": "SELL", "qty": 10, "price": 33.5}
    assert read(c.posted[-1][1]["content"], key, auth)["title"] == "Automatic sale"

    # switched off, the timer still rings and nothing happens
    assert switch(c, False).json()["enabled"] is False
    assert wake(c).json() == {"ran": False, "why": "background running is switched off"}
    assert c.get("/api/v1/status").json()["real_orders"]["background"] is False


def test_the_timer_does_nothing_outside_the_session_and_says_when_it_went_quiet(floor):
    c = floor
    on(c)
    switch(c)
    wake(c)
    assert c.get("/api/v1/background").json()["silent"] is False
    beat = background.BEAT
    core = core_of(c)
    core.store.put(*beat, {**core.store.get(*beat), "at": "2020-01-01T00:00:00+00:00"})    # the last look was long ago
    assert c.get("/api/v1/background").json()["silent"] is True                             # during the session that is worth saying
    reads = len(c.fake.reads)
    for hour in (9, 16, 22):                                                                # before the bell, after the close, at night
        c.clock["now"] = c.clock["now"].replace(hour=hour, minute=20)
        assert wake(c).json() == {"ran": False, "why": "outside the session"}
    c.clock["now"] = c.clock["now"].replace(hour=11) + timedelta(days=1)
    while c.clock["now"].weekday() not in (4, 5):
        c.clock["now"] += timedelta(days=1)                                                 # a Friday or a Saturday
    assert wake(c).json() == {"ran": False, "why": "outside the session"} and len(c.fake.reads) == reads
    assert c.get("/api/v1/background").json()["silent"] is False                            # quiet when the market is closed is as it should be


def test_remarks_are_sent_once_in_a_while_not_every_minute(floor, monkeypatch):
    c = floor
    on(c)
    switch(c)
    sub, key, auth = device()
    c.post("/api/v1/push/subscribe", json=sub)
    bought(c, qty=10, stop=34.0)
    holds(c, (1, "COMI", 10, 0, COMI))                                              # reached its stop, but not free to sell
    price(c, comi=33.0)
    c.posted.clear()
    for _ in range(3):
        c.clock["now"] += timedelta(seconds=30)
        c.fake.live_prices["COMI"] = 33.0
        assert wake(c).json()["ran"]
    said = [read(kw["content"], key, auth)["body"] for _, kw in c.posted]
    assert len(said) == 1 and "does not show its shares as free to sell yet" in said[0]
    monkeypatch.setattr(push, "SAME_REMARK_SECONDS", -1)
    wake(c)
    assert len(c.posted) == 2                                                       # and again once enough time has passed
    # no device, no work; and a notification that cannot be sent never breaks the look
    c.post("/api/v1/push/unsubscribe", json={"endpoint": PHONE})
    assert wake(c).json()["pushed"] == {"sent": 0, "failed": 0, "removed": 0}
    c.post("/api/v1/push/subscribe", json=sub)
    monkeypatch.setattr(push.httpx, "post", lambda url, **kw: (_ for _ in ()).throw(httpx.ConnectError("no route")))
    out = wake(c).json()
    assert out["ran"] and out["pushed"]["failed"] >= 1


def test_the_assistants_review_runs_last_and_what_it_proposed_is_judged_at_once(floor, monkeypatch):
    c = floor
    on(c)
    switch(c)
    calls = []

    def review(core, model):
        calls.append(model)
        suggest(c)                                                                  # the review writes a proposal inside the box
        return {"ran": True, "chat": "c1", "changes": 1, "error": None, "reason": "intraday"}
    monkeypatch.setattr(assistant, "run_autopilot", review)
    monkeypatch.setattr(background, "wake", lambda settings, build, model, firestore: background.look(build(None, None), "a-model"))
    out = wake(c).json()
    assert calls == ["a-model"] and out["review"] == {"ran": True, "reason": "intraday", "changes": 1, "error": None}
    assert out["auto"]["sent"] == 1 and len(c.fake.sent) == 1                       # sent in the same look, not a minute later
    # a review that fails is reported, and the look's own work stands
    monkeypatch.setattr(assistant, "run_autopilot", lambda core, model: (_ for _ in ()).throw(RuntimeError("model unavailable")))
    sub, key, auth = device()
    c.post("/api/v1/push/subscribe", json=sub)
    out = wake(c).json()
    assert out["ran"] and out["review"]["error"] == "RuntimeError"
    assert "review stopped" in read(c.posted[-1][1]["content"], key, auth)["body"]


# ---- the sealed key ----------------------------------------------------------------------
def test_a_background_key_opens_only_on_the_server_that_sealed_it():
    here = Settings(background_secret="only-this-server-knows")
    sealed = background.seal(here, {"uid": "owner-1", "rt": "renewal-token", "kid": "k1"})
    assert sealed.startswith("bk1.") and "renewal-token" not in sealed and "owner-1" not in sealed
    assert background.unseal(here, sealed) == {"uid": "owner-1", "rt": "renewal-token", "kid": "k1"}
    assert background.seal(here, {"uid": "owner-1", "rt": "renewal-token", "kid": "k1"}) != sealed       # sealed afresh each time
    assert background.unseal(Settings(background_secret="another-server"), sealed) is None
    assert background.unseal(Settings(), sealed) is None
    tampered = sealed[:-6] + ("AAAAAA" if not sealed.endswith("AAAAAA") else "BBBBBB")
    for bad in (tampered, sealed[4:], "bk1.", "bk1.not-base64!!", "local", background.seal(here, {"uid": "x"})):
        assert background.unseal(here, bad) is None, bad
    with pytest.raises(background.BackgroundError):
        background.seal(Settings(), {"uid": "x", "rt": "y", "kid": "z"})


def test_the_owner_lends_their_own_sign_in_and_a_new_key_retires_the_old(floor, monkeypatch):
    c = floor
    # a server without sign-in has none to lend
    res = c.post("/api/v1/background/key", json={"refresh_token": "r" * 40})
    assert res.status_code == 422 and "deployed app" in res.json()["detail"]

    def owner(key=""):
        core = core_of(c)
        core.uid, core.signed_in = "owner-1", True
        core.settings = core.settings.model_copy(update={"background_key": key})
        return core
    monkeypatch.setattr(background, "_exchange", lambda settings, rt: {"id_token": "t", "user_id": "someone-else", "expires_in": 3600})
    with pytest.raises(background.BackgroundError, match="not this account's"):
        background.make_key(owner(), background.KeyIn(refresh_token="r" * 40))
    monkeypatch.setattr(background, "_exchange", lambda settings, rt: {"id_token": "t", "user_id": "owner-1", "expires_in": 3600})
    first = background.make_key(owner(), background.KeyIn(refresh_token="renewal-token-of-the-owner"))
    opened = background.unseal(Settings(**SERVER), first["key"])
    assert opened["uid"] == "owner-1" and opened["rt"] == "renewal-token-of-the-owner" and first["enabled"] is False
    assert ("key", "background") in [(a["action"], a["entity"]) for a in c.get("/api/v1/audit").json()]

    switch_on = background.SwitchIn(enabled=True)
    for key, words in (("", "no background key on the server"), ("bk1.garbage", "cannot be read by this server"),
                       (background.seal(Settings(**SERVER), {"uid": "another", "rt": "x", "kid": opened["kid"]}), "another sign-in")):
        with pytest.raises(background.BackgroundError, match=words):
            background.set_enabled(owner(key), switch_on)
    assert background.set_enabled(owner(first["key"]), switch_on)["enabled"] is True
    assert background.view(owner(first["key"]))["server_key"] == "ok"
    # the key works for a look only while it is the current one
    assert background.look(owner(first["key"]), None, kid=opened["kid"])["ran"] is True
    second = background.make_key(owner(first["key"]), background.KeyIn(refresh_token="renewal-token-of-the-owner"))
    assert second["enabled"] is False and second["server_key"] == "replaced"            # a new key starts off, and the old one is retired
    with pytest.raises(background.BackgroundError, match="older one"):
        background.set_enabled(owner(first["key"]), switch_on)
    background.set_enabled(owner(second["key"]), switch_on)
    assert background.look(owner(second["key"]), None, kid=opened["kid"]) == {"ran": False, "why": "the key on the server was replaced by a newer one"}
    stranger = owner(second["key"])
    stranger.real_account_allowed = False
    assert background.look(stranger, None)["why"] == "this sign-in is not the brokerage account's owner"


def test_the_sign_in_is_renewed_when_needed_and_a_refused_one_stops_the_look(monkeypatch):
    here = Settings(store_backend="firestore", firebase_project_id="p", firebase_web_api_key="web-key", cron_secret="s",
                    background_secret="only-this-server-knows")
    asked = []

    def answer(url, **kw):
        asked.append((url, kw["params"], kw["data"]))
        return httpx.Response(200, json={"id_token": f"token-{len(asked)}", "user_id": "owner-1", "expires_in": "3600"})
    monkeypatch.setattr(background.httpx, "post", answer)
    creds = {"uid": "owner-1", "rt": "renewal-token", "kid": "k1"}
    assert background._sign_in(here, creds) == "token-1" == background._sign_in(here, creds)          # kept while it lasts
    assert asked == [("https://securetoken.googleapis.com/v1/token", {"key": "web-key"},
                      {"grant_type": "refresh_token", "refresh_token": "renewal-token"})]
    for name, (held, _) in list(background._tokens.items()):
        background._tokens[name] = (held, clock_module.monotonic() + 120)                           # close to running out
    assert background._sign_in(here, creds) == "token-2"
    with pytest.raises(background.BackgroundError, match="signs in as someone else"):
        background._sign_in(here, {**creds, "uid": "not-the-owner", "rt": "another"})

    # the whole wake, on a server with sign-in: the key is opened, the owner signed in, and the look built for them
    monkeypatch.setattr(background, "cairo_now", lambda: datetime(2026, 11, 15, 11, 0, tzinfo=CAIRO))   # a Sunday, mid-session
    built = []
    monkeypatch.setattr(background, "look", lambda core, model, kid=None: {"ran": True, "core": core, "kid": kid})
    sealed = background.seal(here, creds)
    background.reset()
    out = background.wake(here.model_copy(update={"background_key": sealed}), lambda uid, token: built.append((uid, token)) or "core", None, firestore=True)
    assert out == {"ran": True, "core": "core", "kid": "k1"} and built[0][0] == "owner-1" and built[0][1].startswith("token-")
    assert background.wake(here.model_copy(update={"background_key": "bk1.junk"}), None, None, firestore=True)["why"] == \
        "the background key on the server cannot be read"
    assert background.wake(here, None, None, firestore=True)["why"] == "no background key on the server"
    # the owner changed their password: the key no longer signs in, and nothing is built
    background.reset()
    monkeypatch.setattr(background.httpx, "post", lambda url, **kw: httpx.Response(400, json={"error": {"message": "TOKEN_EXPIRED"}}))
    out = background.wake(here.model_copy(update={"background_key": sealed}), lambda uid, token: 1 / 0, None, firestore=True)
    assert out["ran"] is False and "Create a new key" in out["why"]
