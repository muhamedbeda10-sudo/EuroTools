"""Accounts that may use EGX Intelligence, managed by an administrator from inside the app.

An account made here can sign in to EGX Intelligence and nothing else: it gets a
document in `egxAccounts`, not in the quality system's `users` collection, so it
has no access to the quality-inspection data that shares this Firebase project.

Like the rest of the API this holds no credentials. Creating the sign-in uses the
project's public sign-up endpoint; granting access is a Firestore write made with
the administrator's own token, and `firestore.rules` is what decides whether that
write is allowed. The check in `can_manage` only decides what the screen shows.
"""
from __future__ import annotations

import os
import re
from datetime import UTC, datetime
from urllib.parse import quote

import httpx

from .store.errors import AuthError, database_error

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD = 8
_client = httpx.Client(timeout=20.0)


class AccountError(ValueError):
    pass


def _plain(value: dict):
    if "stringValue" in value:
        return value["stringValue"]
    if "booleanValue" in value:
        return value["booleanValue"]
    if "timestampValue" in value:
        return value["timestampValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "arrayValue" in value:
        return [_plain(v) for v in value["arrayValue"].get("values", [])]
    return None


def _fields(doc: dict) -> dict:
    return {k: _plain(v) for k, v in doc.get("fields", {}).items()}


class Accounts:
    def __init__(self, project_id: str, api_key: str, token: str, uid: str):
        self.uid = uid
        fs = os.environ.get("FIRESTORE_EMULATOR_HOST")
        au = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
        self._db = f"projects/{project_id}/databases/(default)/documents"
        self._docs = f"{'http://' + fs if fs else 'https://firestore.googleapis.com'}/v1/{self._db}"
        self._idp = f"{'http://' + au + '/' if au else 'https://'}identitytoolkit.googleapis.com/v1"
        self._key = api_key
        self._headers = {"Authorization": f"Bearer {token}"}

    def _get(self, path: str) -> dict | None:
        res = _client.get(f"{self._docs}/{path}", headers=self._headers)
        if res.status_code in (403, 404):
            return None
        if res.status_code == 401:
            raise AuthError("sign in again")
        if res.status_code >= 400:
            raise database_error("read", res.status_code, res.text)
        return _fields(res.json())

    def can_manage(self) -> bool:
        """Mirrors `grants('user.manage')` in firestore.rules. Display only; the rules enforce it."""
        me = self._get(f"users/{quote(self.uid, safe='')}")
        if not me or me.get("active") is not True:
            return False
        if "user.manage" in (me.get("denied") or []):
            return False
        return me.get("role") == "ADMIN" or "user.manage" in (me.get("granted") or [])

    def list(self) -> list[dict]:
        out, page = [], None
        while True:
            res = _client.get(f"{self._docs}/egxAccounts", headers=self._headers,
                              params={"pageSize": 300} | ({"pageToken": page} if page else {}))
            if res.status_code in (401, 403):
                raise AuthError("only an administrator can see the accounts")
            if res.status_code >= 400:
                raise database_error("read", res.status_code, res.text)
            data = res.json()
            for d in data.get("documents", []):
                out.append({"uid": d["name"].rsplit("/", 1)[1], **_fields(d)})
            page = data.get("nextPageToken")
            if not page:
                break
        return sorted(out, key=lambda a: a.get("createdAt") or "", reverse=True)

    def create(self, email: str, password: str, name: str) -> dict:
        email, name = email.strip().lower(), name.strip()
        if not EMAIL.match(email) or len(email) > 254:
            raise AccountError("enter a valid email address")
        if not 1 <= len(name) <= 80:
            raise AccountError("enter the person's name (up to 80 characters)")
        if len(password) < MIN_PASSWORD or len(password) > 128:
            raise AccountError(f"the password must be at least {MIN_PASSWORD} characters")
        if not self.can_manage():
            raise AuthError("only an administrator can create accounts")

        res = _client.post(f"{self._idp}/accounts:signUp", params={"key": self._key},
                           json={"email": email, "password": password, "returnSecureToken": True})
        if res.status_code != 200:
            code = res.json().get("error", {}).get("message", "") if res.content else ""
            if "EMAIL_EXISTS" in code:
                raise AccountError("that email already has a sign-in in this project")
            if "WEAK_PASSWORD" in code:
                raise AccountError("that password is too weak; use a longer one")
            if "OPERATION_NOT_ALLOWED" in code or "ADMIN_ONLY" in code:
                raise AccountError("creating sign-ins is switched off for this Firebase project "
                                   "(Authentication → Settings → User actions → enable create)")
            raise AccountError("could not create the sign-in")
        created = res.json()
        new_uid, new_token = created["localId"], created["idToken"]

        now = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        doc = {"email": email, "name": name, "active": True, "createdBy": self.uid, "createdAt": now}
        write = _client.post(
            f"{self._docs}:commit", headers=self._headers,
            json={"writes": [{
                "update": {"name": f"{self._db}/egxAccounts/{new_uid}", "fields": {
                    "email": {"stringValue": email}, "name": {"stringValue": name},
                    "active": {"booleanValue": True}, "createdBy": {"stringValue": self.uid},
                    "createdAt": {"timestampValue": now}}},
                "currentDocument": {"exists": False},
            }]},
        )
        if write.status_code != 200:
            # Access was not granted, so do not leave a sign-in behind that cannot be used.
            _client.post(f"{self._idp}/accounts:delete", params={"key": self._key}, json={"idToken": new_token})
            if write.status_code in (401, 403):
                raise AuthError("only an administrator can create accounts")
            raise AccountError("the sign-in was created but access could not be granted; nothing was kept")
        return {"uid": new_uid, **doc}

    def set_active(self, uid: str, active: bool) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid):
            raise AccountError("unknown account")
        if uid == self.uid:
            raise AccountError("you cannot change your own account")
        now = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        res = _client.post(
            f"{self._docs}:commit", headers=self._headers,
            json={"writes": [{
                "update": {"name": f"{self._db}/egxAccounts/{uid}", "fields": {
                    "active": {"booleanValue": active}, "updatedBy": {"stringValue": self.uid},
                    "updatedAt": {"timestampValue": now}}},
                "updateMask": {"fieldPaths": ["active", "updatedBy", "updatedAt"]},
                "currentDocument": {"exists": True},
            }]},
        )
        if res.status_code in (401, 403) and not self.can_manage():
            raise AuthError("only an administrator can change accounts")
        if res.status_code != 200:
            raise AccountError("unknown account")  # the rules also refuse a write to a missing record
        return {"uid": uid, "active": active}


