"""The API on Postgres, end to end: sign-in, accounts, isolation, the timer.

Skipped when TEST_DATABASE_URL is not set (see test_postgres.py).
"""
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from tests.test_identity import PROJECT, open_account, sign, verifier

URL = os.environ.get("TEST_DATABASE_URL", "")
needs_db = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")


# ---- with a database -----------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def db():
    from app.store.postgres_store import Database
    database = Database(URL)
    database.ensure_schema()
    yield database
    database.close()


def pg_api(db, younit=None, **more):
    from app.config import Settings
    from app.main import create_app
    settings = Settings(store_backend="postgres", firebase_project_id=PROJECT, database_url="postgresql://not-used",
                        firebase_web_api_key="web-key", **more)
    return TestClient(create_app(settings, younit=younit, database=db, verifier=verifier()))


def headers(uid: str) -> dict:
    return {"Authorization": f"Bearer {sign(uid)}"}


def new_uid() -> str:
    return "m-" + uuid.uuid4().hex[:12]


def account(db, **how) -> str:
    """An account an administrator has opened."""
    uid = new_uid()
    open_account(db, uid, **how)
    return uid


@needs_db
def test_sign_in_is_checked_by_the_server_before_anything_is_read(db):
    uid, closed, stranger = account(db), account(db, active=False), new_uid()
    api = pg_api(db)
    assert api.get("/api/v1/status").status_code == 401
    assert api.get("/api/v1/status", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    head, body, _ = sign(uid).split(".")
    assert api.get("/api/v1/status", headers={"Authorization": f"Bearer {head}.{body}."}).status_code == 401   # unsigned
    for nobody in (closed, stranger):                     # a genuine sign-in is not enough: the account must be open
        assert api.get("/api/v1/portfolio", headers=headers(nobody)).status_code == 401
        assert db.one("select 1 from egx.docs where uid=%s limit 1", (nobody,)) is None       # nothing was made for it
    assert db.one("select 1 from egx.accounts where uid=%s", (stranger,)) is None
    assert api.get("/api/v1/portfolio", headers=headers(uid)).json()["summary"]["cash"] == 50000
    assert api.get("/health").status_code == 200
    assert api.get("/health", params={"probe": "true"}).json()["database_ms"]["first"] >= 0


@needs_db
def test_full_flow_persists_per_user(db):
    api, uid, other = pg_api(db), account(db), account(db)
    h, ho = headers(uid), headers(other)
    s = api.get("/api/v1/status", headers=h).json()
    assert s["storage"] == "postgres" and s["data"]["mode"] == "sample"
    assert api.put("/api/v1/watchlist/COMI", headers=h).status_code == 200
    body = {"side": "BUY", "symbol": "COMI", "qty": 10, "client_order_id": "x1", "note": "first"}
    first = api.post("/api/v1/trades", json=body, headers=h)
    assert first.status_code == 201, first.text
    assert api.post("/api/v1/trades", json=body, headers=h).json()["seq"] == first.json()["seq"]
    assert api.post("/api/v1/trades", json={"side": "SELL", "symbol": "COMI", "qty": 4}, headers=h).status_code == 201
    assert api.post("/api/v1/trades", json={"side": "SELL", "symbol": "COMI", "qty": 99}, headers=h).status_code == 422
    pf = api.get("/api/v1/portfolio", headers=h).json()
    assert pf["holdings"][0]["qty"] == 6
    assert [r["type"] for r in api.get("/api/v1/trades", headers=h).json()["transactions"]] == ["SELL", "BUY", "DEPOSIT"]
    st = api.post("/api/v1/strategies", json={"name": "Trend", "type": "sma_cross", "sectors": ["Banks"]}, headers=h).json()
    bt = api.post("/api/v1/backtests", json={"strategy_id": st["id"]}, headers=h)
    assert bt.status_code == 201, bt.text
    audit = api.get("/api/v1/audit", params={"limit": 3}, headers=h).json()
    assert len(audit) == 3 and audit[0]["entity"] == "backtest" and audit[0]["seq"] > audit[1]["seq"]
    # a second account sees none of it, and a new server sees all of it
    assert api.get("/api/v1/portfolio", headers=ho).json()["holdings"] == []
    assert api.get("/api/v1/watchlist", headers=ho).json() == []
    again = pg_api(db)
    assert again.get("/api/v1/portfolio", headers=h).json()["holdings"][0]["qty"] == 6
    assert [r["symbol"] for r in again.get("/api/v1/watchlist", headers=h).json()] == ["COMI"]


@needs_db
def test_first_load_race_creates_exactly_one_portfolio(db):
    from concurrent.futures import ThreadPoolExecutor
    api, uid = pg_api(db), account(db)
    with ThreadPoolExecutor(8) as pool:
        codes = list(pool.map(lambda _: api.get("/api/v1/portfolio", headers=headers(uid)).status_code, range(8)))
    assert codes == [200] * 8
    assert db.one("select count(*) from egx.docs where uid=%s and coll='portfolios'", (uid,))[0] == 1
    assert db.one("select count(*) from egx.docs where uid=%s and coll like 'ledger_%%'", (uid,))[0] == 1


@needs_db
def test_the_timer_signs_in_as_the_owner_and_the_server_checks_that_sign_in_too(db, monkeypatch):
    """Running without a browser on Postgres: the owner's sealed key renews their sign-in, and the server verifies it
    like any other before it reads anything of theirs."""
    from datetime import datetime

    from app import background, broker, real_auto, real_orders
    from app.config import Settings
    from app.data.calendar import CAIRO
    from app.data.feed import Feed
    from app.main import create_app
    from tests.test_broker import FakeBroker
    for module in (real_orders, real_auto, background):
        monkeypatch.setattr(module, "cairo_now", lambda: datetime(2026, 11, 15, 11, 0, tzinfo=CAIRO))   # a Sunday, mid-session
    for module in (Feed, broker, real_orders, background):
        module.reset()
    db.run(lambda conn: conn.execute("delete from egx.market"))
    owner, other = account(db), account(db)
    # The sign-in service, for this test: a renewal token is good for one account's sign-in.
    renewals = {"owners-renewal-token-0001": owner, "others-renewal-token-0002": other}
    signed_as = {}

    def exchange(settings, refresh_token):
        uid = renewals[refresh_token]
        return {"id_token": sign(signed_as.get(uid, uid)), "user_id": uid, "expires_in": 3600}
    monkeypatch.setattr(background, "_exchange", exchange)
    timer = {"Authorization": "Bearer the-platforms-secret"}
    cfg = Settings(store_backend="postgres", firebase_project_id=PROJECT, database_url="postgresql://not-used",
                   broker_account_uids=owner, live_trading_enabled=True, cron_secret="the-platforms-secret",
                   background_secret="only-this-server-knows")

    def server(**more):
        return TestClient(create_app(cfg.model_copy(update=more), younit=FakeBroker(), database=db, verifier=verifier()))
    ho, ha = headers(owner), headers(other)
    with server() as c:
        while c.post("/api/v1/data/refresh", headers=ho).json()["remaining"]:
            pass
        assert c.get("/api/v1/background/look").status_code == 401                               # not the timer
        assert c.get("/api/v1/background/look", headers=timer).json() == {"ran": False, "why": "no background key on the server"}
        res = c.post("/api/v1/background/key", json={"refresh_token": "others-renewal-token-0002"}, headers=ha)
        assert res.status_code == 403, res.text
        res = c.post("/api/v1/background/key", json={"refresh_token": "others-renewal-token-0002"}, headers=ho)
        assert res.status_code == 422 and "not this account's" in res.json()["detail"]
        made = c.post("/api/v1/background/key", json={"refresh_token": "owners-renewal-token-0001"}, headers=ho).json()
        assert made["key"].startswith("bk1.") and "owners-renewal-token-0001" not in made["key"]
    with server(background_key=made["key"]) as c:
        assert c.get("/api/v1/background/look", headers=timer).json() == {"ran": False, "why": "background running is switched off"}
        assert c.put("/api/v1/background", json={"enabled": True}, headers=ho).json()["enabled"] is True
        out = c.get("/api/v1/background/look", headers=timer).json()
        assert out["ran"] is True and out["auto"]["ran"] is False and "switched off" in out["auto"]["why"]
        seen = c.get("/api/v1/background", headers=ho).json()                                     # the look left word in the owner's own data
        assert seen["beat"]["at"] and seen["beat"]["why"] == out["auto"]["why"]
        assert not [e for e in c.get("/api/v1/audit", headers=ha).json() if e["entity"] == "background"]
        # A sign-in that comes back for somebody else is not used, whatever the key says: the server's own check decides.
        background.reset()
        signed_as[owner] = other
        assert c.get("/api/v1/background/look", headers=timer).status_code == 401
    for module in (Feed, broker, real_orders, background):
        module.reset()
    db.run(lambda conn: conn.execute("delete from egx.market"))


@needs_db
def test_accounts_are_opened_and_closed_in_the_database_by_an_administrator_only(db, monkeypatch):
    import httpx

    import app.accounts as accounts
    admin, plain = account(db, admin=True), account(db)
    made, removed = [], []

    def sign_in_service(url, params=None, json=None, **kw):
        if url.endswith("accounts:signUp"):
            if json["email"] == "taken@example.com":
                return httpx.Response(400, json={"error": {"message": "EMAIL_EXISTS"}})
            uid = "n-" + uuid.uuid4().hex[:10]
            made.append(uid)
            return httpx.Response(200, json={"localId": uid, "idToken": "token-of-" + uid})
        removed.append(json["idToken"])
        return httpx.Response(200, json={})
    monkeypatch.setattr(accounts._client, "post", sign_in_service)
    api = pg_api(db)
    ha, hp = headers(admin), headers(plain)
    assert api.get("/api/v1/accounts", headers=hp).json() == {"can_manage": False, "accounts": []}
    body = {"email": "New.Person@Example.com", "password": "long-enough-1", "name": "New Person"}
    assert api.post("/api/v1/accounts", json=body, headers=hp).status_code == 401 and made == []     # not an administrator: nothing is made
    assert api.put(f"/api/v1/accounts/{admin}", json={"active": False}, headers=hp).status_code == 401
    assert api.post("/api/v1/accounts", json={**body, "email": "taken@example.com"}, headers=ha).status_code == 422
    created = api.post("/api/v1/accounts", json=body, headers=ha)
    assert created.status_code == 201, created.text
    new = created.json()["uid"]
    assert new == made[-1] and created.json()["email"] == "new.person@example.com" and removed == []
    listed = api.get("/api/v1/accounts", headers=ha).json()
    assert listed["can_manage"] is True and {a["uid"] for a in listed["accounts"]} >= {admin, plain, new}
    assert next(a for a in listed["accounts"] if a["uid"] == new)["name"] == "New Person"
    # the new account works at once, on any server
    hn = headers(new)
    assert pg_api(db).get("/api/v1/portfolio", headers=hn).json()["summary"]["cash"] == 50000
    # closing it locks it out on the server where it was closed at once, and nobody can close their own
    assert api.get("/api/v1/portfolio", headers=hn).status_code == 200
    assert api.put(f"/api/v1/accounts/{admin}", json={"active": False}, headers=ha).status_code == 422
    assert api.put("/api/v1/accounts/nobody-at-all", json={"active": False}, headers=ha).status_code == 422
    assert api.put(f"/api/v1/accounts/{new}", json={"active": False}, headers=ha).json() == {"uid": new, "active": False}
    assert api.get("/api/v1/portfolio", headers=hn).status_code == 401
    assert api.put(f"/api/v1/accounts/{new}", json={"active": True}, headers=ha).status_code == 200
    assert api.get("/api/v1/portfolio", headers=hn).status_code == 200
    assert [e["action"] for e in api.get("/api/v1/audit", headers=ha).json() if e["entity"] == "account"] == ["activate", "deactivate", "create"]
