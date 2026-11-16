"""Postgres-backed store, used when the API runs on a serverless host.

Who may touch what
    The server holds the database's address and password (DATABASE_URL, in its environment only). So
    nothing outside the server decides who may read a row, the way the Firestore rules did: this file
    does. Every statement here is tied to one account's id, taken from a sign-in the server has
    verified itself (app/identity.py) before a store is ever made for it. There is no statement in
    this file that reads or writes another account's rows, and none that takes the account from a
    request.

What the database itself still refuses
    The trade ledger and the audit trail are append-only in the table, not only in the application: a
    trigger refuses any change to, or removal of, a row of `audit` or `ledger_*`, whoever asks.

Each document is one row holding the JSON text exactly as the application wrote it, plus its `seq`:
the same shape the SQLite store uses.

Lost updates: a document this request has read is only overwritten if it is still the version that
was read (`version`, raised by one on every write). Two requests changing the same document at once
cannot silently undo each other: the second one gets ConflictError. All the writes of a transaction
go to the database in one database transaction: all of them happen, or none.
"""
from __future__ import annotations

import json
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool, PoolTimeout

from .errors import ConflictError, StoreUnavailable

SCHEMA = r"""
create schema if not exists egx;

create table if not exists egx.docs (
    uid     text   not null,
    coll    text   not null,
    id      text   not null,
    seq     bigint,
    body    text   not null,
    version bigint not null default 1,
    primary key (uid, coll, id)
);
create index if not exists docs_newest on egx.docs (uid, coll, seq desc) where seq is not null;

-- Market prices shared by every account: stored once. Compressed, because every server that starts reads all of it.
create table if not exists egx.market (
    id      text   primary key,
    body    bytea  not null,
    version bigint not null default 1
);

-- What is known about each account: whether it may use the app (asked of the sign-in service, kept here for the
-- minutes it cannot be asked), and whether its data has been brought over from the previous database.
create table if not exists egx.accounts (
    uid         text primary key,
    active      boolean     not null,
    checked_at  timestamptz not null,
    migrated_at timestamptz,
    migration   text
);

create or replace function egx.keep_records() returns trigger language plpgsql as $$
begin
    if old.coll = 'audit' or old.coll like 'ledger\_%' then
        raise exception 'the trade ledger and the audit trail cannot be changed or removed' using errcode = 'P0001';
    end if;
    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end $$;

drop trigger if exists keep_records on egx.docs;
create trigger keep_records before update or delete on egx.docs
    for each row execute function egx.keep_records();

-- Nothing reaches these tables except through the server's own connection.
alter table egx.docs enable row level security;
alter table egx.market enable row level security;
alter table egx.accounts enable row level security;
"""


SCHEMA_LOCK = 0x45475801   # the advisory lock that serialises creating the schema


class _Stale(Exception):
    """A write found a document that is no longer the version this request read."""


