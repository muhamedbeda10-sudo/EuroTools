"""Bringing an account's data over from Firestore, once.

The app kept its data in Firestore until 16 November 2026. Nothing is moved by hand or by an
administrator's key: the first time each person uses the app after the change, the server reads
that person's own data out of Firestore with that person's own sign-in (exactly as it always read
it), writes it into Postgres in one transaction, reads it back, and compares. Only when every
document is there, letter for letter, is the account marked as brought over; otherwise nothing is
kept and the person is told to try again. The market prices every account shares come over the
same way, with the first person.

Firestore is only read here. What is there stays there, as the copy to go back to.

Firestore gives a signed-in person no way to ask "which collections do I have", so they are named
here. `tests/test_migrate.py` reads the application's source and fails when it uses a collection
this file does not name.
"""
from __future__ import annotations

import json
import logging
import threading
import zlib
from datetime import date

from ..data.feed import CHUNKS
from .errors import StoreUnavailable

log = logging.getLogger("egx.migrate")

# Every collection of an account that has a fixed name.
FIXED = ("alert_events", "alerts", "assistant_chats", "assistant_usage", "audit", "backtests", "bars", "categories",
         "instruments", "journal", "orders", "paper_runs", "portfolios", "push_subs", "real_days", "research", "settings",
         "strategies", "watchlist")
# And the two families whose names are made up as they are needed.
LEDGER = "ledger_"                 # one per portfolio: ledger_{portfolio id}
REAL_ORDERS = "real_orders_"       # one per month: real_orders_{YYYYMM}
REAL_ORDERS_SINCE = (2026, 1)      # no real order is older than the feature
MARKET = ("meta", "index", "live", *(f"chunk_{n:02d}" for n in range(CHUNKS)))
INSERT_AT_ONCE = 400

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_done: set[str] = set()            # accounts this server instance knows are brought over


class MigrationError(RuntimeError):
    """The copy did not come out identical, or there was already something where it was to go. Nothing was kept."""


def _lock(name: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(name, threading.Lock())


def months(today: date) -> list[str]:
    """The months a real order can be filed under: from the first one to next month."""
    out, (year, month) = [], REAL_ORDERS_SINCE
    end = (today.year + (today.month == 12), today.month % 12 + 1)
    while (year, month) <= end:
        out.append(f"{year}{month:02d}")
        year, month = (year + (month == 12), month % 12 + 1)
    return out


def read_account(source, today: date) -> dict[tuple[str, str], tuple[int | None, str]]:
    """Everything an account has in Firestore: {(collection, id): (seq, the document as JSON text)}."""
    source.warm(lists=list(FIXED))
    found = {coll: source.rows(coll) for coll in FIXED}
    portfolios = {id for id, _ in found["portfolios"]}
    active = next((doc.get("active_portfolio_id") for id, doc in found["settings"] if id == "app"), None)
    if active:
        portfolios.add(active)
    more = [f"{LEDGER}{pid}" for pid in sorted(portfolios)] + [f"{REAL_ORDERS}{m}" for m in months(today)]
    source.warm(lists=more)
    found.update({coll: source.rows(coll) for coll in more})
    out = {}
    for coll, rows in found.items():
        for id, doc in rows:
            seq = doc.get("seq")
            out[(coll, id)] = (seq if isinstance(seq, int) and not isinstance(seq, bool) else None, json.dumps(doc))
    return out


def bring_account(db, uid: str, make_source, today: date) -> dict | None:
    """Copy one account from Firestore, if it has not been. Returns what was copied, or None when there was nothing to do.

    `make_source()` gives a FirestoreStore for this account, opened with its own sign-in.
    """
    if uid in _done:
        return None
    with _lock(uid):                       # one copy at a time per server; the database lock covers the other servers
        if uid in _done:
            return None
        row = db.one("select migrated_at from egx.accounts where uid=%s", (uid,))
        if row and row[0]:
            _done.add(uid)
            return None
        try:
            docs = read_account(make_source(), today)
        except StoreUnavailable:
            raise
        except RuntimeError as exc:        # Firestore is refusing or failing: nothing was copied, and nothing is lost
            raise StoreUnavailable(f"your data is being moved to the new database and the old one is not answering ({exc}); "
                                   "try again in a moment") from None
        counts: dict[str, int] = {}
        for coll, _ in docs:
            counts[coll] = counts.get(coll, 0) + 1
        report = {"documents": len(docs), "collections": dict(sorted(counts.items()))}

        def work(conn) -> bool:
            with conn.transaction():
                conn.execute("select pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"egx-account:{uid}",))
                again = conn.execute("select migrated_at from egx.accounts where uid=%s", (uid,)).fetchone()
                if again and again[0]:
                    return False           # another server did it while this one was reading
                if conn.execute("select 1 from egx.docs where uid=%s limit 1", (uid,)).fetchone():
                    raise MigrationError("this account already has data in the new database, and is not marked as moved; "
                                         "nothing was changed")
                keys = sorted(docs)
                for at in range(0, len(keys), INSERT_AT_ONCE):
                    part = keys[at:at + INSERT_AT_ONCE]
                    conn.execute(
                        "insert into egx.docs (uid, coll, id, seq, body) "
                        "select %s, * from unnest(%s::text[], %s::text[], %s::bigint[], %s::text[])",
                        (uid, [k[0] for k in part], [k[1] for k in part], [docs[k][0] for k in part], [docs[k][1] for k in part]))
                kept = {(c, i): (s, b) for c, i, s, b in
                        conn.execute("select coll, id, seq, body from egx.docs where uid=%s", (uid,)).fetchall()}
                if kept != docs:
                    raise MigrationError("the copy in the new database is not identical to the original; nothing was kept")
                conn.execute(
                    "insert into egx.accounts (uid, active, checked_at, migrated_at, migration) values (%s, true, now(), now(), %s) "
                    "on conflict (uid) do update set migrated_at=excluded.migrated_at, migration=excluded.migration",
                    (uid, json.dumps(report)))
            return True

        copied = db.run(work)
        _done.add(uid)
        if copied:
            log.warning("migrate: account %s… brought over from Firestore: %s", uid[:6], json.dumps(report))
        return report if copied else None


def bring_market(db, source_docs) -> int:
    """Copy the shared market documents from Firestore when the new database has none. Returns how many came over."""
    if "market" in _done:
        return 0
    with _lock("market"):
        if "market" in _done:
            return 0
        if db.one("select 1 from egx.market limit 1") is not None:
            _done.add("market")
            return 0
        try:
            found = {id: doc for id in MARKET if (doc := source_docs.get(id)) is not None}
        except Exception as exc:  # noqa: BLE001 - whatever went wrong reading the old database, the prices can be fetched again
            log.warning("migrate: the shared market data could not be read from Firestore (%s); it will be fetched afresh",
                        exc.__class__.__name__)
            return 0
        packed = {id: zlib.compress(json.dumps(doc, separators=(",", ":")).encode(), 6) for id, doc in found.items()}

        def work(conn) -> int:
            with conn.transaction():
                conn.execute("select pg_advisory_xact_lock(hashtextextended(%s, 0))", ("egx-market",))
                if conn.execute("select 1 from egx.market limit 1").fetchone():
                    return 0
                for id, body in packed.items():
                    conn.execute("insert into egx.market (id, body) values (%s, %s)", (id, body))
            return len(packed)

        copied = db.run(work)
        _done.add("market")
        if copied:
            log.warning("migrate: %d shared market documents brought over from Firestore", copied)
        return copied