class PgAccounts:
    """The same, with the record of accounts in Postgres (`egx.accounts`) instead of Firestore.

    Here the server decides, not a database rule: every method that changes something first checks
    that the caller's own row says `admin`. The caller's account id comes from a sign-in the server
    has verified. Creating the sign-in itself still uses the sign-in service's public endpoint.
    """

    def __init__(self, db, api_key: str, uid: str, on_change=None):
        self.uid = uid
        self._db, self._key, self._changed = db, api_key, on_change or (lambda uid: None)
        au = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
        self._idp = f"{'http://' + au + '/' if au else 'https://'}identitytoolkit.googleapis.com/v1"

    def can_manage(self) -> bool:
        row = self._db.one("select active, admin from egx.accounts where uid=%s", (self.uid,))
        return bool(row and row[0] and row[1])

    def list(self) -> list[dict]:
        if not self.can_manage():
            raise AuthError("only an administrator can see the accounts")
        rows = self._db.all("select uid, email, name, active, admin, created_at, created_by from egx.accounts "
                            "order by created_at desc nulls last, uid")
        return [{"uid": uid, "email": email, "name": name, "active": active, "admin": admin,
                 "createdAt": made.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z") if made else None,
                 "createdBy": by} for uid, email, name, active, admin, made, by in rows]

    def create(self, email: str, password: str, name: str) -> dict:
        email, name = email.strip().lower(), name.strip()
        if not EMAIL.match(email) or len(email) > 254:
            raise AccountError("enter a valid email address")
        if not 1 <= len(name) <= 80:
            raise AccountError("enter the person's name (up to 80 characters)")
        if len(password) < MIN_PASSWORD or len(password) > 128:
            raise AccountError(f"the password must be at least {MIN_PASSWORD} characters")
        if not self.can_manage():
            raise AuthError("only an administrator can create accounts")

        res = _client.post(f"{self._idp}/accounts:signUp", params={"key": self._key},
                           json={"email": email, "password": password, "returnSecureToken": True})
        if res.status_code != 200:
            code = res.json().get("error", {}).get("message", "") if res.content else ""
            if "EMAIL_EXISTS" in code:
                raise AccountError("that email already has a sign-in in this project")
            if "WEAK_PASSWORD" in code:
                raise AccountError("that password is too weak; use a longer one")
            if "OPERATION_NOT_ALLOWED" in code or "ADMIN_ONLY" in code:
                raise AccountError("creating sign-ins is switched off for this Firebase project "
                                   "(Authentication → Settings → User actions → enable create)")
            raise AccountError("could not create the sign-in")
        created = res.json()
        new_uid, new_token = created["localId"], created["idToken"]
        try:
            # A new account has nothing in the previous database: it is marked as brought over from the start.
            row = self._db.one(
                "insert into egx.accounts (uid, active, admin, email, name, checked_at, created_at, created_by, migrated_at, migration) "
                "values (%s, true, false, %s, %s, now(), now(), %s, now(), %s) on conflict (uid) do nothing returning created_at",
                (new_uid, email, name, self.uid, '{"documents": 0, "collections": {}, "new": true}'))
        except Exception:
            row = None
        if row is None:
            # Access was not granted, so do not leave a sign-in behind that cannot be used.
            _client.post(f"{self._idp}/accounts:delete", params={"key": self._key}, json={"idToken": new_token})
            raise AccountError("the sign-in was created but access could not be granted; nothing was kept")
        return {"uid": new_uid, "email": email, "name": name, "active": True, "createdBy": self.uid,
                "createdAt": row[0].astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")}

    def set_active(self, uid: str, active: bool) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid):
            raise AccountError("unknown account")
        if uid == self.uid:
            raise AccountError("you cannot change your own account")
        if not self.can_manage():
            raise AuthError("only an administrator can change accounts")
        row = self._db.one("update egx.accounts set active=%s, updated_at=now(), updated_by=%s where uid=%s returning uid",
                           (bool(active), self.uid, uid))
        if row is None:
            raise AccountError("unknown account")
        self._changed(uid)
        return {"uid": uid, "active": bool(active)}

