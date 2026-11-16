"""Bringing an account over from Firestore, and the API on Postgres end to end.

The part that needs a database is skipped when TEST_DATABASE_URL is not set (see test_postgres.py).
"""
import json
import os
import re
import uuid
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.store import migrate
from tests.test_identity import PROJECT, sign, verifier

URL = os.environ.get("TEST_DATABASE_URL", "")
needs_db = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")
APP = Path(__file__).resolve().parent.parent / "app"


def test_every_collection_the_application_uses_is_one_the_copy_knows():
    """Firestore cannot be asked which collections an account has. A collection missing here would be left behind."""
    used = set()
    for path in APP.rglob("*.py"):
        text = path.read_text()
        used |= set(re.findall(r"""store\.(?:get|put|create|delete|list|append|recent|rows)\(\s*f?"([a-zA-Z_{}]+)""", text))
        used |= set(re.findall(r"""_(?:save|delete)\(\s*"([a-z_]+)\"""", text))
        used |= set(re.findall(r"""^[A-Z_]+ = \("([a-z_]+)", "[a-z_]+"\)\s*(?:#.*)?$""", text, re.M)) & {"settings"}
        used |= set(re.findall(r"""^SUBS = "([a-z_]+)\"""", text, re.M))
        for group in re.findall(r"lists=\[([^\]]*)\]", text):
            used |= set(re.findall(r'"([a-z_]+)"', group))
        used |= set(re.findall(r"""return f"([a-z_]+_)\{""", text))           # names made up as they are needed
    used -= {"egxMarket", "chunk_"}                                             # shared by all accounts: brought over apart
    families = {migrate.LEDGER, migrate.REAL_ORDERS}
    plain = {name for name in used if "{" not in name and name not in families}
    made_up = {name.split("{")[0] for name in used if "{" in name} | (used & families)
    assert plain == set(migrate.FIXED), plain ^ set(migrate.FIXED)
    assert made_up == families, made_up ^ families
    assert len(plain) > 15                                                      # the search itself still finds them


def test_the_months_a_real_order_can_be_filed_under():
    assert migrate.months(date(2026, 1, 15)) == ["202601", "202602"]
    assert migrate.months(date(2026, 11, 16))[-3:] == ["202610", "202611", "202612"]
    assert migrate.months(date(2026, 12, 31))[-2:] == ["202612", "202701"]
    assert len(migrate.months(date(2027, 3, 1))) == 16


# ---- with a database -----------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def db():
    from app.store.postgres_store import Database
    database = Database(URL)
    database.ensure_schema()
    yield database
    database.close()


class OldData:
    """Stands in for an account's data in Firestore: read through the two calls the copy makes, and never written."""

    def __init__(self, docs: dict[str, dict[str, dict]] | None = None, fail: Exception | None = None):
        self.docs, self.fail, self.reads = docs or {}, fail, 0

    @classmethod
    def of(cls, store):
        docs: dict[str, dict[str, dict]] = {}
        for coll, id, body in store._conn.execute("select coll, id, body from docs").fetchall():
            docs.setdefault(coll, {})[id] = json.loads(body)
        return cls(docs)

    def warm(self, gets=(), lists=()):
        if self.fail:
            raise self.fail

    def rows(self, coll):
        self.reads += 1
        return sorted(self.docs.get(coll, {}).items())


def pg_api(db, old: dict[str, OldData] | None = None, allowed=lambda uid, token: True, younit=None, market=None):
    from app.config import Settings
    from app.main import create_app
    settings = Settings(store_backend="postgres", firebase_project_id=PROJECT, database_url="postgresql://not-used",
                        migrate_from_firestore=old is not None)
    return TestClient(create_app(settings, younit=younit, database=db, verifier=verifier(), account_ask=allowed,
                                 firestore_source=lambda uid: (old or {}).get(uid, OldData()),
                                 market_source=(lambda: market) if market is not None else None))


def headers(uid: str) -> dict:
    return {"Authorization": f"Bearer {sign(uid)}"}


def new_uid() -> str:
    return "m-" + uuid.uuid4().hex[:12]


