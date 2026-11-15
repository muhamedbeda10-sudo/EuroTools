"""Firestore-backed API, exercised against the local emulator with the real security rules.

    npm run emulators        # repo root, in another terminal
    pytest tests/test_firestore.py

Skipped when the emulator is not running.
"""
import base64
import json
import os
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

HOST = os.environ.get("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")
PROJECT = "demo-egx"
DOCS = f"http://{HOST}/v1/projects/{PROJECT}/databases/(default)/documents"


def _emulator_up() -> bool:
    try:
        return httpx.get(f"http://{HOST}/", timeout=1).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not _emulator_up(), reason="Firestore emulator not running")


def token(uid: str) -> str:
    """Unsigned JWT: the emulator accepts it, production Firestore would not."""
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'none', 'typ': 'JWT'})}.{enc({'sub': uid, 'user_id': uid, 'iss': f'https://securetoken.google.com/{PROJECT}', 'aud': PROJECT})}."


def provision(uid: str, active: bool = True) -> None:
    """Create the account document the rules require, bypassing rules as the emulator owner."""
    res = httpx.patch(f"{DOCS}/users/{uid}", headers={"Authorization": "Bearer owner"},
                      json={"fields": {"active": {"booleanValue": active}, "role": {"stringValue": "ADMIN"}}})
    assert res.status_code == 200, res.text


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    from app.config import Settings
    from app.main import create_app
    with TestClient(create_app(Settings(store_backend="firestore", firebase_project_id=PROJECT))) as c:
        yield c


@pytest.fixture()
def user():
    uid = "u-" + uuid.uuid4().hex[:10]
    provision(uid)
    return uid, {"Authorization": f"Bearer {token(uid)}"}


