"""The server's own check of a sign-in: a genuine token for this project, and an account allowed to use the app."""
import base64
import json
import os
import time
import uuid

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.identity import AccountGate, TokenVerifier
from app.store.errors import AuthError, StoreUnavailable

PROJECT = "demo-egx"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def jwk(key, kid: str) -> dict:
    numbers = key.public_key().public_numbers()
    return {"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
            "n": b64(numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")), "e": b64(numbers.e.to_bytes(3, "big"))}


def sign(uid: str = "user-1", *, key=KEY, kid: str = "k1", alg: str = "RS256", **claims) -> str:
    now = int(time.time())
    body = {"sub": uid, "user_id": uid, "aud": PROJECT, "iss": f"https://securetoken.google.com/{PROJECT}",
            "iat": now - 10, "exp": now + 3600, "auth_time": now - 10} | claims
    head = {"alg": alg, "kid": kid, "typ": "JWT"}
    signed = f"{b64(json.dumps(head).encode())}.{b64(json.dumps({k: v for k, v in body.items() if v is not None}).encode())}"
    return f"{signed}.{b64(key.sign(signed.encode(), padding.PKCS1v15(), hashes.SHA256()))}"


def verifier(keys=None, calls=None):
    def fetch():
        if calls is not None:
            calls.append(1)
        return ({"k1": jwk(KEY, "k1")} if keys is None else keys), 3600.0
    return TokenVerifier(PROJECT, fetch_keys=fetch)


def test_a_genuine_current_token_names_its_account():
    calls = []
    v = verifier(calls=calls)
    assert v.verify(sign("abc")) == "abc" and v.verify(sign("def")) == "def"
    assert len(calls) == 1                                    # the keys are read once, not for every request


@pytest.mark.parametrize("token", [
    "", "nonsense", "a.b.c", sign() + "x", sign()[:-6] + "AAAAAA",
    sign(key=OTHER),                                          # signed by somebody else, claiming our key's name
    sign(kid="unknown"),
    sign(aud="another-project"), sign(iss="https://securetoken.google.com/another-project"),
    sign(iss="https://accounts.google.com"),
    sign(""), sign("a/b"), sign("x" * 200), sign(sub=None), sign(sub=7),
    sign(exp=None), sign(iat=None), sign(exp="tomorrow"), sign(iat=int(time.time()) + 3600),
    sign(auth_time=int(time.time()) + 3600),
])
def test_anything_else_is_refused(token):
    with pytest.raises(AuthError):
        verifier().verify(token)


def test_an_unsigned_token_and_one_that_names_its_own_algorithm_are_refused():
    head, body, _ = sign().split(".")
    none = b64(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    for forged in (f"{none}.{body}.", f"{none}.{body}", f"{head}.{body}.", f"{head}.{body}"):
        with pytest.raises(AuthError):
            verifier().verify(forged)
    with pytest.raises(AuthError):
        verifier().verify(sign(alg="HS256"))
    # the account in a token is believed only after the signature: a changed body with the old signature fails
    _, _, signature = sign("victim").split(".")
    other_body = sign("attacker").split(".")[1]
    with pytest.raises(AuthError):
        verifier().verify(f"{head}.{other_body}.{signature}")


def test_an_expired_token_says_so():
    with pytest.raises(AuthError, match="expired"):
        verifier().verify(sign(exp=int(time.time()) - 600, iat=int(time.time()) - 4200))


def test_keys_that_cannot_be_read():
    def down():
        raise httpx.ConnectError("no network")
    with pytest.raises(StoreUnavailable):                      # no keys at all: nobody can be let in, and it says why
        TokenVerifier(PROJECT, fetch_keys=down).verify(sign())
    state = {"up": True, "calls": 0}

    def flaky():
        state["calls"] += 1
        if not state["up"]:
            raise httpx.ConnectError("no network")
        return {"k1": jwk(KEY, "k1")}, 3600.0
    v = TokenVerifier(PROJECT, fetch_keys=flaky)
    assert v.verify(sign("abc")) == "abc"
    state["up"] = False
    v._expires = 0                                             # the keys are due to be read again, and cannot be
    assert v.verify(sign("abc")) == "abc"                      # the ones there are still serve
    with pytest.raises(AuthError):
        v.verify(sign(kid="k2", key=OTHER))                    # and an unknown key is still unknown
    calls = state["calls"]
    for _ in range(5):
        with pytest.raises(AuthError):
            v.verify(sign(kid="k2", key=OTHER))
    assert state["calls"] == calls                             # a stream of unknown keys does not hammer the key service


def test_new_keys_are_picked_up_when_a_token_names_one():
    keys = {"k1": jwk(KEY, "k1")}
    v = TokenVerifier(PROJECT, fetch_keys=lambda: (dict(keys), 3600.0))
    assert v.verify(sign()) == "user-1"
    keys["k2"] = jwk(OTHER, "k2")                              # the sign-in service starts using a new key
    v._fetched -= 120                                          # (more than a minute after the keys were last read)
    assert v.verify(sign("later", key=OTHER, kid="k2")) == "later"


# ---- the account gate (needs the database) -------------------------------------------------------------
URL = os.environ.get("TEST_DATABASE_URL", "")
needs_db = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")


@pytest.fixture(scope="module")
def db():
    from app.store.postgres_store import Database
    database = Database(URL)
    database.ensure_schema()
    yield database
    database.close()


@needs_db
def test_the_gate_asks_once_a_minute_and_refuses_a_closed_account(db, monkeypatch):
    import app.identity as identity
    uid, answers, asked = "g-" + uuid.uuid4().hex[:10], {"now": True}, []

    def ask(u, token):
        asked.append((u, token))
        return answers["now"]
    gate = AccountGate(db, ask)
    gate.check(uid, "t1")
    gate.check(uid, "t2")
    assert asked == [(uid, "t1")]                              # the second request within the minute is not a question
    answers["now"] = False                                     # the administrator closes the account
    clock = {"t": time.monotonic()}
    monkeypatch.setattr(identity.time, "monotonic", lambda: clock["t"])
    clock["t"] += identity.ALLOWED_FOR + 1
    with pytest.raises(AuthError):
        gate.check(uid, "t3")
    with pytest.raises(AuthError):
        AccountGate(db, lambda u, t: False).check("never-" + uuid.uuid4().hex[:8], "t")


@needs_db
def test_when_the_sign_in_service_cannot_be_asked_the_last_answer_serves_for_a_day(db):
    uid = "g-" + uuid.uuid4().hex[:10]
    AccountGate(db, lambda u, t: True).check(uid, "t")         # a server learns the account is allowed
    AccountGate(db, lambda u, t: None).check(uid, "t")         # another server, during an outage: the kept answer serves
    db.one("update egx.accounts set checked_at = now() - interval '25 hours' where uid=%s returning uid", (uid,))
    with pytest.raises(StoreUnavailable):
        AccountGate(db, lambda u, t: None).check(uid, "t")     # too old to trust
    with pytest.raises(StoreUnavailable):
        AccountGate(db, lambda u, t: None).check("unknown-" + uuid.uuid4().hex[:8], "t")   # never seen: not let in on a guess
    closed = "g-" + uuid.uuid4().hex[:10]
    with pytest.raises(AuthError):
        AccountGate(db, lambda u, t: False).check(closed, "t")
    with pytest.raises(AuthError):
        AccountGate(db, lambda u, t: None).check(closed, "t")  # an outage does not reopen a closed account


def test_an_answer_from_the_key_service_without_usable_keys_does_not_throw_the_good_ones_away():
    answers = [({"k1": jwk(KEY, "k1")}, 3600.0), ({}, 3600.0), ({"k1": {"kty": "RSA", "kid": "k1"}}, 3600.0)]
    v = TokenVerifier(PROJECT, fetch_keys=lambda: answers.pop(0))
    assert v.verify(sign("abc")) == "abc"
    for _ in range(2):
        v._expires = 0                                         # due again; the service answers, with nothing to use
        assert v.verify(sign("abc")) == "abc"
    with pytest.raises(StoreUnavailable):                      # and a server that never had keys says it cannot check, not "invalid"
        TokenVerifier(PROJECT, fetch_keys=lambda: ({"k1": {"kty": "RSA", "kid": "k1"}}, 3600.0)).verify(sign())


def test_a_token_firestore_does_not_accept_is_not_an_account_that_was_closed(monkeypatch):
    import app.identity as identity

    def answers(by_coll):
        def get(url, headers=None):
            return httpx.Response(by_coll[url.rsplit("/", 2)[-2]], json={"fields": {"active": {"booleanValue": True}}})
        return get
    for by_coll, want in (({"egxAccounts": 200, "users": 403}, True), ({"egxAccounts": 404, "users": 200}, True),
                          ({"egxAccounts": 404, "users": 403}, False),          # no record anywhere: not allowed
                          ({"egxAccounts": 401, "users": 401}, None),           # the token was not accepted: not an answer
                          ({"egxAccounts": 429, "users": 429}, None), ({"egxAccounts": 404, "users": 503}, None)):
        monkeypatch.setattr(identity._http, "get", answers(by_coll))
        assert identity.ask_firestore(PROJECT, "user/with slash", "t") is want, by_coll
    seen = []
    monkeypatch.setattr(identity._http, "get", lambda url, headers=None: (seen.append(url), httpx.Response(404))[1])
    identity.ask_firestore(PROJECT, "a/b", "t")
    assert all(url.endswith("/a%2Fb") for url in seen)         # an account id is one path segment, whatever is in it
