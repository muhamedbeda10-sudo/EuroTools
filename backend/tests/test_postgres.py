"""The Postgres store, exercised against a real Postgres.

    TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/egxtest pytest tests/test_postgres.py

Skipped when TEST_DATABASE_URL is not set. Each test works in accounts with names of its own, so the
database can be shared and nothing needs to be emptied.
"""
import os
import threading
import uuid

import pytest

URL = os.environ.get("TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")


@pytest.fixture(scope="module")
def db():
    from app.store.postgres_store import Database
    database = Database(URL)
    database.ensure_schema()
    yield database
    database.close()


@pytest.fixture()
def uid():
    return "u-" + uuid.uuid4().hex[:12]


def store(db, uid):
    from app.store.postgres_store import PostgresStore
    return PostgresStore(db, uid)


def test_documents_are_one_accounts_own(db, uid):
    mine, other = store(db, uid), store(db, uid + "-other")
    mine.put("settings", "app", {"a": 1})
    mine.put("watchlist", "COMI", {"symbol": "COMI"})
    assert store(db, uid).get("settings", "app") == {"a": 1}
    assert other.get("settings", "app") is None and other.list("watchlist") == []
    other.put("settings", "app", {"a": 2})
    assert store(db, uid).get("settings", "app") == {"a": 1}
    assert mine.delete("watchlist", "COMI") is True and mine.delete("watchlist", "COMI") is False
    assert store(db, uid).list("watchlist") == []


def test_lists_are_in_id_order_and_what_is_read_is_a_copy(db, uid):
    s = store(db, uid)
    for id in ("b", "a", "c"):
        s.put("strategies", id, {"id": id})
    fresh = store(db, uid)
    rows = fresh.list("strategies")
    assert [r["id"] for r in rows] == ["a", "b", "c"]
    rows[0]["id"] = "changed"
    assert fresh.list("strategies")[0]["id"] == "a"
    got = fresh.get("strategies", "a")
    got["id"] = "changed"
    assert fresh.get("strategies", "a") == {"id": "a"}


def test_append_numbers_entries_and_recent_reads_the_newest(db, uid):
    s = store(db, uid)
    first = s.append("audit", {"what": "one"})
    second = s.append("audit", {"what": "two"})
    assert (first["seq"], second["seq"]) == (1, 2)
    other = store(db, uid)                      # a new request continues the numbering without reading the log
    assert other.append("audit", {"what": "three"})["seq"] == 3
    assert [d["what"] for d in store(db, uid).recent("audit", 2)] == ["three", "two"]
    assert [d["seq"] for d in store(db, uid).list("audit")] == [1, 2, 3]


def test_append_conflict_is_reported_not_overwritten(db, uid):
    from app.store.errors import ConflictError
    a, b = store(db, uid), store(db, uid)
    a.list("audit"), b.list("audit")             # both have read the log as empty
    a.append("audit", {"who": "a"})
    with pytest.raises(ConflictError):
        b.append("audit", {"who": "b"})
    assert [d["who"] for d in store(db, uid).list("audit")] == ["a"]


def test_the_ledger_and_the_audit_trail_cannot_be_changed_or_removed(db, uid):
    s = store(db, uid)
    s.append("ledger_p1", {"type": "DEPOSIT", "amount": "50000"})
    s.append("audit", {"what": "made"})
    for coll in ("ledger_p1", "audit"):
        with pytest.raises(RuntimeError, match="cannot be changed"):
            store(db, uid).put(coll, f"{1:012d}", {"type": "DEPOSIT", "amount": "1", "seq": 1})
        tamper = store(db, uid)
        with pytest.raises(RuntimeError, match="cannot be changed"):
            tamper.delete(coll, f"{1:012d}")
        with pytest.raises(Exception, match="cannot be changed"):     # not through the store either
            db.run(lambda conn, coll=coll: conn.execute("delete from egx.docs where uid=%s and coll=%s", (uid, coll)))
    assert store(db, uid).list("ledger_p1") == [{"type": "DEPOSIT", "amount": "50000", "seq": 1}]
    store(db, uid).put("ledgers", "x", {"n": 1})     # a name that only looks like it is an ordinary collection
    store(db, uid).put("ledgers", "x", {"n": 2})


