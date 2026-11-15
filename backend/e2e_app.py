"""Local end-to-end helper: the real API with a stand-in for the Younit client."""
from app.config import Settings
from app.main import create_app
from tests.test_feed import FakeYounit

app = create_app(Settings(), younit=FakeYounit())
