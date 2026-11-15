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


# ---- phase two on Firestore ---------------------------------------------------
def test_runs_research_journal_and_alerts_persist_in_firestore(api, user):
    from tests.test_phase2 import FLAT, UP, csv
    _, h = user

    def load(closes):
        text, days = csv(closes)
        r = api.post("/api/v1/data/bars/import", data={"symbol": "COMI"}, files={"file": ("x.csv", text, "text/csv")}, headers=h)
        assert r.status_code == 200, r.text
        return days

    load(FLAT)
    st = api.post("/api/v1/strategies", headers=h, json={
        "name": "Fast trend", "type": "sma_cross", "symbols": ["COMI"], "params": {"fast": 2, "slow": 5},
        "risk": {"stop_loss_pct": None, "max_alloc_pct": 50, "cash_reserve_pct": 0, "slippage_bps": 0}}).json()
    run = api.post("/api/v1/paper-runs", json={"strategy_id": st["id"], "capital": 20000}, headers=h)
    assert run.status_code == 201, run.text
    days = load(FLAT + UP)
    assert api.post("/api/v1/paper-runs/process", headers=h).json()["fills"] == 1
    assert api.post("/api/v1/paper-runs/process", headers=h).json()["fills"] == 0
    buy = api.get("/api/v1/trades", headers=h).json()["transactions"][0]
    assert buy["type"] == "BUY" and buy["trade_date"] == days[31] and buy["origin"].startswith("strategy:")
    assert api.get("/api/v1/paper-runs", headers=h).json()[0]["positions"][0]["qty"] == buy["qty"]

    assert api.post("/api/v1/research", json={"title": "Note", "symbols": ["COMI"]}, headers=h).status_code == 201
    assert api.post("/api/v1/journal", json={"thesis": "Why", "symbol": "COMI"}, headers=h).status_code == 201
    assert api.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "COMI", "value": 1}, headers=h).status_code == 201
    assert len(api.post("/api/v1/alerts/check", headers=h).json()["triggered"]) == 1
    assert api.post("/api/v1/alerts/check", headers=h).json()["triggered"] == []
    assert len(api.get("/api/v1/alerts", headers=h).json()["events"]) == 1
    two = api.post("/api/v1/strategies", json={"name": "Other", "type": "breakout"}, headers=h).json()
    cmp = api.post("/api/v1/backtests/compare", json={"strategy_ids": [st["id"], two["id"]], "symbols": ["COMI", "TMGH"]}, headers=h)
    assert cmp.status_code == 201 and len(cmp.json()["runs"]) == 2

    # another account sees none of it
    other = "o-" + uuid.uuid4().hex[:8]
    provision(other)
    ho = {"Authorization": f"Bearer {token(other)}"}
    for path in ("/api/v1/research", "/api/v1/journal", "/api/v1/paper-runs"):
        assert api.get(path, headers=ho).json() == []
    assert api.get("/api/v1/alerts", headers=ho).json()["alerts"] == []


# ---- concurrent changes ---------------------------------------------------------
def stores(monkeypatch, uid, n=2):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    from app.store.firestore_store import FirestoreStore
    return [FirestoreStore(PROJECT, token(uid), uid) for _ in range(n)]


def test_a_stale_overwrite_is_refused_instead_of_silently_winning(monkeypatch, user):
    """Pause pressed while the background job saves a fill for the same run: neither may undo the other."""
    from app.services import retry_conflict
    from app.store.errors import ConflictError
    uid, _ = user
    a, b = stores(monkeypatch, uid)
    a.put("paper_runs", "r1", {"status": "active", "trades": 0})
    job, button = stores(monkeypatch, uid)
    filling = job.get("paper_runs", "r1")          # both requests read the run ...
    pausing = button.get("paper_runs", "r1")
    job.put("paper_runs", "r1", {**filling, "trades": 1})          # ... the job saves its fill first
    with pytest.raises(ConflictError):
        button.put("paper_runs", "r1", {**pausing, "status": "paused"})   # the stale copy must not erase it
    # the second attempt starts from the current data and keeps both changes
    def pause():
        doc = button.get("paper_runs", "r1")
        button.put("paper_runs", "r1", {**doc, "status": "paused"})
    retry_conflict(pause)()
    assert stores(monkeypatch, uid, 1)[0].get("paper_runs", "r1") == {"status": "paused", "trades": 1}
    # a document read from a collection listing is protected in the same way
    one, two = stores(monkeypatch, uid)
    listed = one.list("paper_runs")[0]
    two.put("paper_runs", "r1", {"status": "stopped", "trades": 1})
    with pytest.raises(ConflictError):
        one.put("paper_runs", "r1", {**listed, "trades": 2})
    # and so is one that did not exist when this request looked
    first, second = stores(monkeypatch, uid)
    assert first.get("alerts", "x") is None and second.get("alerts", "x") is None
    first.put("alerts", "x", {"v": 1})
    with pytest.raises(ConflictError):
        second.put("alerts", "x", {"v": 2})


