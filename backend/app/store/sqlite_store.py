"""Persistence layer.

A small document store (collections of JSON documents) used for local runs and
tests. `firestore_store.FirestoreStore` implements the same interface for the
deployed app. All writes go through `transaction()`,
which serialises writers so ledger postings cannot interleave.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL,
    id   TEXT NOT NULL,
    seq  INTEGER,
    body TEXT NOT NULL,
    PRIMARY KEY (coll, id)
);
CREATE INDEX IF NOT EXISTS docs_coll_seq ON docs (coll, seq);
"""


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._lock = threading.RLock()
        self._depth = 0

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Serialised, atomic unit of work (re-entrant)."""
        with self._lock:
            outer = self._depth == 0
            if outer:
                self._conn.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                yield
            except BaseException:
                self._depth -= 1
                if outer:
                    self._conn.execute("ROLLBACK")
                raise
            else:
                self._depth -= 1
                if outer:
                    self._conn.execute("COMMIT")

    # ---- documents -------------------------------------------------------
    def get(self, coll: str, id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT body FROM docs WHERE coll=? AND id=?", (coll, id)
            ).fetchone()
        return json.loads(row["body"]) if row else None

    def put(self, coll: str, id: str, doc: dict[str, Any]) -> None:
        with self.transaction():
            self._conn.execute(
                "INSERT INTO docs (coll, id, seq, body) VALUES (?,?,NULL,?) "
                "ON CONFLICT(coll, id) DO UPDATE SET body=excluded.body",
                (coll, id, json.dumps(doc)),
            )

    def delete(self, coll: str, id: str) -> bool:
        with self.transaction():
            cur = self._conn.execute("DELETE FROM docs WHERE coll=? AND id=?", (coll, id))
            return cur.rowcount > 0

    def list(self, coll: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT body FROM docs WHERE coll=? ORDER BY seq, id", (coll,)
            ).fetchall()
        return [json.loads(r["body"]) for r in rows]

    def append(self, coll: str, doc: dict[str, Any]) -> dict[str, Any]:
        """Append-only insert with a gap-free sequence number per collection."""
        with self.transaction():
            row = self._conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM docs WHERE coll=?", (coll,)
            ).fetchone()
            seq = int(row["n"])
            doc = {**doc, "seq": seq}
            self._conn.execute(
                "INSERT INTO docs (coll, id, seq, body) VALUES (?,?,?,?)",
                (coll, f"{seq:012d}", seq, json.dumps(doc)),
            )
            return doc

    def recent(self, coll: str, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT body FROM docs WHERE coll=? ORDER BY seq DESC LIMIT ?", (coll, limit)
            ).fetchall()
        return [json.loads(r["body"]) for r in rows]

    def close(self) -> None:
        self._conn.close()