def test_failed_transaction_writes_nothing(db, uid):
    s = store(db, uid)
    with pytest.raises(ZeroDivisionError):
        with s.transaction():
            s.put("orders", "o1", {"id": "o1"})
            s.append("ledger_p1", {"type": "BUY"})
            raise ZeroDivisionError
    assert store(db, uid).get("orders", "o1") is None and store(db, uid).list("ledger_p1") == []
    # and a commit that is refused half way through leaves nothing behind
    from app.store.errors import ConflictError
    store(db, uid).put("orders", "taken", {"v": 1})
    t = store(db, uid)
    with pytest.raises(ConflictError):
        with t.transaction():
            t.put("orders", "o2", {"id": "o2"})
            t.create("orders", "taken", {"v": 2})
    assert store(db, uid).get("orders", "o2") is None and store(db, uid).get("orders", "taken") == {"v": 1}


def test_a_stale_overwrite_is_refused_instead_of_silently_winning(db, uid):
    from app.store.errors import ConflictError
    store(db, uid).put("paper_runs", "r1", {"status": "running", "cash": 100})
    browser, timer = store(db, uid), store(db, uid)
    run_b, run_t = browser.get("paper_runs", "r1"), timer.get("paper_runs", "r1")
    timer.put("paper_runs", "r1", {**run_t, "cash": 60})
    with pytest.raises(ConflictError):
        browser.put("paper_runs", "r1", {**run_b, "status": "paused"})
    assert store(db, uid).get("paper_runs", "r1") == {"status": "running", "cash": 60}
    # the same for a removal, and for a document that appeared after it was read as absent
    stale = store(db, uid)
    stale.get("paper_runs", "r1")
    store(db, uid).put("paper_runs", "r1", {"status": "running", "cash": 10})
    with pytest.raises(ConflictError):
        stale.delete("paper_runs", "r1")
    absent = store(db, uid)
    assert absent.get("paper_runs", "r2") is None
    store(db, uid).put("paper_runs", "r2", {"status": "new"})
    with pytest.raises(ConflictError):
        absent.put("paper_runs", "r2", {"status": "mine"})
    assert store(db, uid).get("paper_runs", "r2") == {"status": "new"}


def test_writes_inside_one_request_do_not_trip_over_each_other(db, uid):
    s = store(db, uid)
    s.put("alerts", "a1", {"n": 1})
    s.put("alerts", "a1", {"n": 2})              # the request's own earlier write is not "another window"
    s.get("alerts", "a1")
    s.put("alerts", "a1", {"n": 3})
    with s.transaction():
        s.put("alerts", "a1", {"n": 4})
        s.put("alerts", "a1", {"n": 5})          # two writes to one document in a transaction: the last one goes out
        assert [d["n"] for d in s.list("alerts")] == [5]
        s.put("alerts", "a2", {"n": 9})
        assert sorted(d["n"] for d in s.list("alerts")) == [5, 9]
    assert sorted(d["n"] for d in store(db, uid).list("alerts")) == [5, 9]
    s.delete("alerts", "a1")
    s.put("alerts", "a1", {"n": 6})              # removed and made again in one request
    assert store(db, uid).get("alerts", "a1") == {"n": 6}