class Database:
    """The server's connections to the database: a small pool, shared by every request of one server instance."""

    def __init__(self, url: str, *, max_size: int = 6):
        # prepare_threshold=None: the host's connection pooler hands each transaction to any backend, where a
        # statement prepared on another one does not exist.
        self._pool = ConnectionPool(url, min_size=0, max_size=max_size, timeout=10.0, max_idle=120.0, open=True,
                                    kwargs={"autocommit": True, "prepare_threshold": None},
                                    check=ConnectionPool.check_connection)
        self._ready = False

    def run(self, work):
        """Call `work(connection)` with a connection that is given back afterwards, whatever happens."""
        try:
            with self._pool.connection() as conn:
                return work(conn)
        except (_Stale, ConflictError):
            raise
        except PoolTimeout:
            raise StoreUnavailable("the database is not answering; try again in a moment") from None
        except psycopg.errors.RaiseException as exc:
            raise RuntimeError(str(exc.diag.message_primary or exc)) from None
        except psycopg.OperationalError as exc:
            raise StoreUnavailable(f"the database cannot be reached ({exc.__class__.__name__})") from None

    def all(self, sql: str, params: tuple = ()) -> list[tuple]:
        return self.run(lambda conn: conn.execute(sql, params).fetchall())

    def one(self, sql: str, params: tuple = ()) -> tuple | None:
        return self.run(lambda conn: conn.execute(sql, params).fetchone())

    def ensure_schema(self) -> None:
        """Create the tables if this database has none yet. Asked once per server instance: one small query.

        Two servers starting at the same moment take turns (an advisory lock), so the second finds the work done.
        """
        if self._ready:
            return

        def work(conn) -> None:
            if conn.execute("select to_regclass('egx.accounts')").fetchone()[0] is None:
                with conn.transaction():
                    conn.execute("select pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
                    conn.execute(SCHEMA)
        self.run(work)
        self._ready = True

    def close(self) -> None:
        self._pool.close()


class PostgresStore:
    """One account's documents, as one request sees them."""

    def __init__(self, db: Database, uid: str):
        if not uid or not isinstance(uid, str):
            raise ValueError("a store is always one account's")
        self.db = db
        self.uid = uid
        self._docs: dict[tuple[str, str], dict | None] = {}
        self._lists: dict[str, list[dict]] = {}
        self._versions: dict[tuple[str, str], int | None] = {}  # version of each document read (None: it was absent)
        self._next: dict[str, int] = {}                         # next sequence number per append-only collection
        self._pending: list[dict] = []
        self._keys: list[tuple[str, str]] = []                  # which document each pending write is for
        self._depth = 0

    # ---- plumbing --------------------------------------------------------
    def _guard(self, key: tuple[str, str]) -> tuple | None:
        """Precondition for overwriting or deleting a document this request has read."""
        if key not in self._versions:
            return None  # never read here: a blind write, as for a brand-new document with a random id
        seen = self._versions[key]
        return ("absent",) if seen is None else ("version", seen)

    def _write(self, coll: str, id: str, doc: dict, *, must_not_exist: bool = False) -> None:
        seq = doc.get("seq")
        write = {"op": "put", "body": json.dumps(doc), "seq": seq if isinstance(seq, int) and not isinstance(seq, bool) else None,
                 "guard": ("absent",) if must_not_exist else self._guard((coll, id))}
        self._queue((coll, id), write)

    def _queue(self, key: tuple[str, str], write: dict) -> None:
        if key in self._keys:
            # Second write to one document inside a transaction: one write goes out, checked
            # against the version the document had before the transaction.
            at = self._keys.index(key)
            write["guard"] = self._pending[at]["guard"]
            self._pending[at] = write
        else:
            self._pending.append(write)
            self._keys.append(key)
        if self._depth == 0:
            self._flush()

    def fresh(self) -> None:
        """Drop everything this request has read, so that what is read next comes from the database as it is now.

        A request normally sees one consistent picture. Something that acts more than once in a request (the
        automation sending several orders) asks for a new picture before each act, so that a switch the owner
        turned off a moment ago is seen. Writes that follow are checked against the new reads.
        """
        self._forget()

    def _forget(self) -> None:
        self._docs.clear()
        self._lists.clear()
        self._versions.clear()
        self._next.clear()

    def _flush(self) -> None:
        writes, keys, self._pending, self._keys = self._pending, self._keys, [], []
        if not writes:
            return
        uid = self.uid

        def work(conn) -> dict[tuple[str, str], int | None]:
            after: dict[tuple[str, str], int | None] = {}
            with conn.transaction():
                for (coll, id), write in zip(keys, writes, strict=True):
                    guard = write["guard"]
                    if write["op"] == "delete":
                        if guard and guard[0] == "version":
                            done = conn.execute("delete from egx.docs where uid=%s and coll=%s and id=%s and version=%s",
                                                (uid, coll, id, guard[1])).rowcount
                            if done != 1:
                                raise _Stale
                        else:
                            conn.execute("delete from egx.docs where uid=%s and coll=%s and id=%s", (uid, coll, id))
                        after[(coll, id)] = None
                        continue
                    if guard and guard[0] == "absent":
                        row = conn.execute(
                            "insert into egx.docs (uid, coll, id, seq, body) values (%s,%s,%s,%s,%s) "
                            "on conflict do nothing returning version", (uid, coll, id, write["seq"], write["body"])).fetchone()
                    elif guard:
                        row = conn.execute(
                            "update egx.docs set body=%s, seq=%s, version=version+1 "
                            "where uid=%s and coll=%s and id=%s and version=%s returning version",
                            (write["body"], write["seq"], uid, coll, id, guard[1])).fetchone()
                    else:
                        row = conn.execute(
                            "insert into egx.docs (uid, coll, id, seq, body) values (%s,%s,%s,%s,%s) "
                            "on conflict (uid, coll, id) do update set body=excluded.body, seq=excluded.seq, "
                            "version=egx.docs.version+1 returning version",
                            (uid, coll, id, write["seq"], write["body"])).fetchone()
                    if row is None:
                        raise _Stale
                    after[(coll, id)] = row[0]
            return after

        try:
            after = self.db.run(work)
        except _Stale:
            self._forget()
            raise ConflictError("the data changed in another window; reload and try again") from None
        except BaseException:
            self._forget()
            raise
        # Remember the new version of everything just written, for a later write in this request.
        self._versions.update(after)

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Buffer writes and commit them atomically when the outermost block exits."""
        self._depth += 1
        try:
            yield
        except BaseException:
            self._depth -= 1
            if self._depth == 0:
                self._pending.clear()
                self._keys.clear()
                self._forget()
            raise
        else:
            self._depth -= 1
            if self._depth == 0:
                self._flush()

    # ---- documents -------------------------------------------------------
    def get(self, coll: str, id: str) -> dict[str, Any] | None:
        key = (coll, id)
        if key not in self._docs:
            row = self.db.one("select body, version from egx.docs where uid=%s and coll=%s and id=%s", (self.uid, coll, id))
            self._take(key, row)
        doc = self._docs[key]
        return json.loads(json.dumps(doc)) if doc is not None else None

    def _take(self, key: tuple[str, str], row: tuple | None) -> None:
        """Keep one document as the database has it (None: it is not there)."""
        self._docs[key] = json.loads(row[0]) if row else None
        self._versions.setdefault(key, row[1] if row else None)

    def _take_list(self, coll: str, rows: list[tuple]) -> None:
        """Keep a whole collection as the database has it, with this request's waiting writes laid over it."""
        out: list[tuple[str, dict]] = []
        for id, body, version in rows:
            out.append((id, json.loads(body)))
            self._versions.setdefault((coll, id), version)
        # Writes of this request that are still waiting to be committed belong in the picture too.
        for key in self._keys:
            if key[0] == coll:
                out = [t for t in out if t[0] != key[1]]
                if self._docs.get(key) is not None:
                    out.append((key[1], self._docs[key]))
        out.sort(key=lambda t: t[0])
        self._lists[coll] = [dict(doc, **{"__id": id}) for id, doc in out]

    def list(self, coll: str) -> list[dict[str, Any]]:
        if coll not in self._lists:
            self._take_list(coll, self.db.all("select id, body, version from egx.docs where uid=%s and coll=%s", (self.uid, coll)))
        return [{k: v for k, v in d.items() if k != "__id"} for d in json.loads(json.dumps(self._lists[coll]))]

    def _remember(self, coll: str, id: str, doc: dict | None) -> None:
        self._docs[(coll, id)] = doc
        if coll in self._lists:
            rows = [d for d in self._lists[coll] if d["__id"] != id]
            if doc is not None:
                rows.append(dict(doc, **{"__id": id}))
                rows.sort(key=lambda d: d["__id"])
            self._lists[coll] = rows

    def put(self, coll: str, id: str, doc: dict[str, Any]) -> None:
        self._write(coll, id, doc)
        self._remember(coll, id, doc)

    def create(self, coll: str, id: str, doc: dict[str, Any]) -> None:
        """Write a document that must not exist yet; the commit fails with ConflictError if it does."""
        self._remember(coll, id, doc)
        self._write(coll, id, doc, must_not_exist=True)

    def delete(self, coll: str, id: str) -> bool:
        existed = self.get(coll, id) is not None
        if existed:
            self._remember(coll, id, None)
            self._queue((coll, id), {"op": "delete", "guard": self._guard((coll, id))})
        return existed

    def append(self, coll: str, doc: dict[str, Any]) -> dict[str, Any]:
        """Append-only insert. The write is refused if that sequence number already exists.

        The next number comes from the collection if this request already read it, and
        otherwise from one small query for the newest entry: adding a line to a long
        audit log does not download the log.
        """
        if coll not in self._next:
            if coll in self._lists:
                last = max((d.get("seq", 0) for d in self._lists[coll]), default=0)
            else:
                newest = self.recent(coll, 1)
                last = newest[0].get("seq", 0) if newest else 0
            self._next[coll] = last + 1
        seq = self._next[coll]
        self._next[coll] = seq + 1
        doc = {**doc, "seq": seq}
        id = f"{seq:012d}"
        self._remember(coll, id, doc)
        self._write(coll, id, doc, must_not_exist=True)
        return doc

    def warm(self, gets: list[tuple[str, str]] = (), lists: list[str] = ()) -> None:
        """Fetch several documents and collections in one round trip, ahead of the code that reads them."""
        gets = [g for g in dict.fromkeys(gets) if g not in self._docs and g[0] not in lists]
        lists = [c for c in dict.fromkeys(lists) if c not in self._lists]
        if len(gets) + len(lists) < 2:
            return
        rows = self.db.all(
            "select coll, id, body, version from egx.docs where uid=%s and (coll = any(%s::text[]) or (coll, id) in "
            "(select * from unnest(%s::text[], %s::text[])))",
            (self.uid, lists, [g[0] for g in gets], [g[1] for g in gets]))
        for coll in lists:
            self._take_list(coll, [(id, body, version) for c, id, body, version in rows if c == coll])
        found = {(c, id): (body, version) for c, id, body, version in rows}
        for key in gets:
            self._take(key, found.get(key))

    def recent(self, coll: str, limit: int) -> list[dict[str, Any]]:
        """Newest `limit` appended documents, without reading the whole collection."""
        rows = self.db.all("select body from egx.docs where uid=%s and coll=%s and seq is not null order by seq desc limit %s",
                           (self.uid, coll, int(limit)))
        return [json.loads(r[0]) for r in rows]


class PostgresDocs:
    """The market documents every account shares, version-checked the way FirestoreDocs is."""

    def __init__(self, db: Database):
        self.db = db
        self._seen: dict[str, int | None] = {}  # document -> its version when this request read it (None: absent)

    def get(self, id: str) -> dict | None:
        row = self.db.one("select body, version from egx.market where id=%s", (id,))
        if row is None:
            self._seen[id] = None
            return None
        self._seen[id] = row[1]
        return json.loads(zlib.decompress(bytes(row[0])))

    def put(self, id: str, doc: dict, *, guard: bool = False) -> None:
        """Write a document. With `guard`, only if it is still the version this request read:
        two people refreshing at once cannot silently overwrite each other's work."""
        body = zlib.compress(json.dumps(doc, separators=(",", ":")).encode(), 6)
        if guard and id in self._seen:
            seen = self._seen[id]
            if seen is None:
                row = self.db.one("insert into egx.market (id, body) values (%s,%s) on conflict do nothing returning version", (id, body))
            else:
                row = self.db.one("update egx.market set body=%s, version=version+1 where id=%s and version=%s returning version",
                                  (body, id, seen))
            if row is None:
                self._seen.pop(id, None)
                raise ConflictError("the shared market data changed while it was being updated")
        else:
            row = self.db.one("insert into egx.market (id, body) values (%s,%s) on conflict (id) do update "
                              "set body=excluded.body, version=egx.market.version+1 returning version", (id, body))
        self._seen[id] = row[0]