def test_writes_inside_one_request_do_not_trip_over_each_other(monkeypatch, user):
    uid, _ = user
    (s,) = stores(monkeypatch, uid, 1)
    s.put("settings", "app", {"n": 1})              # never read: an ordinary write
    assert s.get("settings", "app") == {"n": 1}
    s.put("settings", "app", {"n": 2})              # written by this request a moment ago: still allowed
    with s.transaction():                           # twice in one transaction: one write goes out
        s.put("settings", "app", {"n": 3})
        s.put("settings", "app", {"n": 4})
        assert s.get("settings", "app") == {"n": 4}
    with s.transaction():                           # an append made before the collection was read still shows in it
        s.append("ledger_p", {"type": "DEPOSIT", "amount": "1"})
        assert [d["seq"] for d in s.list("ledger_p")] == [1]
        s.append("ledger_p", {"type": "BUY"})
        assert [d["seq"] for d in s.list("ledger_p")] == [1, 2]
    assert s.delete("settings", "app") is True and s.get("settings", "app") is None
    s.put("settings", "app", {"n": 5})              # deleted by this request: can be written again
    (fresh,) = stores(monkeypatch, uid, 1)
    assert fresh.get("settings", "app") == {"n": 5} and [d["seq"] for d in fresh.list("ledger_p")] == [1, 2]


def test_appending_to_a_long_log_does_not_download_it(monkeypatch, user):
    from app.store.errors import ConflictError
    uid, _ = user
    (seed,) = stores(monkeypatch, uid, 1)
    with seed.transaction():
        for i in range(40):
            seed.append("audit", {"action": f"a{i}"})
    (s,) = stores(monkeypatch, uid, 1)
    calls = []
    original = s._request
    monkeypatch.setattr(s, "_request", lambda method, url, **kw: (calls.append((method, url.rsplit("/", 1)[-1])), original(method, url, **kw))[1])
    assert s.append("audit", {"action": "new"})["seq"] == 41
    assert s.append("audit", {"action": "newer"})["seq"] == 42
    # one small query for the newest entry, then the writes: the forty old entries are never listed
    assert [c[0] for c in calls] == ["POST", "POST", "POST"] and not any(m == "GET" for m, _ in calls)
    assert [d["action"] for d in s.recent("audit", 2)] == ["newer", "new"]
    # two writers still cannot take the same number
    a, b = stores(monkeypatch, uid)
    a.append("audit", {"action": "a"})
    b._next["audit"] = 43
    with pytest.raises(ConflictError):
        b.append("audit", {"action": "b"})


def test_shared_market_documents_are_version_checked(monkeypatch, user):
    from app.data.feed import FirestoreDocs
    from app.store.errors import ConflictError
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    uid, _ = user
    name = "chunk_t" + uuid.uuid4().hex[:6]
    a, b = FirestoreDocs(PROJECT, token(uid)), FirestoreDocs(PROJECT, token(uid))
    assert a.get(name) is None and b.get(name) is None
    a.put(name, {"bars": {"X": [1]}}, guard=True)
    with pytest.raises(ConflictError):               # b saw it missing; someone created it meanwhile
        b.put(name, {"bars": {"Y": [1]}}, guard=True)
    doc = b.get(name)
    doc["bars"]["Y"] = [1]
    b.put(name, doc, guard=True)                     # re-read, merged, written
    a.get(name)
    b.put(name, {"bars": {"X": [1], "Y": [1, 2]}}, guard=True)   # b's own latest version: allowed again
    with pytest.raises(ConflictError):
        a.put(name, {"bars": {}}, guard=True)
    a.put(name, {"bars": {"X": [1], "Y": [1, 2], "Z": []}})     # unguarded documents (live prices) are last-writer-wins
    assert FirestoreDocs(PROJECT, token(uid)).get(name)["bars"]["Z"] == []