def test_create_refuses_a_document_that_is_there_and_two_at_once_make_one(db, uid):
    from app.store.errors import ConflictError
    results = []

    def make(n):
        try:
            store(db, uid).create("portfolios", "main", {"by": n})
            results.append("made")
        except ConflictError:
            results.append("refused")
    threads = [threading.Thread(target=make, args=(n,)) for n in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["made"] + ["refused"] * 5


def test_fresh_gives_a_new_picture_and_warm_reads_in_one_go(db, uid):
    s = store(db, uid)
    s.put("settings", "fees", {"bps": 5})
    s.put("instruments", "COMI", {"symbol": "COMI"})
    s.put("bars", "COMI", {"rows": [1, 2]})
    reader = store(db, uid)
    calls = []
    real = reader.db.all
    reader.db = type("Counting", (), {"all": lambda self, *a: (calls.append(a[0]), real(*a))[1], "one": db.one, "run": db.run})()
    reader.warm(gets=[("settings", "fees"), ("settings", "missing")], lists=["instruments", "bars"])
    assert len(calls) == 1
    assert reader.get("settings", "fees") == {"bps": 5} and reader.get("settings", "missing") is None
    assert reader.list("instruments") == [{"symbol": "COMI"}] and reader.list("bars") == [{"rows": [1, 2]}]
    assert len(calls) == 1                       # all of it came from the one round trip
    store(db, uid).put("settings", "fees", {"bps": 7})
    assert reader.get("settings", "fees") == {"bps": 5}      # one request, one picture
    reader.fresh()
    assert reader.get("settings", "fees") == {"bps": 7}
    reader.warm(gets=[("settings", "fees"), ("settings", "app")])          # only documents, and only collections
    reader.fresh()
    reader.warm(lists=["instruments", "bars"])
    assert reader.get("settings", "app") is None and len(reader.list("bars")) == 1
    reader.put("settings", "missing", {"now": "here"})       # read as absent, still absent: the write goes through
    assert store(db, uid).get("settings", "missing") == {"now": "here"}


def test_text_is_kept_exactly(db, uid):
    doc = {"amount": "50000.0000", "note": "ملاحظة \u0000 \" ' \\ 💹", "n": 1e-07, "big": 12345678901234567890, "nested": {"z": 1, "a": [None, True]}}
    store(db, uid).put("journal", "j1", doc)
    assert store(db, uid).get("journal", "j1") == doc


def test_shared_market_documents_are_version_checked(db):
    from app.store.errors import ConflictError
    from app.store.postgres_store import PostgresDocs
    name = "t-" + uuid.uuid4().hex[:10]
    a, b = PostgresDocs(db), PostgresDocs(db)
    assert a.get(name) is None and b.get(name) is None
    a.put(name, {"bars": {"COMI": [[1, 2]]}}, guard=True)
    with pytest.raises(ConflictError):
        b.put(name, {"bars": {}}, guard=True)                # made by somebody else since it was read as absent
    assert b.get(name) == {"bars": {"COMI": [[1, 2]]}}
    b.put(name, {"bars": {"COMI": [[3, 4]]}}, guard=True)
    with pytest.raises(ConflictError):
        a.put(name, {"bars": {"stale": 1}}, guard=True)      # a wrote from what it had before b's change
    PostgresDocs(db).put(name, {"live": 1})                   # an unguarded write always goes through
    assert PostgresDocs(db).get(name) == {"live": 1}
    big = {"bars": {f"S{i}": [["2026-01-01", 1.5, 2.5, 1.0, 2.0, 1000.0]] * 800 for i in range(12)}}
    PostgresDocs(db).put(name, big)
    assert PostgresDocs(db).get(name) == big
    stored = db.one("select octet_length(body) from egx.market where id=%s", (name,))[0]
    assert stored < 60_000                                    # kept compressed: every server that starts reads all of it


def test_an_unreachable_database_says_so(monkeypatch):
    from app.store.errors import StoreUnavailable
    from app.store.postgres_store import Database, PostgresStore
    dead = Database("postgresql://nobody@127.0.0.1:1/none?connect_timeout=1")
    dead._pool.timeout = 1.5
    try:
        with pytest.raises(StoreUnavailable):
            PostgresStore(dead, "u1").get("settings", "app")
    finally:
        dead.close()


def test_a_document_removed_and_made_again_is_not_the_one_that_was_read(db, uid):
    """A version is never used twice: somebody who read the first document cannot write over the second."""
    from app.store.errors import ConflictError
    store(db, uid).put("watchlist", "COMI", {"n": 1})
    reader = store(db, uid)
    assert reader.get("watchlist", "COMI") == {"n": 1}
    remover = store(db, uid)
    assert remover.delete("watchlist", "COMI") is True
    store(db, uid).put("watchlist", "COMI", {"n": 2})          # made again by somebody else
    with pytest.raises(ConflictError):
        reader.put("watchlist", "COMI", {"n": "stale"})
    assert store(db, uid).get("watchlist", "COMI") == {"n": 2}
    versions = [r[0] for r in db.all("select version from egx.docs where uid=%s", (uid,))]
    assert versions and min(versions) > 2                       # numbers no document has had before, not a count from 1


def test_writing_and_removing_in_one_transaction_does_not_remove_what_somebody_else_made(db, uid):
    from app.store.errors import ConflictError
    mine = store(db, uid)
    assert mine.get("alerts", "a1") is None                     # read as absent
    store(db, uid).put("alerts", "a1", {"theirs": True})        # then made by another request
    with pytest.raises(ConflictError):
        with mine.transaction():
            mine.put("alerts", "a1", {"mine": True})
            mine.delete("alerts", "a1")
    assert store(db, uid).get("alerts", "a1") == {"theirs": True}
    quiet = store(db, uid)                                      # and when nobody did, it is simply nothing
    assert quiet.get("alerts", "a2") is None
    with quiet.transaction():
        quiet.put("alerts", "a2", {"mine": True})
        quiet.delete("alerts", "a2")
    assert store(db, uid).get("alerts", "a2") is None


def test_two_requests_writing_the_same_documents_in_opposite_order_do_not_block_each_other_for_good(db, uid):
    from app.store.errors import ConflictError
    store(db, uid).put("orders", "a", {"n": 0})
    store(db, uid).put("orders", "b", {"n": 0})
    outcomes, barrier = [], threading.Barrier(2)

    def change(first, second, tag):
        s = store(db, uid)
        try:
            barrier.wait(timeout=5)
            with s.transaction():
                s.put("orders", first, {"n": tag})
                s.put("orders", second, {"n": tag})
            outcomes.append("written")
        except ConflictError:
            outcomes.append("conflict")
        except Exception as exc:  # noqa: BLE001 - the point of the test: nothing else may come out
            outcomes.append(type(exc).__name__)
    for _ in range(15):
        threads = [threading.Thread(target=change, args=("a", "b", 1)), threading.Thread(target=change, args=("b", "a", 2))]
        [t.start() for t in threads]
        [t.join(timeout=20) for t in threads]
    assert set(outcomes) <= {"written", "conflict"} and len(outcomes) == 30
    a, b = store(db, uid).get("orders", "a"), store(db, uid).get("orders", "b")
    assert a == b                                               # each transaction went in whole


def test_the_schema_is_brought_up_to_date_once_and_a_server_that_starts_later_finds_it_done(db):
    from app.store import postgres_store
    from app.store.postgres_store import Database
    assert db.one("select value from egx.meta where key='schema'")[0] == postgres_store.SCHEMA_VERSION
    db.one("update egx.meta set value='0' where key='schema' returning key")     # as if written by an older version
    later = Database(URL)
    try:
        later.ensure_schema()
        assert db.one("select value from egx.meta where key='schema'")[0] == postgres_store.SCHEMA_VERSION
        seen = []
        real = later.run
        later.run = lambda work: (seen.append(1), real(work))[1]
        later.ensure_schema()                                    # asked again by the same server: no query at all
        assert seen == []
    finally:
        later.close()


def test_the_radars_notes_and_queue_hold_on_the_deployed_store(db, uid):
    """What the radar writes at a look goes together, and two looks in the same moment do not both tell a find."""
    from types import SimpleNamespace

    from app import radar, wakes
    from app.services import now_iso
    from app.store.errors import ConflictError
    finds = [{"ts": now_iso(), "kind": "radar", "symbol": s, "message": f"{s} is at 1: down 3.0% today"} for s in ("COMI", "TMGH")]
    browser, timer = SimpleNamespace(store=store(db, uid)), SimpleNamespace(store=store(db, uid))
    assert browser.store.get(*radar.STATE) is None and timer.store.get(*radar.STATE) is None   # both looked before either wrote
    with timer.store.transaction():
        timer.store.put(*radar.STATE, {"session": "2026-11-17", "seen": {"COMI|down": 1, "TMGH|down": 1}})
        wakes.add(timer, finds)
        for e in finds:
            timer.store.append(radar.LOG, {**e, "type": "find"})
    with pytest.raises(ConflictError), browser.store.transaction():
        browser.store.put(*radar.STATE, {"session": "2026-11-17", "seen": {"COMI|down": 1}})
        wakes.add(browser, finds[:1])
    later = SimpleNamespace(store=store(db, uid))
    assert [e["symbol"] for e in wakes.pending(later)] == ["COMI", "TMGH"]              # each find once
    assert [e["symbol"] for e in later.store.recent(radar.LOG, 5)] == ["TMGH", "COMI"]
    # the quick sort marks one as minor: it stays for the next full review, and a short review is handed the other
    assert wakes.mark_minor(later, finds[:1], "noise") == 1
    short = SimpleNamespace(store=store(db, uid))
    with short.store.transaction():
        assert [e["symbol"] for e in wakes.take(short, only_fresh=True)] == ["TMGH"]
    full = SimpleNamespace(store=store(db, uid))
    with full.store.transaction():
        handed = wakes.take(full)
    assert [(e["symbol"], wakes.minor(e), e["sorted_why"]) for e in handed] == [("COMI", True, "noise")]
    assert wakes.pending(SimpleNamespace(store=store(db, uid))) == []
