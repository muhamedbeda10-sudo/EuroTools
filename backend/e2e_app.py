"""Local end-to-end helper: the real API with a stand-in for the Younit client."""
import json
import os
import time
from datetime import UTC, datetime
from datetime import time as clock_time
from decimal import Decimal
from pathlib import Path

from app.config import Settings
from app.data.younit import tick_quote
from app.main import create_app
from tests.test_broker import FakeBroker


class MovingYounit(FakeBroker):
    """Like the test double, but the live stream keeps ticking so a browser can watch it move.

    It also has a made-up brokerage account behind it, so the Real account page can be opened locally,
    and it takes orders: each one it is sent fills by half on the next look, then completely.
    """

    def orders(self, profile_id):
        rows = super().orders(profile_id)
        for order in self.book:   # move each open order along a step, so a browser can watch it fill
            if order["status"] == "Accepted":
                order.update(status="Partially Executed", executed_qty=max(order["qty"] // 2, 1), average=order["price"])
            elif order["status"] == "Partially Executed":
                order.update(status="Executed", executed_qty=order["qty"], average=order["price"])
        return rows

    def live(self, stocks, timeout=8.0):
        """Live prices that a script can move: write {"COMI": 33.5} to live.json in the data folder."""
        try:
            self.live_prices = {**self.live_prices, **json.loads((Path(os.environ.get("DATA_DIR", ".")) / "live.json").read_text())}
        except (OSError, ValueError):
            pass
        return super().live(stocks, timeout)

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


# The browser test must not depend on the hour it is run at: here it is always late morning of the latest session.
import app.broker as _broker  # noqa: E402
import app.data.calendar as _calendar  # noqa: E402
import app.data.feed as _feed  # noqa: E402
import app.data.market as _market  # noqa: E402
import app.main as _main  # noqa: E402
import app.real_auto as _real_auto  # noqa: E402
import app.real_orders as _real_orders  # noqa: E402
import app.services as _services  # noqa: E402
from app.data.feed import Feed, StoreDocs  # noqa: E402
from app.services import App  # noqa: E402
from app.store.sqlite_store import Store  # noqa: E402
from tests.test_feed import days  # noqa: E402

_started = datetime.now(UTC)
_session = datetime.combine(datetime.fromisoformat(days(1)[0]).date(), clock_time(11, 0), _calendar.CAIRO)


def _now():
    return _session + (datetime.now(UTC) - _started)


for _module in (_calendar, _feed, _market, _services, _broker, _real_orders, _real_auto):
    _module.cairo_now = _now
for _module in (_feed, _services, _main, _market, _real_orders, _real_auto, _broker):
    _module.market_open = lambda *a, **k: True

_younit = MovingYounit()
_younit.live_prices = {"COMI": 35.9, "TMGH": 45.9, "NEWCO": 55.9}
# A stock priced like the app's feed, one the broker prices differently, one partly unsettled, and a fund.
_younit.hold((1, "COMI", "Commercial International Bank", 120, 120, 33.4, 35.9), (2, "TMGH", "Talaat Moustafa Group", 300, 180, 47.25, 46.5),
             (3, "NEWCO", "A New Listing", 50, 50, 52.1, 55.9), (9001, None, "Money Market Fund", 250, 250, 1.52, 1.61))

# Real orders can be tried end to end here: the stand-in broker takes them, and no real broker is anywhere near.
_settings = Settings(broker_account_uids="local", live_trading_enabled=True)
_store = Store(_settings.data_dir / "egx.sqlite3")
app = create_app(_settings, _store, younit=_younit)


@app.post("/e2e/assistant-proposal")
def _assistant_proposal(body: dict):
    """What the assistant's propose_real_order tool does, for trying automatic orders locally without a model."""
    core = App(_store, _settings, {}, Feed(StoreDocs(_store)), _younit).bootstrap()
    core.real_account_allowed = True
    order = _real_orders.OrderIn(symbol=body["symbol"], side=body.get("side", "BUY"), qty=body["qty"], price=Decimal(str(body["price"])),
                                 reason=body.get("reason", "Tried locally: a breakout on volume, wrong under the stop."),
                                 stop_price=Decimal(str(body["stop"])) if body.get("stop") else None,
                                 target_price=Decimal(str(body["target"])) if body.get("target") else None)
    return _real_orders.propose(core, order, "assistant")
