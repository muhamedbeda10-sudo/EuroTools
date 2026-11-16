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


def _closed_to_writing() -> bool:
    """firestore.rules closed the egx tree to writing when the data moved to Postgres (16 November 2026)."""
    from pathlib import Path
    rules = (Path(__file__).resolve().parents[2] / "firestore.rules").read_text()
    tree = rules[rules.index("match /egx/{uid}/{coll}/{docId}"):]
    return "allow write: if false;" in tree[:tree.index("match /egxMarket/")]


# These tests write an account's data to Firestore through the API, which the rules no longer allow. They are kept
# for the day the Firestore backend is wanted again (open the tree in firestore.rules and they run as before); what
# is deployed is covered by test_postgres.py, test_identity.py and test_migrate.py.
pytestmark = [pytest.mark.skipif(not _emulator_up(), reason="Firestore emulator not running"),
              pytest.mark.skipif(_closed_to_writing(), reason="firestore.rules: the egx tree is closed to writing since the move to Postgres")]


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


# ---- the assistant on the deployed store -------------------------------------------------
def test_the_assistant_is_for_administrators_and_keeps_its_conversations_in_the_users_own_data(monkeypatch):
    from app.config import Settings
    from app.main import create_app
    from tests.test_assistant import Script, call, events
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    admin = "u-" + uuid.uuid4().hex[:10]
    provision(admin)
    member = "u-" + uuid.uuid4().hex[:10]          # signed in, active, but not an administrator
    res = httpx.patch(f"{DOCS}/users/{member}", headers={"Authorization": "Bearer owner"},
                      json={"fields": {"active": {"booleanValue": True}, "role": {"stringValue": "INSPECTOR"}}})
    assert res.status_code == 200
    ha, hm = ({"Authorization": f"Bearer {token(u)}"} for u in (admin, member))
    script = Script({"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=5)]}, {"say": "Bought 5 COMI."})
    settings = Settings(store_backend="firestore", firebase_project_id=PROJECT)
    with TestClient(create_app(settings, assistant_model=script)) as c:
        assert c.get("/api/v1/assistant", headers=hm).json()["allowed"] is False
        assert c.post("/api/v1/assistant/chats", headers=hm).status_code == 403
        assert c.get("/api/v1/assistant", headers=ha).json()["allowed"] is True
        chat = c.post("/api/v1/assistant/chats", headers=ha).json()["id"]
        out = events(c.post(f"/api/v1/assistant/chats/{chat}/messages", headers=ha, json={"text": "buy 5 COMI"}))
        assert out[-1]["type"] == "done" and out[1]["changed"] is True
        view = c.get(f"/api/v1/assistant/chats/{chat}", headers=ha).json()
        assert view["items"][-1]["text"] == "Bought 5 COMI." and view["usage"]["calls"] == 2
        assert c.get("/api/v1/trades", headers=ha).json()["totals"]["count"] == 1
        assert c.get(f"/api/v1/assistant/chats/{chat}", headers=hm).status_code == 403     # and nobody else's to read
    # with the switch set to everyone, a member may use it too, on their own data only
    script = Script({"say": "Hello."})
    with TestClient(create_app(Settings(store_backend="firestore", firebase_project_id=PROJECT, assistant_users="all"),
                               assistant_model=script)) as c:
        mine = c.post("/api/v1/assistant/chats", headers=hm)
        assert mine.status_code == 201
        assert c.get(f"/api/v1/assistant/chats/{chat}", headers=hm).status_code == 404     # the admin's conversation is not there


# ---- the real brokerage account on the deployed store --------------------------------------
def test_the_real_account_is_shown_to_its_named_owner_and_to_nobody_else(monkeypatch):
    from app import broker
    from app.config import Settings
    from app.data.feed import Feed
    from app.main import create_app
    from tests.test_broker import FakeBroker
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    Feed.reset()
    broker.reset()
    owner, admin = ("u-" + uuid.uuid4().hex[:10] for _ in range(2))
    provision(owner)
    provision(admin)                                # an administrator too, but not named as the account's owner
    ho, ha = ({"Authorization": f"Bearer {token(u)}"} for u in (owner, admin))
    fake = FakeBroker()
    fake.hold((1, "COMI", "Commercial Bank", 10, 10, 80.0, 82.0))

    named = Settings(store_backend="firestore", firebase_project_id=PROJECT, broker_account_uids=f"someone-else,{owner}")
    with TestClient(create_app(named, younit=fake)) as c:
        assert c.get("/api/v1/status", headers=ha).json()["real_account"] == {"connected": True, "allowed": False, "user_id": admin}
        refused = c.get("/api/v1/real-account", headers=ha)
        assert refused.status_code == 403 and fake.reads == []          # refused before the broker is asked anything
        assert c.get("/api/v1/real-account").status_code == 401         # signed out

        assert c.get("/api/v1/status", headers=ho).json()["real_account"] == {"connected": True, "allowed": True, "user_id": owner}
        mine = c.get("/api/v1/real-account", headers=ho)
        assert mine.status_code == 200 and mine.json()["summary"]["cash"] == 5000.25
        assert mine.json()["holdings"][0]["qty"] == 10
        # nothing about the real account was written to anybody's data
        for h in (ho, ha):
            audit = c.get("/api/v1/audit", headers=h).json()
            assert not [a for a in audit if "real" in a["entity"] or "broker" in a["entity"]]
            assert c.get("/api/v1/portfolio", headers=h).json()["holdings"] == []

    # nobody is named on the server: nobody sees the account, administrators included
    fake.reads.clear()
    broker.reset()
    with TestClient(create_app(Settings(store_backend="firestore", firebase_project_id=PROJECT), younit=fake)) as c:
        for h in (ho, ha):
            assert c.get("/api/v1/status", headers=h).json()["real_account"]["allowed"] is False
            assert c.get("/api/v1/real-account", headers=h).status_code == 403
        assert fake.reads == []
    Feed.reset()
    broker.reset()


# ---- real orders on the deployed store ------------------------------------------------------
def test_real_orders_are_the_owners_and_two_approvals_at_once_cannot_both_go_out(monkeypatch):
    from datetime import datetime

    from app import broker, real_orders
    from app.config import Settings
    from app.data.calendar import CAIRO
    from app.data.feed import Feed
    from app.main import create_app
    from tests.test_broker import FakeBroker
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    monkeypatch.setattr(real_orders, "cairo_now", lambda: datetime(2026, 11, 15, 11, 0, tzinfo=CAIRO))   # a Sunday, mid-session
    Feed.reset()
    broker.reset()
    real_orders.reset()
    owner, admin = ("u-" + uuid.uuid4().hex[:10] for _ in range(2))
    provision(owner)
    provision(admin)
    ho, ha = ({"Authorization": f"Bearer {token(u)}"} for u in (owner, admin))
    fake = FakeBroker()
    fake.listing = [s for s in fake.listing if s["symbol"] != "EAST"]   # market data is shared: leave it as the other tests expect it
    limits = {"enabled": True, "max_order_value": 5000, "max_day_value": 8000, "max_day_orders": 1, "price_band_pct": 2, "symbols": []}
    cfg = Settings(store_backend="firestore", firebase_project_id=PROJECT, broker_account_uids=owner, live_trading_enabled=True)
    with TestClient(create_app(cfg, younit=fake)) as c:
        while c.post("/api/v1/data/refresh", headers=ho).json()["remaining"]:
            pass
        comi = round(c.get("/api/v1/stocks/COMI", headers=ho).json()["quote"]["last"], 3)
        tmgh = round(c.get("/api/v1/stocks/TMGH", headers=ho).json()["quote"]["last"], 3)

        # another administrator is not the owner: nothing of real orders is theirs to see or to do
        assert c.get("/api/v1/status", headers=ha).json()["real_orders"] == {"allowed": False, "ready": False, "waiting": 0, "auto": False, "background": False}
        for method, path, body in (("get", "/api/v1/real-orders", None), ("put", "/api/v1/real-orders/settings", limits),
                                   ("post", "/api/v1/real-orders", {"symbol": "COMI", "side": "BUY", "qty": 1, "price": comi})):
            assert c.request(method, path, json=body, headers=ha).status_code == 403
        assert c.get("/api/v1/real-orders").status_code == 401                 # signed out

        assert c.put("/api/v1/real-orders/settings", json=limits, headers=ho).json()["ready"] is True
        a = c.post("/api/v1/real-orders", json={"symbol": "COMI", "side": "BUY", "qty": 10, "price": comi}, headers=ho).json()
        b = c.post("/api/v1/real-orders", json={"symbol": "TMGH", "side": "BUY", "qty": 5, "price": tmgh}, headers=ho).json()
        assert c.get("/api/v1/status", headers=ho).json()["real_orders"] == {"allowed": True, "ready": True, "waiting": 2, "auto": False, "background": False}
        assert c.post(f"/api/v1/real-orders/{a['id']}/approve", headers=ha,     # not theirs to approve either
                      json={k: a[k] for k in ("symbol", "side", "qty", "price")}).status_code == 403

        def approve(order):
            return c.post(f"/api/v1/real-orders/{order['id']}/approve", headers=ho,
                          json={k: order[k] for k in ("symbol", "side", "qty", "price")})

        def on_another_server(order):
            """The same yes arriving at a second server: its own store, none of this server's locks."""
            from app.data.feed import FirestoreDocs
            from app.services import App
            from app.store.firestore_store import FirestoreStore
            other = App(FirestoreStore(PROJECT, token(owner), owner), cfg, {}, Feed(FirestoreDocs(PROJECT, token(owner))), fake).bootstrap()
            other.real_account_allowed = True
            return real_orders._approve(other, order["id"], real_orders.ApproveIn(**{k: order[k] for k in ("symbol", "side", "qty", "price")}))

        # While the first approval is being checked against the broker, a second one goes all the way through elsewhere.
        asked, inner = fake.buying_power, {}

        def slow(stock_id):
            if not inner:
                inner["started"] = True          # once: the approval made here asks the broker too
                inner["res"] = on_another_server(b)
            return asked(stock_id)
        fake.buying_power = slow
        first = approve(a)
        fake.buying_power = asked
        assert inner["res"]["status"] == "sent"
        assert first.status_code == 409                                          # the database refused the stale yes
        assert [o["stock_id"] for o in fake.sent] == [2]                         # one order went out, not two
        # judged again against what is true now, the day's limit of one order stops it
        again = approve(a)
        assert again.status_code == 422 and "limit is 1 a day" in again.json()["detail"] and len(fake.sent) == 1

        # the same proposal approved twice at the same moment: sent once
        c.put("/api/v1/real-orders/settings", json={**limits, "max_day_orders": 5}, headers=ho)
        inner.clear()

        def twice(stock_id):
            if not inner:
                inner["started"] = True
                inner["res"] = on_another_server(a)
            return asked(stock_id)
        fake.buying_power = twice
        outer = approve(a)
        fake.buying_power = asked
        assert inner["res"]["status"] == "sent" and outer.status_code == 409
        assert [o["stock_id"] for o in fake.sent] == [2, 1]
        view = c.get("/api/v1/real-orders", headers=ho).json()
        assert view["today"]["orders"] == 2 and view["waiting"] == [] and {o["status"] for o in view["orders"]} == {"sent"}
        assert c.get("/api/v1/status", headers=ho).json()["real_orders"]["waiting"] == 0
        # the paper side of the same account is untouched, and the other administrator's data holds none of it
        assert c.get("/api/v1/portfolio", headers=ho).json()["holdings"] == []
        assert not [e for e in c.get("/api/v1/audit", headers=ha).json() if e["entity"].startswith("real_")]
        assert [e["action"] for e in c.get("/api/v1/audit", headers=ho).json() if e["entity"] == "real_order"][:2] == ["send", "approve"]
    Feed.reset()
    broker.reset()
    real_orders.reset()


def test_automatic_orders_are_the_owners_and_two_looks_at_once_send_one_order(monkeypatch):
    """Two open windows ask for a look at the same moment, on two servers: the database lets one of them act."""
    import contextlib
    from datetime import datetime
    from decimal import Decimal

    from app import broker, real_auto, real_orders
    from app.config import Settings
    from app.data.calendar import CAIRO
    from app.data.feed import Feed, FirestoreDocs
    from app.main import create_app
    from app.services import App
    from app.store.errors import ConflictError
    from app.store.firestore_store import FirestoreStore
    from tests.test_broker import FakeBroker
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    for module in (real_orders, real_auto):
        monkeypatch.setattr(module, "cairo_now", lambda: datetime(2026, 11, 15, 11, 0, tzinfo=CAIRO))   # a Sunday, mid-session
    monkeypatch.setattr(real_orders, "_approving", contextlib.nullcontext())   # the second server is played inside this process
    Feed.reset()
    broker.reset()
    real_orders.reset()
    owner, admin = ("u-" + uuid.uuid4().hex[:10] for _ in range(2))
    provision(owner)
    provision(admin)
    ho, ha = ({"Authorization": f"Bearer {token(u)}"} for u in (owner, admin))
    fake = FakeBroker()
    fake.listing = [s for s in fake.listing if s["symbol"] != "EAST"]   # market data is shared: leave it as the other tests expect it
    limits = {"enabled": True, "max_order_value": 5000, "max_day_value": 90000, "max_day_orders": 30, "price_band_pct": 5, "symbols": []}
    box = {"enabled": True, "budget": 3000, "max_order_value": 1000, "max_day_buys": 5, "max_loss": 300, "max_stop_pct": 8,
           "symbols": ["COMI", "TMGH"]}
    cfg = Settings(store_backend="firestore", firebase_project_id=PROJECT, broker_account_uids=owner, live_trading_enabled=True)

    def server():
        """A second server for the same owner: its own store, none of this one's locks or memory."""
        other = App(FirestoreStore(PROJECT, token(owner), owner), cfg, {}, Feed(FirestoreDocs(PROJECT, token(owner))), fake).bootstrap()
        other.real_account_allowed = True
        return other

    with TestClient(create_app(cfg, younit=fake)) as c:
        while c.post("/api/v1/data/refresh", headers=ho).json()["remaining"]:
            pass
        comi = round(c.get("/api/v1/stocks/COMI", headers=ho).json()["quote"]["last"], 3)
        tmgh = round(c.get("/api/v1/stocks/TMGH", headers=ho).json()["quote"]["last"], 3)

        # not the owner, and signed out
        for method, path, body in (("get", "/api/v1/real-orders/auto", None), ("put", "/api/v1/real-orders/auto", box),
                                   ("post", "/api/v1/real-orders/auto/tick", None), ("post", "/api/v1/real-orders/auto/stop", None)):
            assert c.request(method, path, json=body, headers=ha).status_code == 403, path
            assert c.request(method, path, json=body).status_code == 401, path

        # locked until three orders approved by hand were accepted and one of them filled
        assert c.put("/api/v1/real-orders/settings", json=limits, headers=ho).json()["ready"] is True
        assert c.put("/api/v1/real-orders/auto", json=box, headers=ho).status_code == 422
        for n in range(3):
            made = c.post("/api/v1/real-orders", json={"symbol": "TMGH", "side": "BUY", "qty": 1, "price": round(tmgh - n / 10, 1)},
                          headers=ho).json()
            assert c.post(f"/api/v1/real-orders/{made['id']}/approve", headers=ho,
                          json={k: made[k] for k in ("symbol", "side", "qty", "price")}).json()["status"] == "sent"
        fake.book[0].update(status="Executed", executed_qty=1, average=tmgh)
        real_orders.reset()
        c.get("/api/v1/real-orders", headers=ho)
        now_on = c.put("/api/v1/real-orders/auto", json=box, headers=ho)
        assert now_on.status_code == 200 and now_on.json()["on"] and now_on.json()["proof"]["proven"]
        assert c.get("/api/v1/status", headers=ho).json()["real_orders"]["auto"] is True
        assert c.get("/api/v1/status", headers=ha).json()["real_orders"]["auto"] is False
        fake.sent.clear()

        def suggest(**order):
            body = {"symbol": "COMI", "side": "BUY", "qty": 10, "price": Decimal(str(comi)), "stop_price": Decimal(str(round(comi * 0.95, 2))),
                    "reason": "Broke out on volume; wrong if it falls back under the breakout.", **order}
            other = server()
            made = real_orders.propose(other, real_orders.OrderIn(**body), "assistant")
            assert real_auto.admit(other, made["id"])["will_be_sent_automatically"]
            return made

        # while this server's look is asking the broker, the look of a second window goes all the way through elsewhere
        one = suggest()
        asked, inner = fake.buying_power, {}

        def slow(stock_id):
            if not inner:
                inner["started"] = True
                inner["res"] = real_auto._tick(server(), {"sent": [], "exits": [], "notes": []})
            return asked(stock_id)
        fake.buying_power = slow
        outer = c.post("/api/v1/real-orders/auto/tick", headers=ho).json()
        fake.buying_power = asked
        assert [o["id"] for o in inner["res"]["sent"]] == [one["id"]] and inner["res"]["sent"][0]["approved_by"] == "auto"
        assert outer["ran"] is False and "Another window" in outer["why"]         # the database refused the stale look
        assert fake.sent == [{"profile_id": 4242, "stock_id": 1, "side": "BUY", "qty": 10, "price": comi}]
        assert c.post("/api/v1/real-orders/auto/tick", headers=ho).json()["sent"] == [] and len(fake.sent) == 1

        # the fill is counted into the automation's book once, whichever server sees it
        fake.book[-1].update(status="Executed", executed_qty=10, average=comi)
        real_orders.reset()
        first, second = server(), server()
        books = [real_auto._book(s) for s in (first, second)]
        seen = [real_orders._records(s, real_orders.cairo_now()) for s in (first, second)]
        for s, rows in zip((first, second), seen, strict=True):
            real_orders._sync(s, rows, real_orders.cairo_now())
        real_auto._apply_fills(first, seen[0], books[0], "2026-11-15")
        with pytest.raises((real_auto._Busy, ConflictError)):
            real_auto._apply_fills(second, seen[1], books[1], "2026-11-15")
        view = c.get("/api/v1/real-orders/auto", headers=ho).json()
        assert [(p["symbol"], p["qty"]) for p in view["positions"]] == [("COMI", 10)]
        assert view["budget"]["used"] == pytest.approx(10 * comi) and view["today"]["buys"] == 1

        # two looks claim the same way out at the same moment: one of them holds it
        first, second = server(), server()
        books = [real_auto._book(s) for s in (first, second)]
        for bk in books:
            bk["positions"]["COMI"]["exit"] = {"at": "2026-11-15T09:00:00+00:00", "order": None}
        real_auto._keep(first, books[0])
        with pytest.raises((real_auto._Busy, ConflictError)):
            real_auto._keep(second, books[1])

        # A stop pressed on another server while this one is checking an order wins: the order is tied to the
        # switches it was read under, and the database refuses it once one of them has changed.
        two = suggest(symbol="TMGH", price=Decimal(str(tmgh)), stop_price=Decimal(str(round(tmgh * 0.95, 2))), qty=5)
        inner.clear()

        def stopped_meanwhile(stock_id):
            if not inner:
                inner["started"] = True
                inner["res"] = real_auto.stop(server())
            return asked(stock_id)
        fake.buying_power = stopped_meanwhile
        outer = c.post("/api/v1/real-orders/auto/tick", headers=ho).json()
        fake.buying_power = asked
        assert inner["res"]["on"] is False and outer["ran"] is False and len(fake.sent) == 1     # nothing went out after the stop
        after = c.get("/api/v1/real-orders", headers=ho).json()
        assert [w["id"] for w in after["waiting"]] == [two["id"]]                                # it still waits, untouched
        assert c.get("/api/v1/real-orders/auto", headers=ho).json()["on"] is False               # and the stop stands, on every server
        assert real_auto._tick(server(), {"sent": [], "exits": [], "notes": []})["ran"] is False and len(fake.sent) == 1
        assert not [e for e in c.get("/api/v1/audit", headers=ha).json() if e["entity"].startswith("real_")]
    Feed.reset()
    broker.reset()
    real_orders.reset()


def test_the_timer_signs_in_as_the_owner_with_their_sealed_key_and_looks_for_them(monkeypatch):
    """Background running against the real rules: a real sign-in from the auth emulator, sealed, placed on the server, used by the timer."""
    from datetime import datetime

    from app import background, broker, real_auto, real_orders
    from app.config import Settings
    from app.data.calendar import CAIRO
    from app.data.feed import Feed
    from app.main import create_app
    from tests.test_broker import FakeBroker
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", HOST)
    monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", AUTH_HOST)
    for module in (real_orders, real_auto, background):
        monkeypatch.setattr(module, "cairo_now", lambda: datetime(2026, 11, 15, 11, 0, tzinfo=CAIRO))   # a Sunday, mid-session
    for module in (Feed, broker, real_orders, background):
        module.reset()

    def new_person():
        res = httpx.post(f"{IDP}/accounts:signUp", params={"key": "fake-api-key"},
                         json={"email": f"p-{uuid.uuid4().hex[:10]}@example.com", "password": "long-enough-1", "returnSecureToken": True})
        assert res.status_code == 200, res.text
        provision(res.json()["localId"])
        return res.json()["localId"], {"Authorization": f"Bearer {res.json()['idToken']}"}, res.json()["refreshToken"]
    owner, ho, owners_renewal = new_person()
    _, ha, others_renewal = new_person()
    timer = {"Authorization": "Bearer the-platforms-secret"}
    fake = FakeBroker()
    fake.listing = [s for s in fake.listing if s["symbol"] != "EAST"]   # market data is shared: leave it as the other tests expect it
    cfg = Settings(store_backend="firestore", firebase_project_id=PROJECT, firebase_web_api_key="fake-api-key", broker_account_uids=owner,
                   live_trading_enabled=True, cron_secret="the-platforms-secret", background_secret="only-this-server-knows")

    with TestClient(create_app(cfg, younit=fake)) as c:
        while c.post("/api/v1/data/refresh", headers=ho).json()["remaining"]:
            pass
        assert c.get("/api/v1/background/look").status_code == 401                               # not the timer
        assert c.get("/api/v1/background/look", headers=timer).json() == {"ran": False, "why": "no background key on the server"}
        for method, path, body in (("get", "/api/v1/background", None), ("put", "/api/v1/background", {"enabled": True}),
                                   ("post", "/api/v1/background/key", {"refresh_token": others_renewal})):
            assert c.request(method, path, json=body, headers=ha).status_code == 403, path       # another administrator is not the owner
            assert c.request(method, path, json=body).status_code == 401, path
        # a key is made from the owner's own sign-in, and from nobody else's
        res = c.post("/api/v1/background/key", json={"refresh_token": others_renewal}, headers=ho)
        assert res.status_code == 422 and "not this account's" in res.json()["detail"]
        made = c.post("/api/v1/background/key", json={"refresh_token": owners_renewal}, headers=ho).json()
        assert made["key"].startswith("bk1.") and owners_renewal not in made["key"] and made["server_key"] == "none"
        res = c.put("/api/v1/background", json={"enabled": True}, headers=ho)
        assert res.status_code == 422 and "no background key on the server" in res.json()["detail"]

    # the owner placed the key in the server's environment and redeployed
    with TestClient(create_app(cfg.model_copy(update={"background_key": made["key"]}), younit=fake)) as c:
        assert c.get("/api/v1/background/look", headers=timer).json() == {"ran": False, "why": "background running is switched off"}
        on = c.put("/api/v1/background", json={"enabled": True}, headers=ho).json()
        assert on["enabled"] is True and on["server_key"] == "ok"
        assert c.get("/api/v1/status", headers=ho).json()["real_orders"]["background"] is False   # real orders themselves are still off
        out = c.get("/api/v1/background/look", headers=timer).json()
        assert out["ran"] is True and out["auto"]["ran"] is False and "switched off" in out["auto"]["why"]
        seen = c.get("/api/v1/background", headers=ho).json()                                     # the look left word in the owner's own data
        assert seen["beat"]["at"] and seen["beat"]["why"] == out["auto"]["why"] and seen["silent"] is False
        assert [e["action"] for e in c.get("/api/v1/audit", headers=ho).json() if e["entity"] == "background"] == ["switch", "key"]
        assert not [e for e in c.get("/api/v1/audit", headers=ha).json() if e["entity"] == "background"]

        # a new key retires the one on the server, at once
        c.post("/api/v1/background/key", json={"refresh_token": owners_renewal}, headers=ho)
        assert c.get("/api/v1/background", headers=ho).json()["server_key"] == "replaced"
        assert c.get("/api/v1/background/look", headers=timer).json() == {"ran": False, "why": "background running is switched off"}
        res = c.put("/api/v1/background", json={"enabled": True}, headers=ho)
        assert res.status_code == 422 and "older one" in res.json()["detail"]
    for module in (Feed, broker, real_orders, background):
        module.reset()