def test_requires_sign_in_and_a_provisioned_active_account(api):
    assert api.get("/api/v1/status").status_code == 401
    assert api.get("/api/v1/status", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    stranger = "s-" + uuid.uuid4().hex[:8]
    assert api.get("/api/v1/portfolio", headers={"Authorization": f"Bearer {token(stranger)}"}).status_code == 401
    retired = "r-" + uuid.uuid4().hex[:8]
    provision(retired, active=False)
    assert api.get("/api/v1/portfolio", headers={"Authorization": f"Bearer {token(retired)}"}).status_code == 401
    assert api.get("/health").status_code == 200


def test_full_flow_persists_per_user(api, user):
    uid, h = user
    s = api.get("/api/v1/status", headers=h).json()
    assert s["storage"] == "firestore" and s["data"]["mode"] == "sample"
    assert api.get("/api/v1/portfolio", headers=h).json()["summary"]["cash"] == 50000

    assert api.put("/api/v1/watchlist/COMI", headers=h).status_code == 200
    body = {"side": "BUY", "symbol": "COMI", "qty": 10, "client_order_id": "x1", "note": "first"}
    first = api.post("/api/v1/trades", json=body, headers=h)
    assert first.status_code == 201, first.text
    assert api.post("/api/v1/trades", json=body, headers=h).json()["seq"] == first.json()["seq"]
    assert api.post("/api/v1/trades", json={"side": "SELL", "symbol": "COMI", "qty": 4}, headers=h).status_code == 201
    assert api.post("/api/v1/trades", json={"side": "SELL", "symbol": "COMI", "qty": 99}, headers=h).status_code == 422

    pf = api.get("/api/v1/portfolio", headers=h).json()
    assert pf["holdings"][0]["qty"] == 6
    sm = pf["summary"]
    assert sm["total_net"] == pytest.approx(sm["realized_net"] + sm["unrealized_net_est"])
    t = api.get("/api/v1/trades", headers=h).json()
    assert [r["type"] for r in t["transactions"]] == ["SELL", "BUY", "DEPOSIT"]
    assert "COMI" in api.get("/api/v1/trades/export.csv", headers=h).text

    st = api.post("/api/v1/strategies", json={"name": "Trend", "type": "sma_cross", "sectors": ["Banks"]}, headers=h).json()
    bt = api.post("/api/v1/backtests", json={"strategy_id": st["id"]}, headers=h)
    assert bt.status_code == 201, bt.text
    assert api.get(f"/api/v1/backtests/{bt.json()['id']}", headers=h).json()["metrics"] == bt.json()["metrics"]
    assert api.get("/api/v1/backtests", headers=h).json()[0]["strategy_name"] == "Trend"

    audit = api.get("/api/v1/audit", params={"limit": 3}, headers=h).json()
    assert len(audit) == 3 and audit[0]["entity"] == "backtest" and audit[0]["seq"] > audit[1]["seq"]

    good = "Date,Open,High,Low,Close,Volume\n2024-01-01,10,11,9,10.5,1000\n2024-01-02,10.5,12,10,11,2000\n"
    r = api.post("/api/v1/data/bars/import", data={"symbol": "TMGH"}, files={"file": ("c.csv", good, "text/csv")}, headers=h)
    assert r.status_code == 200, r.text
    assert api.get("/api/v1/stocks/TMGH", headers=h).json()["quote"]["source"] == "csv"
    assert api.get("/api/v1/status", headers=h).json()["data"]["mode"] == "mixed"

    # a second account sees none of it
    other = "o-" + uuid.uuid4().hex[:8]
    provision(other)
    ho = {"Authorization": f"Bearer {token(other)}"}
    assert api.get("/api/v1/portfolio", headers=ho).json()["holdings"] == []
    assert api.get("/api/v1/watchlist", headers=ho).json() == []
    assert api.get("/api/v1/stocks/TMGH", headers=ho).json()["quote"]["source"] == "sample"


def test_rules_isolate_users_and_freeze_the_ledger(api, user):
    uid, h = user
    api.post("/api/v1/trades", json={"side": "BUY", "symbol": "COMI", "qty": 1}, headers=h)
    pid = api.get("/api/v1/settings", headers=h).json()["active_portfolio_id"]
    ledger = f"{DOCS}/egx/{uid}/ledger_{pid}"
    mine = httpx.get(ledger, headers=h)
    assert mine.status_code == 200 and len(mine.json()["documents"]) == 2
    name = mine.json()["documents"][0]["name"].split("/documents/")[1]

    # the owner cannot rewrite or delete a ledger entry, nor an audit entry
    assert httpx.patch(f"{DOCS}/{name}", headers=h, json={"fields": {"body": {"stringValue": "{}"}}}).status_code == 403
    assert httpx.delete(f"{DOCS}/{name}", headers=h).status_code == 403
    assert httpx.delete(f"{DOCS}/egx/{uid}/audit/000000000001", headers=h).status_code == 403
    # ...but ordinary settings stay editable
    assert api.put("/api/v1/settings", json={"starting_capital": 60000}, headers=h).status_code == 200

    other = "o-" + uuid.uuid4().hex[:8]
    provision(other)
    ho = {"Authorization": f"Bearer {token(other)}"}
    assert httpx.get(ledger, headers=ho).status_code == 403
    assert httpx.get(f"{DOCS}/egx/{uid}/settings/app", headers=ho).status_code == 403
    assert httpx.patch(f"{DOCS}/egx/{uid}/settings/app", headers=ho, json={"fields": {"body": {"stringValue": "{}"}}}).status_code == 403
    assert httpx.get(f"{DOCS}/egx/{uid}/settings/app").status_code == 403  # anonymous


def test_append_conflict_is_reported_not_overwritten(user):
    from app.store.firestore_store import ConflictError, FirestoreStore
    uid, h = user
    os.environ["FIRESTORE_EMULATOR_HOST"] = HOST
    a = FirestoreStore(PROJECT, token(uid), uid)
    b = FirestoreStore(PROJECT, token(uid), uid)
    a.list("ledger_x"), b.list("ledger_x")         # both think the ledger is empty
    assert a.append("ledger_x", {"v": "a"})["seq"] == 1
    with pytest.raises(ConflictError):
        b.append("ledger_x", {"v": "b"})           # same sequence number: refused
    assert b.append("ledger_x", {"v": "b"})["seq"] == 2
    assert [d["v"] for d in FirestoreStore(PROJECT, token(uid), uid).list("ledger_x")] == ["a", "b"]


def test_failed_transaction_writes_nothing(user):
    from app.store.firestore_store import FirestoreStore
    uid, _ = user
    os.environ["FIRESTORE_EMULATOR_HOST"] = HOST
    s = FirestoreStore(PROJECT, token(uid), uid)
    with pytest.raises(ZeroDivisionError):
        with s.transaction():
            s.put("settings", "t", {"a": 1})
            s.append("audit", {"x": 1})
            raise ZeroDivisionError
    fresh = FirestoreStore(PROJECT, token(uid), uid)
    assert fresh.get("settings", "t") is None and fresh.list("audit") == []


def test_first_load_race_creates_exactly_one_portfolio(api, user):
    """Several requests arrive together on a brand-new account; none may fail or double-initialise."""
    from concurrent.futures import ThreadPoolExecutor
    uid, h = user
    with ThreadPoolExecutor(6) as pool:
        codes = list(pool.map(lambda p: api.get(p, headers=h).status_code,
                              ["/api/v1/status", "/api/v1/portfolio", "/api/v1/watchlist",
                               "/api/v1/settings", "/api/v1/trades", "/api/v1/market/overview"]))
    assert codes == [200] * 6
    docs = httpx.get(f"{DOCS}/egx/{uid}/portfolios", headers=h).json()["documents"]
    assert len(docs) == 1
    assert api.get("/api/v1/portfolio", headers=h).json()["summary"]["cash"] == 50000


# ---- accounts created from inside the app -----------------------------------
AUTH_HOST = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")
IDP = f"http://{AUTH_HOST}/identitytoolkit.googleapis.com/v1"


@pytest.fixture()
def acc_api(monkeypatch):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", AUTH_HOST)
    from app.config import Settings
    from app.main import create_app
    cfg = Settings(store_backend="firestore", firebase_project_id=PROJECT, firebase_web_api_key="fake-api-key")
    with TestClient(create_app(cfg)) as c:
        yield c


def sign_in(email: str, password: str) -> dict:
    res = httpx.post(f"{IDP}/accounts:signInWithPassword", params={"key": "fake-api-key"},
                     json={"email": email, "password": password, "returnSecureToken": True})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['idToken']}"}


