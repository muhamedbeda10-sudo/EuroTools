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