@needs_db
def test_sign_in_is_checked_by_the_server_before_anything_is_read(db):
    uid, closed = new_uid(), new_uid()
    api = pg_api(db, allowed=lambda u, token: u != closed)
    assert api.get("/api/v1/status").status_code == 401
    assert api.get("/api/v1/status", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    head, body, _ = sign(uid).split(".")
    assert api.get("/api/v1/status", headers={"Authorization": f"Bearer {head}.{body}."}).status_code == 401   # unsigned
    assert api.get("/api/v1/portfolio", headers=headers(closed)).status_code == 401
    assert db.one("select 1 from egx.docs where uid=%s limit 1", (closed,)) is None       # nothing was made for it
    assert api.get("/api/v1/portfolio", headers=headers(uid)).json()["summary"]["cash"] == 50000
    assert api.get("/health").status_code == 200
    assert api.get("/health", params={"probe": "true"}).json()["database_ms"]["first"] >= 0


@needs_db
def test_full_flow_persists_per_user(db):
    api, uid, other = pg_api(db), new_uid(), new_uid()
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
    api, uid = pg_api(db), new_uid()
    with ThreadPoolExecutor(8) as pool:
        codes = list(pool.map(lambda _: api.get("/api/v1/portfolio", headers=headers(uid)).status_code, range(8)))
    assert codes == [200] * 8
    assert db.one("select count(*) from egx.docs where uid=%s and coll='portfolios'", (uid,))[0] == 1
    assert db.one("select count(*) from egx.docs where uid=%s and coll like 'ledger_%%'", (uid,))[0] == 1


@needs_db
def test_an_account_is_brought_over_whole_and_reads_the_same_afterwards(db, tmp_path):
    from app.config import Settings
    from app.main import create_app
    from app.store.sqlite_store import Store
    # An account with a history, made through the application itself on the local store.
    before_store = Store(tmp_path / "old.sqlite3")
    old = TestClient(create_app(Settings(data_dir=tmp_path), before_store))
    old.put("/api/v1/watchlist/COMI")
    for trade in ({"side": "BUY", "symbol": "COMI", "qty": 10, "client_order_id": "x1"}, {"side": "BUY", "symbol": "TMGH", "qty": 5},
                  {"side": "SELL", "symbol": "COMI", "qty": 4}):
        assert old.post("/api/v1/trades", json=trade).status_code == 201
    strategy = old.post("/api/v1/strategies", json={"name": "Trend", "type": "sma_cross", "sectors": ["Banks"]}).json()
    assert old.post("/api/v1/backtests", json={"strategy_id": strategy["id"]}).status_code == 201
    assert old.post("/api/v1/categories", json={"name": "My picks", "symbols": ["COMI"]}).status_code in (200, 201)
    assert old.post("/api/v1/journal", json={"symbol": "COMI", "thesis": "ملاحظة: اختراق بحجم"}).status_code in (200, 201)
    source = OldData.of(before_store)
    kept = {coll for coll in source.docs if coll != "egxMarket"}
    assert len(kept) >= 9 and any(c.startswith("ledger_") for c in kept)

    uid = new_uid()
    api = pg_api(db, {uid: source})
    h = headers(uid)
    paths = ["/api/v1/portfolio", "/api/v1/trades", "/api/v1/watchlist", "/api/v1/strategies", "/api/v1/backtests",
             "/api/v1/categories", "/api/v1/journal", "/api/v1/audit?limit=50", "/api/v1/settings/fees"]
    want = {p: old.get(p).json() for p in paths}
    got = {p: api.get(p, headers=h).json() for p in paths}
    assert got == want
    # every collection the account had came over, document for document
    report = json.loads(db.one("select migration from egx.accounts where uid=%s and migrated_at is not null", (uid,))[0])
    assert set(report["collections"]) == kept
    assert report["documents"] == sum(len(source.docs[c]) for c in kept)
    assert report["documents"] == db.one("select count(*) from egx.docs where uid=%s", (uid,))[0]
    # the ledger continues where it stopped, and the old data is never read again or written to
    reads = source.reads
    assert api.post("/api/v1/trades", json={"side": "SELL", "symbol": "TMGH", "qty": 5}, headers=h).status_code == 201
    seqs = [r["seq"] for r in api.get("/api/v1/trades", headers=h).json()["transactions"]]
    assert seqs == sorted(seqs, reverse=True) and len(seqs) == len(want["/api/v1/trades"]["transactions"]) + 1
    assert pg_api(db, {uid: OldData(fail=RuntimeError("must not be asked"))}).get("/api/v1/portfolio", headers=h).status_code == 200
    assert source.reads == reads and OldData.of(before_store).docs == source.docs


@needs_db
def test_when_the_old_database_does_not_answer_nothing_is_made_in_its_place(db, tmp_path):
    uid = new_uid()
    down = pg_api(db, {uid: OldData(fail=RuntimeError("database read failed (429)"))})
    res = down.get("/api/v1/portfolio", headers=headers(uid))
    assert res.status_code == 503 and "try again" in res.json()["detail"]
    # no empty account was created over the person's real one: the next try, with the old database back, brings it over
    assert db.one("select 1 from egx.docs where uid=%s limit 1", (uid,)) is None
    assert db.one("select migrated_at from egx.accounts where uid=%s", (uid,))[0] is None
    from app.config import Settings
    from app.main import create_app
    from app.store.sqlite_store import Store
    theirs = Store(tmp_path / "old.sqlite3")
    made = TestClient(create_app(Settings(data_dir=tmp_path, initial_capital_egp=70000), theirs))
    assert made.post("/api/v1/trades", json={"side": "BUY", "symbol": "COMI", "qty": 3}).status_code == 201
    back = pg_api(db, {uid: OldData.of(theirs)})
    pf = back.get("/api/v1/portfolio", headers=headers(uid)).json()
    assert pf["summary"]["starting_capital"] == 70000 and pf["holdings"][0]["qty"] == 3


@needs_db
def test_data_already_in_the_new_database_is_never_written_over(db):
    from app.store.postgres_store import PostgresStore
    uid = new_uid()
    PostgresStore(db, uid).put("settings", "app", {"mine": True})
    with pytest.raises(migrate.MigrationError):
        migrate.bring_account(db, uid, lambda: OldData({"settings": {"app": {"theirs": True}}}), date(2026, 11, 16))
    assert PostgresStore(db, uid).get("settings", "app") == {"mine": True}
    res = pg_api(db, {uid: OldData({"settings": {"app": {"theirs": True}}})}).get("/api/v1/portfolio", headers=headers(uid))
    assert res.status_code == 503 and "Nothing was lost" in res.json()["detail"]


@needs_db
def test_two_servers_bringing_one_account_over_at_once_make_one_copy(db):
    from concurrent.futures import ThreadPoolExecutor
    uid = new_uid()
    docs = {"settings": {"app": {"a": 1}}, "audit": {f"{n:012d}": {"seq": n, "what": "x"} for n in range(1, 900)},
            "portfolios": {"p1": {"id": "p1"}}, "ledger_p1": {f"{1:012d}": {"seq": 1, "type": "DEPOSIT", "amount": "50000"}},
            "real_orders_202611": {"20261116-ab": {"id": "20261116-ab"}}}

    def one(_):
        migrate._done.discard(uid)                       # each call as if on a server that has not seen the account
        return migrate.bring_account(db, uid, lambda: OldData(docs), date(2026, 11, 16))
    with ThreadPoolExecutor(4) as pool:
        reports = list(pool.map(one, range(4)))
    assert sum(r is not None for r in reports) == 1
    assert db.one("select count(*) from egx.docs where uid=%s", (uid,))[0] == 1 + 899 + 1 + 1 + 1
    assert db.one("select seq from egx.docs where uid=%s and coll='audit' order by seq desc limit 1", (uid,))[0] == 899


@needs_db
def test_the_shared_market_data_comes_over_once(db):
    from app.store.postgres_store import PostgresDocs
    db.run(lambda conn: conn.execute("delete from egx.market"))
    migrate._done.discard("market")

    class OldMarket:
        def __init__(self, docs):
            self.docs = docs

        def get(self, id):
            return self.docs.get(id)
    old = OldMarket({"meta": {"version": 3}, "index": {"version": 3, "instruments": []}, "chunk_07": {"bars": {"COMI": [[1, 2]]}}})
    assert migrate.bring_market(db, old) == 3
    assert PostgresDocs(db).get("chunk_07") == {"bars": {"COMI": [[1, 2]]}} and PostgresDocs(db).get("live") is None
    migrate._done.discard("market")
    assert migrate.bring_market(db, OldMarket({"meta": {"version": 99}})) == 0       # there is market data now: left alone
    assert PostgresDocs(db).get("meta") == {"version": 3}
    db.run(lambda conn: conn.execute("delete from egx.market"))
    migrate._done.discard("market")


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
    owner, other = new_uid(), new_uid()
    # The sign-in service, for this test: a renewal token is good for one account's sign-in.
    renewals = {"owners-renewal-token-0001": owner, "others-renewal-token-0002": other}
    signed_as = {}

    def exchange(settings, refresh_token):
        uid = renewals[refresh_token]
        return {"id_token": sign(signed_as.get(uid, uid)), "user_id": uid, "expires_in": 3600}
    monkeypatch.setattr(background, "_exchange", exchange)
    timer = {"Authorization": "Bearer the-platforms-secret"}
    cfg = Settings(store_backend="postgres", firebase_project_id=PROJECT, database_url="postgresql://not-used", migrate_from_firestore=False,
                   broker_account_uids=owner, live_trading_enabled=True, cron_secret="the-platforms-secret",
                   background_secret="only-this-server-knows")

    def server(**more):
        return TestClient(create_app(cfg.model_copy(update=more), younit=FakeBroker(), database=db, verifier=verifier(),
                                     account_ask=lambda uid, token: True))
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
