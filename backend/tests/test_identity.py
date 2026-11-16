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
def test_an_account_is_looked_up_once_and_after_that_the_database_is_the_record(db, monkeypatch):
    import app.identity as identity
    uid, asked = "g-" + uuid.uuid4().hex[:10], []

    def first(u, token):
        asked.append((u, token))
        return {"admin": False, "others": []}
    gate = AccountGate(db, first)
    gate.check(uid, "t1", "person@example.com")
    gate.check(uid, "t2")
    assert asked == [(uid, "t1")]
    assert db.one("select active, admin, email from egx.accounts where uid=%s", (uid,)) == (True, False, "person@example.com")
    # another server, later: the row is there, so nothing outside the database is asked, whatever it would say
    AccountGate(db, lambda u, t: pytest.fail("must not be asked")).check(uid, "t3")
    AccountGate(db, None).check(uid, "t3")
    # the administrator closes it: refused within a minute on a server that had let it in, at once on any other
    db.one("update egx.accounts set active=false where uid=%s returning uid", (uid,))
    with pytest.raises(AuthError):
        AccountGate(db, lambda u, t: {"admin": True}).check(uid, "t4")          # not reopened by an old record elsewhere
    gate.check(uid, "t5")                                                        # still believed here, for the minute
    clock = {"t": time.monotonic()}
    monkeypatch.setattr(identity.time, "monotonic", lambda: clock["t"])
    clock["t"] += identity.ALLOWED_FOR + 1
    with pytest.raises(AuthError):
        gate.check(uid, "t6")
    db.one("update egx.accounts set active=true where uid=%s returning uid", (uid,))
    gate.forget(uid)                                                             # what closing or opening it here does
    gate.check(uid, "t7")


@needs_db
def test_an_account_nobody_recorded_is_not_let_in_and_nothing_is_written_for_it(db):
    stranger = "never-" + uuid.uuid4().hex[:8]
    for first in (lambda u, t: False, None):                   # no record allows it; or records elsewhere are no longer asked
        with pytest.raises(AuthError):
            AccountGate(db, first).check(stranger, "t")
    with pytest.raises(StoreUnavailable):                      # the old records cannot be asked: not let in on a guess
        AccountGate(db, lambda u, t: None).check(stranger, "t")
    assert db.one("select 1 from egx.accounts where uid=%s", (stranger,)) is None


@needs_db
def test_an_administrators_first_visit_brings_the_list_of_accounts_with_it(db):
    admin, open_one, closed_one = ("a-" + uuid.uuid4().hex[:10] for _ in range(3))
    others = [{"uid": open_one, "email": "o@example.com", "name": "Open", "active": True, "createdAt": "2026-10-01T09:00:00Z", "createdBy": admin},
              {"uid": closed_one, "email": "c@example.com", "name": "Closed", "active": False}, {"uid": admin, "active": False},
              {"nonsense": 1}, "nonsense"]
    AccountGate(db, lambda u, t: {"admin": True, "others": others}).check(admin, "t", "admin@example.com")
    assert db.one("select active, admin from egx.accounts where uid=%s", (admin,)) == (True, True)
    assert db.one("select active, admin, name, created_by, migrated_at from egx.accounts where uid=%s", (open_one,)) == (True, False, "Open", admin, None)
    AccountGate(db, None).check(open_one, "t")                 # known from the list: let in without asking anywhere
    with pytest.raises(AuthError):
        AccountGate(db, lambda u, t: {"admin": False}).check(closed_one, "t")   # closed in the list stays closed


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