def test_admin_creates_an_account_that_can_use_egx_and_nothing_else(acc_api, user):
    admin_uid, h = user
    email = f"friend-{uuid.uuid4().hex[:8]}@example.com"
    assert acc_api.get("/api/v1/accounts", headers=h).json() == {"can_manage": True, "accounts": []} or \
        acc_api.get("/api/v1/accounts", headers=h).json()["can_manage"] is True

    assert acc_api.post("/api/v1/accounts", json={"email": "not-an-email", "name": "X", "password": "long-enough-1"}, headers=h).status_code == 422
    assert acc_api.post("/api/v1/accounts", json={"email": email, "name": "X", "password": "short"}, headers=h).status_code == 422
    made = acc_api.post("/api/v1/accounts", json={"email": email.upper(), "name": " Friend ", "password": "long-enough-1"}, headers=h)
    assert made.status_code == 201, made.text
    new_uid = made.json()["uid"]
    assert made.json()["email"] == email and made.json()["name"] == "Friend"
    assert "password" not in made.text
    dup = acc_api.post("/api/v1/accounts", json={"email": email, "name": "Again", "password": "long-enough-1"}, headers=h)
    assert dup.status_code == 422 and "already" in dup.json()["detail"]

    listed = acc_api.get("/api/v1/accounts", headers=h).json()["accounts"]
    assert any(a["uid"] == new_uid and a["active"] is True and a["createdBy"] == admin_uid for a in listed)
    assert acc_api.get("/api/v1/audit", params={"limit": 1}, headers=h).json()[0]["entity"] == "account"

    # the new person signs in and gets their own paper portfolio
    hn = sign_in(email, "long-enough-1")
    assert acc_api.get("/api/v1/portfolio", headers=hn).json()["summary"]["cash"] == 50000
    assert acc_api.post("/api/v1/trades", json={"side": "BUY", "symbol": "COMI", "qty": 1}, headers=hn).status_code == 201
    # ...cannot manage accounts, cannot see the admin's data or the quality system
    assert acc_api.get("/api/v1/accounts", headers=hn).json() == {"can_manage": False, "accounts": []}
    assert acc_api.post("/api/v1/accounts", json={"email": "x@example.com", "name": "X", "password": "long-enough-1"}, headers=hn).status_code == 401
    assert acc_api.put(f"/api/v1/accounts/{admin_uid}", json={"active": False}, headers=hn).status_code == 401
    for path in (f"egx/{admin_uid}/settings/app", f"users/{admin_uid}", "planningLines", "inspections", "egxAccounts"):
        assert httpx.get(f"{DOCS}/{path}", headers=hn).status_code == 403, path
    assert httpx.get(f"{DOCS}/egxAccounts/{new_uid}", headers=hn).status_code == 200      # own record: readable
    grant = {"fields": {"active": {"booleanValue": True}, "createdBy": {"stringValue": new_uid}}}
    assert httpx.patch(f"{DOCS}/egxAccounts/{new_uid}", headers=hn, json=grant).status_code == 403  # ...not writable
    assert httpx.patch(f"{DOCS}/users/{new_uid}", headers=hn, json={"fields": {"active": {"booleanValue": True}, "role": {"stringValue": "ADMIN"}}}).status_code == 403

    # deactivating stops the account on its next request; reactivating restores it with its data
    assert acc_api.put(f"/api/v1/accounts/{admin_uid}", json={"active": False}, headers=h).status_code == 422  # not your own
    assert acc_api.put(f"/api/v1/accounts/{new_uid}", json={"active": False}, headers=h).status_code == 200
    assert acc_api.get("/api/v1/portfolio", headers=hn).status_code == 401
    assert acc_api.put(f"/api/v1/accounts/{new_uid}", json={"active": True}, headers=h).status_code == 200
    assert len(acc_api.get("/api/v1/portfolio", headers=hn).json()["holdings"]) == 1
    assert acc_api.put("/api/v1/accounts/no-such-uid", json={"active": True}, headers=h).status_code == 422
    assert httpx.delete(f"{DOCS}/egxAccounts/{new_uid}", headers=h).status_code == 403


