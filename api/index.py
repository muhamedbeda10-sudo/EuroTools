"""Vercel entry point for the API. vercel.json sends /api/* and /health here."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

# Deployed defaults. Neither value is a secret: the API holds no credentials and
# authorises every request with the caller's own Firebase sign-in token.
os.environ.setdefault("STORE_BACKEND", "firestore")
os.environ.setdefault("FIREBASE_PROJECT_ID", "eurotools-a1ea6")
os.environ.setdefault("APP_ENV", "production")

from app.main import app  # noqa: E402,F401
