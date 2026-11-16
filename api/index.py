"""Vercel entry point for the API. vercel.json sends /api/* and /health here."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

# Deployed defaults. None of these values is a secret. The data is in Postgres: its address and password are
# DATABASE_URL, in the host's environment only. People sign in with Firebase, and the API verifies each sign-in
# itself before it reads anything (backend/app/identity.py). Setting STORE_BACKEND=firestore in the environment
# puts the API back on Firestore as it was before 16 November 2026, without what was written since.
# A preview deployment has no DATABASE_URL (it is given to Production only) and stays on Firestore, which is
# closed to writing: a preview can be looked at, not used. Production without DATABASE_URL does not start.
_production = os.environ.get("VERCEL_ENV", "production") == "production"
os.environ.setdefault("STORE_BACKEND", "postgres" if _production or os.environ.get("DATABASE_URL") else "firestore")
# Firestore is not asked anything any more (the owner's instruction, 16 November 2026, once their own data and the
# market prices had come over). An account the database has no row for is not let in, and one whose data was left
# in Firestore is refused with a plain message rather than given an empty account. FIREBASE_PROJECT_ID is still
# needed: it is what a sign-in is verified against.
os.environ.setdefault("MIGRATE_FROM_FIRESTORE", "false")
os.environ.setdefault("FIREBASE_PROJECT_ID", "eurotools-a1ea6")
os.environ.setdefault("FIREBASE_WEB_API_KEY", "AIzaSyA9XdUMM1KXbkthRnUGpgbqVnTjJbWWdlE")  # public by design
os.environ.setdefault("APP_ENV", "production")

from app.main import app  # noqa: E402,F401