def test_a_non_admin_quality_account_cannot_create_accounts(acc_api):
    uid = "insp-" + uuid.uuid4().hex[:8]
    res = httpx.patch(f"{DOCS}/users/{uid}", headers={"Authorization": "Bearer owner"},
                      json={"fields": {"active": {"booleanValue": True}, "role": {"stringValue": "INSPECTOR"}}})
    assert res.status_code == 200
    h = {"Authorization": f"Bearer {token(uid)}"}
    email = f"nope-{uuid.uuid4().hex[:8]}@example.com"
    assert acc_api.get("/api/v1/accounts", headers=h).json()["can_manage"] is False
    assert acc_api.post("/api/v1/accounts", json={"email": email, "name": "X", "password": "long-enough-1"}, headers=h).status_code == 401
    # nothing was left behind: the sign-in does not exist
    res = httpx.post(f"{IDP}/accounts:signInWithPassword", params={"key": "fake-api-key"},
                     json={"email": email, "password": "long-enough-1", "returnSecureToken": True})
    assert res.status_code == 400
    # and the rules refuse the grant even if the API is bypassed
    grant = {"fields": {"active": {"booleanValue": True}, "createdBy": {"stringValue": uid}}}
    assert httpx.patch(f"{DOCS}/egxAccounts/someone", headers=h, json=grant).status_code == 403


# ---- shared market data from the feed ----------------------------------------
def test_feed_data_is_shared_between_accounts_and_closed_to_strangers(monkeypatch, user):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    from app.config import Settings
    from app.data.feed import Feed
    from app.main import create_app
    from tests.test_feed import FakeYounit
    Feed.reset()
    cfg = Settings(store_backend="firestore", firebase_project_id=PROJECT)
    with TestClient(create_app(cfg, younit=FakeYounit())) as api:
        uid, h = user
        out = api.post("/api/v1/data/refresh", headers=h)
        assert out.status_code == 200 and out.json()["remaining"] == 0, out.text
        assert api.get("/api/v1/status", headers=h).json()["data"]["mode"] == "younit"

        other = "o-" + uuid.uuid4().hex[:8]
        provision(other)
        ho = {"Authorization": f"Bearer {token(other)}"}
        Feed.reset()  # as if served by a different server instance
        assert {r["symbol"] for r in api.get("/api/v1/stocks", headers=ho).json()} == {"COMI", "TMGH", "NEWCO"}

        stranger = {"Authorization": f"Bearer {token('s-' + uuid.uuid4().hex[:8])}"}
        assert httpx.get(f"{DOCS}/egxMarket/index", headers=stranger).status_code == 403
        assert httpx.get(f"{DOCS}/egxMarket/index").status_code == 403
        assert httpx.patch(f"{DOCS}/egxMarket/index", headers=stranger, json={"fields": {"body": {"stringValue": "{}"}}}).status_code == 403
        assert httpx.delete(f"{DOCS}/egxMarket/index", headers=h).status_code == 403
        assert api.post("/api/v1/data/refresh", headers=stranger).status_code == 401
    Feed.reset()
