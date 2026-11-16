# EGX Intelligence: working notes

Next.js static frontend at the repository root, FastAPI backend in `backend/app`, deployed together on Vercel.
`README.md` describes the architecture and each feature; read the section for what you are changing.

## A change a user can notice is not finished until these are done

The owner asked for this as a standing rule (16 November 2026): every update must reach the people who use the
app, and the assistant inside the app must be kept in step with it.

1. **Release notes.** Add the change to `backend/app/knowledge/whats-new.md`, at the top, in English and in
   Egyptian Arabic. The form is described at the top of `backend/app/whats_new.py`. Use `For: owner` when only the
   brokerage account's owner can use it. The app shows this list to its users after an update, and the assistant
   reads the same file.
2. **Version.** Give the new entry the next version and set the same version in `package.json` (and the two
   `version` lines at the top of `package-lock.json`). A test fails when they differ.
3. **The assistant.** Update what it is told wherever the change touches it:
   - `backend/app/knowledge/app-guide.md`: what each screen does and the rules behind the numbers.
   - `backend/app/assistant.py` (system prompt, autopilot brief) and `backend/app/assistant_tools.py` (tools and
     their descriptions) when behaviour, limits or tools change.
4. **Docs.** `README.md` and the in-app Guide (`app/guide/page.tsx`) where they describe the changed behaviour.

Fixes nobody would notice need none of this.

## Checks before a change is handed over

```bash
cd backend && python3 -m ruff check . && python3 -m pytest -q
```

```bash
npm run typecheck && npm run build
```

The Postgres tests (`test_postgres.py`, `test_identity.py`, `test_migrate.py`) are skipped unless a database is named,
and they are the ones that cover what is deployed. Run them before handing over a change to the store or to sign-in:

```bash
cd backend && TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/egxtest python3 -m pytest -q
```

The Firestore tests in `backend/tests/test_firestore.py` are skipped unless the emulators are running:

```bash
npx firebase emulators:start --only firestore,auth --project demo-egx
```

## Things that must stay true

- Real orders reach the broker from one place (`real_orders._approve`), on the owner's approval of that order or,
  for what fits their automatic box, their standing approval (`real_auto.py`). The assistant has no tool that
  sends, approves or cancels one. Tests keep these fences; do not loosen a test to get a change through.
- The API reads or writes an account's data only after it has verified that account's sign-in itself
  (`identity.py`): the token's signature, its project, its expiry, and the administrator's record that the account
  may use the app. Every statement in `store/postgres_store.py` is tied to that verified account; none takes the
  account from a request, and none reads another account's rows. The ledger and the audit trail are append-only
  in the database itself (a trigger), not only in the application. The database's password (`DATABASE_URL`) is
  the server's alone. The timer works with the owner's sealed sign-in (`background.py`), verified the same way.
  (Until 16 November 2026 the data was in Firestore and the server held no database credentials; the owner
  agreed to this change.)
- Secrets live in the server's environment only: never in the repository, the browser, logs or release notes.
