"""Vercel entry point for the API. vercel.json sends /api/* and /health here."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

# Deployed defaults. None of these values is a secret. The data is in Postgres: its address and password are
# DATABASE_URL, in the host's environment only (given to Production; without it the API does not start, so a
# preview needs a database of its own). People sign in with Firebase Authentication, and the API verifies each
# sign-in itself before it reads anything (backend/app/identity.py): FIREBASE_PROJECT_ID is what it verifies against.
os.environ.setdefault("STORE_BACKEND", "postgres")
os.environ.setdefault("FIREBASE_PROJECT_ID", "eurotools-a1ea6")
os.environ.setdefault("FIREBASE_WEB_API_KEY", "AIzaSyA9XdUMM1KXbkthRnUGpgbqVnTjJbWWdlE")  # public by design
os.environ.setdefault("APP_ENV", "production")

from app.main import app  # noqa: E402,F401
