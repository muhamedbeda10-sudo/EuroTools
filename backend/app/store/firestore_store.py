"""Firestore-backed store, used when the API runs on a serverless host.

It talks to the Firestore REST API with the *caller's own* Firebase ID token.
There is no service-account key or any other secret on the server: Firestore
verifies the token and the project's security rules decide what the caller may
touch (only `egx/{their uid}/...`). A forged or expired token fails here.

Each document is stored as one JSON string field (`body`) plus its `seq`, the
same shape the SQLite store uses.

Lost updates: a document this request has read is only overwritten if it is still
the version that was read (`updateTime` precondition). Two requests changing the
same document at once (a paper run being paused while the background job fills an
order for it) cannot silently undo each other: the second one gets ConflictError.
"""
from __future__ import annotations

import base64
import json
import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from typing import Any
from urllib.parse import quote

import httpx

from .errors import AuthError, ConflictError, DatabaseError, database_error


def uid_from_token(token: str) -> str:
    """Read the uid claim. NOT a verification: Firestore verifies the signature on first use."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        uid = claims.get("user_id") or claims.get("sub")
    except Exception:  # noqa: BLE001 - any malformed token is the same answer
        uid = None
    if not uid or not isinstance(uid, str) or "/" in uid or len(uid) > 128:
        raise AuthError("invalid sign-in token")
    return uid


_client = httpx.Client(timeout=20.0)


class FirestoreStore:
    def __init__(self, project_id: str, token: str, uid: str | None = None):
        self.uid = uid or uid_from_token(token)
        emulator = os.environ.get("FIRESTORE_EMULATOR_HOST")
        origin = f"http://{emulator}" if emulator else "https://firestore.googleapis.com"
        self._db = f"projects/{project_id}/databases/(default)/documents"
        self._url = f"{origin}/v1/{self._db}"
        self._headers = {"Authorization": f"Bearer {token}"}
        self._docs: dict[tuple[str, str], dict | None] = {}
        self._lists: dict[str, list[dict]] = {}
        self._times: dict[tuple[str, str], str | None] = {}  # version of each document read (None: it was absent)
        self._next: dict[str, int] = {}                      # next sequence number per append-only collection
        self._pending: list[dict] = []
        self._keys: list[tuple[str, str]] = []               # which document each pending write is for
        self._depth = 0

    # ---- plumbing --------------------------------------------------------
    def _path(self, coll: str, id: str | None = None) -> str:
        base = f"egx/{quote(self.uid, safe='')}/{quote(coll, safe='')}"
        return base if id is None else f"{base}/{quote(id, safe='')}"

    def _request(self, method: str, url: str, **kw) -> httpx.Response:
        try:
            res = _client.request(method, url, headers=self._headers, **kw)
        except httpx.HTTPError as exc:
            raise DatabaseError(f"database unreachable: {exc.__class__.__name__}", retry_after=15) from None
        if res.status_code in (401, 403):
            raise AuthError("not signed in, or this account is not allowed to use the app")
        return res

    @staticmethod
    def _decode(doc: dict) -> dict:
        return json.loads(doc["fields"]["body"]["stringValue"])

    def _guard(self, key: tuple[str, str]) -> dict | None:
        """Precondition for overwriting or deleting a document this request has read."""
        if key not in self._times:
            return None  # never read here: a blind write, as for a brand-new document with a random id
        seen = self._times[key]
        return {"exists": False} if seen is None else {"updateTime": seen}

    def _write(self, coll: str, id: str, doc: dict, *, must_not_exist: bool = False) -> None:
        fields: dict[str, Any] = {"body": {"stringValue": json.dumps(doc)}}
        if "seq" in doc:
            fields["seq"] = {"integerValue": str(doc["seq"])}
        write: dict[str, Any] = {"update": {"name": f"{self._db}/{self._path(coll, id)}", "fields": fields}}
        guard = {"exists": False} if must_not_exist else self._guard((coll, id))
        if guard:
            write["currentDocument"] = guard
        self._queue((coll, id), write)

    def _queue(self, key: tuple[str, str], write: dict) -> None:
        if key in self._keys:
            # Second write to one document inside a transaction: one write goes out, checked
            # against the version the document had before the transaction.
            at = self._keys.index(key)
            first = self._pending[at]
            if "currentDocument" in first:
                write["currentDocument"] = first["currentDocument"]
            else:
                write.pop("currentDocument", None)
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
        self._times.clear()
        self._next.clear()

    def _flush(self) -> None:
        writes, keys, self._pending, self._keys = self._pending, self._keys, [], []
        if not writes:
            return
        res = self._request("POST", f"{self._url}:commit", json={"writes": writes})
        guarded = any("currentDocument" in w for w in writes)
        if (res.status_code in (400, 409) and "FAILED_PRECONDITION" in res.text or res.status_code == 409
                or res.status_code == 404 and guarded and "NOT_FOUND" in res.text):
            self._forget()
            raise ConflictError("the data changed in another window; reload and try again")
        if res.status_code >= 400:
            self._forget()
            raise database_error("write", res.status_code, res.text)
        # Remember the new version of everything just written, for a later write in this request.
        results = res.json().get("writeResults") or []
        for i, (key, write) in enumerate(zip(keys, writes, strict=True)):
            if "delete" in write:
                self._times[key] = None
            elif i < len(results) and results[i].get("updateTime"):
                self._times[key] = results[i]["updateTime"]
            else:
                self._times.pop(key, None)

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
            res = self._request("GET", f"{self._url}/{self._path(coll, id)}")
            if res.status_code == 404:
                self._docs[key] = None
                self._times.setdefault(key, None)
            elif res.status_code >= 400:
                raise database_error("read", res.status_code, res.text)
            else:
                body = res.json()
                self._docs[key] = self._decode(body)
                self._times.setdefault(key, body.get("updateTime"))
        doc = self._docs[key]
        return json.loads(json.dumps(doc)) if doc is not None else None

    def list(self, coll: str) -> list[dict[str, Any]]:
        if coll not in self._lists:
            out: list[tuple[str, dict]] = []
            token = None
            while True:
                params = {"pageSize": 300} | ({"pageToken": token} if token else {})
                res = self._request("GET", f"{self._url}/{self._path(coll)}", params=params)
                if res.status_code >= 400:
                    raise database_error("read", res.status_code, res.text)
                data = res.json()
                for d in data.get("documents", []):
                    if "fields" in d:
                        id = d["name"].rsplit("/", 1)[1]
                        out.append((id, self._decode(d)))
                        self._times.setdefault((coll, id), d.get("updateTime"))
                token = data.get("nextPageToken")
                if not token:
                    break
            # Writes of this request that are still waiting to be committed belong in the picture too.
            for key in self._keys:
                if key[0] == coll:
                    out = [t for t in out if t[0] != key[1]]
                    if self._docs.get(key) is not None:
                        out.append((key[1], self._docs[key]))
            out.sort(key=lambda t: t[0])
            self._lists[coll] = [dict(doc, **{"__id": id}) for id, doc in out]
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
            write: dict[str, Any] = {"delete": f"{self._db}/{self._path(coll, id)}"}
            guard = self._guard((coll, id))
            if guard and "updateTime" in guard:
                write["currentDocument"] = guard
            self._remember(coll, id, None)
            self._queue((coll, id), write)
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
        """Fetch several documents and collections at the same time, ahead of the code that reads them.

        Every read is a network round trip to the database; a screen that needs
        four of them waits for one round trip instead of four.
        """
        jobs = [lambda g=g: self.get(*g) for g in gets if g not in self._docs]
        jobs += [lambda c=c: self.list(c) for c in lists if c not in self._lists]
        if len(jobs) > 1:
            with ThreadPoolExecutor(len(jobs)) as pool:
                for future in [pool.submit(job) for job in jobs]:
                    future.result()

    def recent(self, coll: str, limit: int) -> list[dict[str, Any]]:
        """Newest `limit` appended documents, without reading the whole collection."""
        query = {"structuredQuery": {"from": [{"collectionId": coll}],
                                     "orderBy": [{"field": {"fieldPath": "seq"}, "direction": "DESCENDING"}],
                                     "limit": limit}}
        parent = f"{self._url}/egx/{quote(self.uid, safe='')}"
        res = self._request("POST", f"{parent}:runQuery", json=query)
        if res.status_code >= 400:
            raise database_error("read", res.status_code, res.text)
        return [self._decode(r["document"]) for r in res.json() if "document" in r]
