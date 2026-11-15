"""Local end-to-end helper: the real API with a stand-in for the Younit client."""
import time

from app.config import Settings
from app.data.younit import tick_quote
from app.main import create_app
from tests.test_feed import FakeYounit


class MovingYounit(FakeYounit):
    """Like the test double, but the live stream keeps ticking so a browser can watch it move."""

    def follow_stock(self, stock_id, max_seconds=240.0):
        price, started = 0.827, time.monotonic()
        while time.monotonic() - started < min(max_seconds, 8):   # short streams: exercises the reconnect too
            price = round(price + 0.001, 3)
            book = self.depth(stock_id)
            book["best_bid"], book["best_ask"] = price, round(price + 0.001, 3)
            yield {"quote": tick_quote({"m_LastTradePrice": str(price), "m_PercentChange": "1.25", "m_Change": "0.01",
                                        "m_TradedVolume": str(int(1e6 * price)), "m_TradesCount": "321",
                                        "m_DailyHighPrice": "0.9", "m_DailyLowPrice": "0.8"}), "depth": book}
            time.sleep(0.7)


app = create_app(Settings(), younit=MovingYounit())
