"""Shared test setup."""
import pytest


@pytest.fixture(autouse=True)
def _no_request_pacing(monkeypatch):
    """The pause between feed requests protects the real feed's rate limit; tests have no feed to protect."""
    import app.data.feed as feed
    monkeypatch.setattr(feed, "REQUEST_GAP", 0.0)
