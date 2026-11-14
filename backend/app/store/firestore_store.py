"""Firestore-backed store, used when the API runs on a serverless host.

It talks to the Firestore REST API with the *caller's own* Firebase ID token.
There is no service-account key or any other secret on the server: Firestore
verifies the token and the project's security rules decide what the caller may
touch (only `egx/{their uid}/...`). A forged or expired token fails here.

Each document is stored as one JSON string field (`body`) plus its `seq`, the
same shape the SQLite store uses.
"""
from __future__ import annotations

import base64
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from urllib.parse import quote

import httpx


class AuthError(PermissionError):
    pass


class ConflictError(RuntimeError):
    pass


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
        self._pending: list[dict] = []
        self._depth = 0

    # ---- plumbing --------------------------------------------------------
    def _path(self, coll: str, id: str | None = None) -> str:
        base = f"egx/{quote(self.uid, safe='')}/{quote(coll, safe='')}"
        return base if id is None else f"{base}/{quote(id, safe='')}"

    def _request(self, method: str, url: str, **kw) -> httpx.Response:
        try:
            res = _client.request(method, url, headers=self._headers, **kw)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"database unreachable: {exc.__class__.__name__}") from None
        if res.status_code in (401, 403):
            raise AuthError("not signed in, or this account is not allowed to use the app")
        return res

    @staticmethod
    def _decode(doc: dict) -> dict:
        return json.loads(doc["fields"]["body"]["stringValue"])

    def _write(self, coll: str, id: str, doc: dict, *, must_not_exist: bool = False) -> None:
        fields: dict[str, Any] = {"body": {"stringValue": json.dumps(doc)}}
        if "seq" in doc:
            fields["seq"] = {"integerValue": str(doc["seq"])}
        write: dict[str, Any] = {"update": {"name": f"{self._db}/{self._path(coll, id)}", "fields": fields}}
        if must_not_exist:
            write["currentDocument"] = {"exists": False}
        self._queue(write)

    def _queue(self, write: dict) -> None:
        self._pending.append(write)
        if self._depth == 0:
            self._flush()

    def _flush(self) -> None:
        writes, self._pending = self._pending, []
        if not writes:
            return
        res = self._request("POST", f"{self._url}:commit", json={"writes": writes})
        if res.status_code in (400, 409) and "FAILED_PRECONDITION" in res.text or res.status_code == 409:
            self._docs.clear()
            self._lists.clear()
            raise ConflictError("the data changed in another window; reload and try again")
        if res.status_code >= 400:
            self._docs.clear()
            self._lists.clear()
            raise RuntimeError(f"database write failed ({res.status_code})")

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
                self._docs.clear()
                self._lists.clear()
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
            elif res.status_code >= 400:
                raise RuntimeError(f"database read failed ({res.status_code})")
            else:
                self._docs[key] = self._decode(res.json())
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
                    raise RuntimeError(f"database read failed ({res.status_code})")
                data = res.json()
                for d in data.get("documents", []):
                    if "fields" in d:
                        out.append((d["name"].rsplit("/", 1)[1], self._decode(d)))
                token = data.get("nextPageToken")
                if not token:
                    break
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

    def delete(self, coll: str, id: str) -> bool:
        existed = self.get(coll, id) is not None
        if existed:
            self._queue({"delete": f"{self._db}/{self._path(coll, id)}"})
            self._remember(coll, id, None)
        return existed

    def append(self, coll: str, doc: dict[str, Any]) -> dict[str, Any]:
        """Append-only insert. The write is refused if that sequence number already exists."""
        seq = max((d.get("seq", 0) for d in self.list(coll)), default=0) + 1
        doc = {**doc, "seq": seq}
        id = f"{seq:012d}"
        self.list(coll)  # make sure the list cache exists before remembering
        self._remember(coll, id, doc)
        self._write(coll, id, doc, must_not_exist=True)
        return doc

    def recent(self, coll: str, limit: int) -> list[dict[str, Any]]:
        """Newest `limit` appended documents, without reading the whole collection."""
        query = {"structuredQuery": {"from": [{"collectionId": coll}],
                                     "orderBy": [{"field": {"fieldPath": "seq"}, "direction": "DESCENDING"}],
                                     "limit": limit}}
        parent = f"{self._url}/egx/{quote(self.uid, safe='')}"
        res = self._request("POST", f"{parent}:runQuery", json=query)
        if res.status_code >= 400:
            raise RuntimeError(f"database read failed ({res.status_code})")
        return [self._decode(r["document"]) for r in res.json() if "document" in r]
