"""Accounts that may use EGX Intelligence, managed by an administrator from inside the app.

The record is a table, `egx.accounts`: a row lets an account in or keeps it out (`active`), and
says whether it may open and close other accounts (`admin`). The server decides here, not a
database rule: every method that changes something first checks that the caller's own row says
`admin`, and the caller's account id comes from a sign-in the server has verified itself.

Creating the sign-in itself uses the sign-in service's public endpoint (Firebase Authentication).
An account made here can sign in to EGX Intelligence and nothing else.
"""
from __future__ import annotations

import os
import re
from datetime import UTC

import httpx

from .store.errors import AuthError

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD = 8
_client = httpx.Client(timeout=20.0)


class AccountError(ValueError):
    pass


class Accounts:
    """What one signed-in person may see and do with the accounts."""

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
            row = self._db.one(
                "insert into egx.accounts (uid, active, admin, email, name, checked_at, created_at, created_by) "
                "values (%s, true, false, %s, %s, now(), now(), %s) on conflict (uid) do nothing returning created_at",
                (new_uid, email, name, self.uid))
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

