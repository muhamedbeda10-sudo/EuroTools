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


    def follow_market(self, stocks, index_ids=(), max_seconds=240.0):
        started, n = time.monotonic(), 0
        base = {s["symbol"]: 10.0 * s["stock_id"] for s in stocks}
        yield {"q": {sym: [p, 0.0, 1000.0] for sym, p in base.items()}, "i": {"1": [31000.0, 0.4]}}
        while time.monotonic() - started < min(max_seconds, 8):
            n += 1
            sym = sorted(base)[n % len(base)]
            base[sym] = round(base[sym] + (0.05 if n % 3 else -0.02), 3)
            yield {"q": {sym: [base[sym], round(n * 0.3 - 1, 2), 1000.0 + n * 50]}, "i": {"1": [31000.0 + n, 0.4 + n / 100]}}
            time.sleep(0.5)


# The browser test must not depend on the hour it is run at.
import app.data.feed as _feed  # noqa: E402
import app.main as _main  # noqa: E402
import app.services as _services  # noqa: E402

_feed.market_open = _services.market_open = _main.market_open = lambda *a, **k: True

app = create_app(Settings(), younit=MovingYounit())
