"""The real brokerage account: reading it, who may, and the checks on what was read (no network)."""
import json
import re
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import broker
from app.assistant_tools import TOOLS
from app.config import Settings
from app.data.feed import Feed, StoreDocs
from app.data.younit import YounitClient, YounitError, YounitRateLimit
from app.main import create_app
from app.services import App
from app.store.sqlite_store import Store
from tests.test_feed import FakeYounit

TOKEN = httpx.Response(200, json={"accessToken": "t", "expiresIn": 3600, "tokenType": "Bearer"})

# The shape the broker really sends (captured by the official SDK's tests), plus the rows that need care:
# a fund, which arrives with an unusable code, and a position that was sold out.
POSITIONS = {"messages": None, "data": {"currency": "EGP", "stocksValue": 1213.07, "stocks": [
    {"securityID": 1, "ReuterID": "COMI.CA", "quantity": 10, "unSettledQty": 4, "quantiyValidForSale": 6, "frozenQty": 0,
     "averageCost": 100.0, "shortNameE": "Commercial Bank", "shortNameA": "البنك التجاري", "marketPrice": 103.6,
     "realizedProfit": 0, "unRealizedProfit": 36.0, "unRealizedProfitPercentage": 3.6, "totalValue": 1000.0,
     "holdingValue": 1036.0, "isFund": False, "isSuspended": False, "currencyShortName": "EGP"},
    {"securityID": 294, "reuterID": "east.ca", "quantity": 5, "unSettledQty": 0, "quantityValidForSale": 5, "frozenQty": "NaN",
     "averageCost": 38.269, "shortNameE": "Eastern Company", "marketPrice": 35.07, "unRealizedProfit": -15.995,
     "unRealizedProfitPercentage": -8.3592, "totalValue": 191.345, "holdingValue": 175.35, "isSuspended": True},
    {"securityID": 9001, "ReuterID": "'", "quantity": 1, "averageCost": 1.5, "shortNameE": "Some Income Fund",
     "marketPrice": 1.72, "holdingValue": 1.72, "isFund": False},
    {"securityID": 77, "ReuterID": "GONE.CA", "quantity": 0, "averageCost": 9.0, "marketPrice": 9.0, "holdingValue": 0},
    {"securityID": 78, "ReuterID": "ODD.CA", "quantity": "Infinity", "averageCost": 1.0},
    "garbage",
]}}
SUMMARY = {"messages": None, "data": {"ClientId": 424242, "marketId": 1, "totalCash": 5000.25, "totalStocks": 1213.07,
                                      "totalBalance": 6213.32, "realizedProfit": 12.5, "unRealizedProfit": 20.225,
                                      "unRealizedProfitPercentage": 1.69, "profitOrLoss": 0, "currencyShortName": "EGP"}}
HOLDER = {"data": {"accountCode": 1234567, "clientName": "Test Owner", "email": "owner@example.com", "mobile": "01000000000",
                   "investorCode": "INV-9"}}


def make_client(handler):
    YounitClient._tokens.clear()
    return YounitClient("tid-1", "key-1", transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _fresh():
    Feed.reset()
    broker.reset()
    yield
    Feed.reset()
    broker.reset()


# ---- the HTTP client -------------------------------------------------------------------
def test_client_reads_the_account_with_get_requests_only_and_names_the_market():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/public-keys/token":
            return TOKEN
        seen.append((req.method, req.url.path, dict(req.url.params)))
        return httpx.Response(200, json={"/api/portfolio/GetPortfolioSummary": SUMMARY, "/api/portfolio/GetStocksPortfolio": POSITIONS,
                                         "/api/account-utils/GetAccountInfo": HOLDER}[req.url.path])
    c = make_client(handler)

    assert c.account_summary() == {"cash": 5000.25, "stocks": 1213.07, "total": 6213.32, "realized": 12.5,
                                   "unrealized": 20.225, "unrealized_pct": 1.69, "currency": "EGP"}
    got = c.account_positions()
    assert got["stocks_value"] == 1213.07
    comi, east, fund = got["positions"]  # the sold-out row and the garbage are dropped
    assert comi == {"stock_id": 1, "symbol": "COMI", "name": "Commercial Bank", "qty": 10, "available": 6, "unsettled": 4,
                    "frozen": 0, "avg_cost": 100.0, "cost": 1000.0, "price": 103.6, "value": 1036.0, "unrealized": 36.0,
                    "unrealized_pct": 3.6, "suspended": False}
    assert (east["symbol"], east["suspended"], east["available"], round(east["cost"], 3)) == ("EAST", True, 5, 191.345)
    assert (fund["symbol"], fund["name"], fund["stock_id"], fund["unrealized"]) == (None, "Some Income Fund", 9001, None)
    # the profile carries contact details: only the name and the account number are kept
    assert c.account_holder() == {"name": "Test Owner", "account_code": "1234567"}
    # without the market the broker answers with zeros or an empty list, so it is always named
    assert seen == [("GET", "/api/portfolio/GetPortfolioSummary", {"marketId": "1"}),
                    ("GET", "/api/portfolio/GetStocksPortfolio", {"MarketId": "1"}),
                    ("GET", "/api/account-utils/GetAccountInfo", {})]


def test_client_tells_an_empty_account_from_an_unreadable_answer():
    def answers(body):
        return make_client(lambda req: TOKEN if "token" in req.url.path else httpx.Response(200, json=body))

    assert answers({"data": None}).account_positions() == {"positions": [], "stocks_value": None}
    assert answers({"data": {"stocks": None, "stocksValue": 0}}).account_positions() == {"positions": [], "stocks_value": 0.0}
    assert answers({"data": {"stocks": []}}).account_positions()["positions"] == []
    assert answers({"data": None}).account_holder() == {"name": None, "account_code": None}
    # a missing figure is "not given", never zero
    assert answers({"data": {"totalCash": 10}}).account_summary()["total"] is None

    with pytest.raises(YounitError, match=r"account summary could not be read: response is \{data, messages\}") as info:
        answers({"messages": ["x"], "data": None}).account_summary()
    with pytest.raises(YounitError, match="account summary could not be read") as info:
        answers({"data": {"balance": 987654.32}}).account_summary()
    assert "987654" not in str(info.value)  # field names only, never the figures
    with pytest.raises(YounitError, match="holdings could not be read"):
        answers({"data": {"stocks": "soon"}}).account_positions()
    with pytest.raises(YounitError, match=r"holdings could not be read: 1 entries with fields \[code, units\]") as info:
        answers({"data": {"stocks": [{"code": "COMI", "units": 31337}]}}).account_positions()
    assert "31337" not in str(info.value)


def test_the_look_at_the_account_only_reads():
    """Phase one's promise still holds for this module: showing the account sends nothing to the broker."""
    app_dir = Path(__file__).resolve().parent.parent / "app"
    looking = (app_dir / "broker.py").read_text()
    assert not re.search(r"place_limit_order|cancel_order|_change\(|\.post\(", looking)
    assert next(t for t in TOOLS if t.name == "real_account").kind == "read"


# ---- who may look ----------------------------------------------------------------------
def test_only_the_named_sign_ins_may_look():
    named = Settings(broker_account_uids=" owner-1, owner-2\n")
    assert broker.may_view(named, "owner-1", signed_in=True) and broker.may_view(named, "owner-2", signed_in=True)
    assert not broker.may_view(named, "someone-else", signed_in=True)
    assert not broker.may_view(named, "owner", signed_in=True)       # no partial matches
    assert not broker.may_view(named, None, signed_in=True) and not broker.may_view(named, "", signed_in=True)
    # nobody is named: nobody may look, whatever their role in the app
    assert not broker.may_view(Settings(), "an-administrator", signed_in=True)
    # a server without sign-in has nobody to name: it looks only when "local" is written, never by default
    assert not broker.may_view(Settings(), None, signed_in=False) and not broker.may_view(named, None, signed_in=False)
    assert broker.may_view(Settings(broker_account_uids="local"), None, signed_in=False)
    assert not broker.may_view(Settings(broker_account_uids="local"), "local", signed_in=True)   # not a user ID


# ---- the API ---------------------------------------------------------------------------
class FakeBroker(FakeYounit):
    """The feed stand-in, with an account behind it."""

    def __init__(self):
        super().__init__()
        self.listing.append({"symbol": "EAST", "name": "Eastern Company", "stock_id": 294})
        self.reads = []
        self.summary = {"cash": 5000.25, "stocks": 0.0, "total": 0.0, "realized": 12.5, "unrealized": None,
                        "unrealized_pct": None, "currency": "EGP"}
        self.positions = []
        # orders: what was sent, what the broker lists, and how it is told to answer
        self.power, self.profile, self.limits = 20000.0, 4242, {}
        self.sent, self.cancels, self.book, self.past = [], [], [], []
        self.order_error = self.cancel_error = None
        self.next_order = 54250949

    def buying_power(self, stock_id):
        self.reads.append("power")
        return {"profile_id": self.profile, "buying_power": self.power, "held": 0}

    def trading_limits(self, stock_id):
        self.reads.append("limits")
        return {"last": None, "min_price": None, "max_price": None, **self.limits.get(stock_id, {})}

    def place_limit_order(self, *, profile_id, stock_id, side, qty, price):
        self.sent.append({"profile_id": profile_id, "stock_id": stock_id, "side": side, "qty": qty, "price": price})
        if self.order_error is not None:
            raise self.order_error
        order_id, self.next_order = self.next_order, self.next_order + 1
        self.book.append({"order_id": order_id, "stock_id": stock_id, "symbol": None, "side": side, "qty": qty, "price": price,
                          "status": "Accepted", "executed_qty": 0, "average": None})
        return order_id

    def cancel_order(self, order_id, profile_id):
        self.cancels.append((order_id, profile_id))
        if self.cancel_error is not None:
            raise self.cancel_error
        next(o for o in self.book if o["order_id"] == order_id)["status"] = "Cancelled"

    def orders(self, profile_id):
        self.reads.append("orders")
        return [dict(o) for o in self.book]

    def order_history(self, profile_id):
        self.reads.append("history")
        return [dict(o) for o in self.past]

    def hold(self, *rows):
        """Rows of (stock_id, code, name, qty, available, avg_cost, price)."""
        self.positions = [{"stock_id": i, "symbol": code, "name": name, "qty": qty, "available": free, "unsettled": qty - free,
                           "frozen": 0, "avg_cost": avg, "cost": avg * qty, "price": price, "value": round(price * qty, 2),
                           "unrealized": round((price - avg) * qty, 2), "unrealized_pct": (price - avg) / avg * 100,
                           "suspended": False} for i, code, name, qty, free, avg, price in rows]
        value = sum(p["value"] for p in self.positions)
        self.summary = {**self.summary, "stocks": value, "total": self.summary["cash"] + value}

    def account_summary(self):
        self.reads.append("summary")
        if getattr(self, "error", None):
            raise self.error
        return dict(self.summary)

    def account_positions(self):
        self.reads.append("positions")
        return {"positions": [dict(p) for p in self.positions], "stocks_value": self.summary["stocks"]}

    def account_holder(self):
        self.reads.append("holder")
        return {"name": "Test Owner", "account_code": "1234567"}


def client(tmp_path, fake, **settings):
    settings = {"broker_account_uids": "local", **settings}
    app = create_app(Settings(data_dir=tmp_path, younit_trading_id="", younit_api_key="", **settings),
                     Store(tmp_path / "t.sqlite3"), younit=fake)
    return TestClient(app)


def last_price(c, symbol):
    return c.get(f"/api/v1/stocks/{symbol}").json()["quote"]["last"]


def test_the_account_is_shown_joined_to_the_apps_prices_and_checked(tmp_path):
    fake = FakeBroker()
    with client(tmp_path, fake) as c:
        c.post("/api/v1/data/refresh")
        comi, east = last_price(c, "COMI"), last_price(c, "EAST")
        # EAST is priced 5% away from the app's feed; the fund is not a stock the app knows; the broker's code
        # for COMI is unusable, so it is matched by the broker's own id
        fake.hold((1, None, "Commercial Bank", 10, 6, comi - 1, comi), (294, "EAST", "Eastern Co", 5, 5, east, round(east * 1.05, 2)),
                  (9001, None, "Some Income Fund", 3, 3, 1.5, 1.72))
        assert c.get("/api/v1/status").json()["real_account"] == {"connected": True, "allowed": True, "user_id": None}

        v = c.get("/api/v1/real-account").json()
        assert (v["mode"], v["read_only"], v["currency"]) == ("real", True, "EGP")
        assert v["holder"] == {"name": "Test Owner", "account": "•••567"}  # the account number is masked
        s = v["summary"]
        assert s["cash"] == 5000.25 and s["total"] == pytest.approx(5000.25 + s["stocks"]) and s["held_value"] == pytest.approx(s["stocks"])
        assert s["cash_weight_pct"] == pytest.approx(5000.25 / s["total"] * 100)

        rows = {h["symbol"] or h["name"]: h for h in v["holdings"]}
        assert list(rows) == ["EAST", "COMI", "Some Income Fund"]  # largest first
        assert rows["COMI"]["in_app"] and rows["COMI"]["name"] == "Commercial International Bank"
        assert (rows["COMI"]["qty"], rows["COMI"]["available"], rows["COMI"]["unsettled"]) == (10, 6, 4)
        assert rows["COMI"]["app_price"] == pytest.approx(comi) and not rows["COMI"]["price_differs"]
        assert rows["COMI"]["price_gap_pct"] == pytest.approx(0, abs=1e-6) and rows["COMI"]["app_price_as_of"]
        assert rows["EAST"]["price_differs"] and rows["EAST"]["price_gap_pct"] == pytest.approx(5, abs=0.1)
        fund = rows["Some Income Fund"]
        assert not fund["in_app"] and fund["symbol"] is None and fund["app_price"] is None and fund["value"] == 5.16
        assert sum(h["weight_pct"] for h in v["holdings"]) + s["cash_weight_pct"] == pytest.approx(100)

        checks = {k["label"]: k for k in v["checks"]}
        assert checks["Holdings against the broker's total"]["ok"] and checks["Total against cash plus stocks"]["ok"]
        assert not checks["Broker prices against the app's feed"]["ok"] and "EAST" in checks["Broker prices against the app's feed"]["detail"]
        assert any("Some Income Fund" in n for n in v["notes"]) and any("4 COMI" in n for n in v["notes"])

        # the paper portfolio is untouched: nothing read from the broker entered it
        paper = c.get("/api/v1/portfolio").json()
        assert paper["mode"] == "paper" and paper["holdings"] == [] and paper["summary"]["cash"] == 50000
        assert c.get("/api/v1/trades").json()["transactions"][0]["type"] == "DEPOSIT"


def test_figures_that_do_not_add_up_are_reported_not_hidden(tmp_path):
    fake = FakeBroker()
    with client(tmp_path, fake) as c:
        c.post("/api/v1/data/refresh")
        comi = last_price(c, "COMI")
        fake.hold((1, "COMI", "Commercial Bank", 10, 10, comi, comi))
        fake.summary.update(stocks=fake.summary["stocks"] + 500, total=999999.0)  # a holding is missing; the total is off
        checks = {k["label"]: k for k in c.get("/api/v1/real-account").json()["checks"]}
        assert not checks["Holdings against the broker's total"]["ok"]
        assert "may be incomplete" in checks["Holdings against the broker's total"]["detail"]
        assert not checks["Total against cash plus stocks"]["ok"]
        assert checks["Broker prices against the app's feed"]["ok"]

        broker.reset()
        fake.summary.update(stocks=None)
        fake.positions = []
        v = c.get("/api/v1/real-account").json()   # figures the broker left out: the account still reads, and says so
        assert v["holdings"] == [] and v["summary"]["cash"] == 5000.25 and v["summary"]["stocks"] is None
        assert [k["ok"] for k in v["checks"]] == [False, False]
        assert "no total" in v["checks"][0]["detail"] and "left out" in v["checks"][1]["detail"]

        broker.reset()
        fake.summary.update(stocks=0.0, total=5000.25)
        v = c.get("/api/v1/real-account").json()   # an account that simply holds nothing passes its checks
        assert [k["ok"] for k in v["checks"]] == [True, True] and v["summary"]["cash_weight_pct"] == 100


def test_one_reading_serves_several_looks_and_a_refresh_is_bounded(tmp_path, monkeypatch):
    fake = FakeBroker()
    clock = {"t": 1000.0}
    monkeypatch.setattr(broker.time, "monotonic", lambda: clock["t"])
    with client(tmp_path, fake) as c:
        assert c.get("/api/v1/real-account").status_code == 200
        assert c.get("/api/v1/real-account").json()["age_seconds"] == 0
        assert sorted(fake.reads) == ["holder", "positions", "summary"]
        clock["t"] += 4
        assert c.get("/api/v1/real-account?fresh=true").json()["age_seconds"] == 4   # too soon: the same reading
        clock["t"] += 2
        assert c.get("/api/v1/real-account?fresh=true").json()["age_seconds"] == 0   # a new one; the holder is not asked again
        assert sorted(fake.reads) == ["holder", "positions", "positions", "summary", "summary"]
        clock["t"] += broker.CACHE_SECONDS + 1
        c.get("/api/v1/real-account")
        assert fake.reads.count("summary") == 3 and fake.reads.count("holder") == 1


def test_who_is_refused_and_how_failures_are_reported(tmp_path):
    with client(tmp_path / "a", None) as c:  # no feed at all
        (tmp_path / "a").mkdir(exist_ok=True)
        assert c.get("/api/v1/status").json()["real_account"] == {"connected": False, "allowed": False, "user_id": None}
        assert c.get("/api/v1/real-account").status_code == 404

    fake = FakeBroker()
    (tmp_path / "b").mkdir()
    with client(tmp_path / "b", fake, broker_account_uids="") as c:  # nobody is named, so nobody looks
        assert c.get("/api/v1/status").json()["real_account"]["allowed"] is False
        res = c.get("/api/v1/real-account")
        assert res.status_code == 403 and "not enabled for this sign-in" in res.json()["detail"]
        assert fake.reads == []  # refused before the broker is asked anything

    fake = FakeBroker()
    (tmp_path / "c").mkdir()
    with client(tmp_path / "c", fake) as c:
        fake.error = YounitError("Younit request failed (HTTP 500)")
        res = c.get("/api/v1/real-account")
        assert res.status_code == 502 and res.json()["detail"] == "Younit request failed (HTTP 500)"
        fake.error = YounitRateLimit(30)
        res = c.get("/api/v1/real-account")
        assert res.status_code == 429 and res.headers["retry-after"] == "30"
        fake.error = None
        assert c.get("/api/v1/real-account").status_code == 200  # a failure is never remembered


def test_the_assistant_reads_the_account_only_for_its_owner(tmp_path):
    tool = next(t for t in TOOLS if t.name == "real_account")
    fake = FakeBroker()
    with client(tmp_path, fake) as c:
        c.post("/api/v1/data/refresh")
        comi = last_price(c, "COMI")
    fake.hold((1, "COMI", "Commercial Bank", 10, 6, comi - 1, comi))
    store = Store(tmp_path / "t.sqlite3")
    core = App(store, Settings(data_dir=tmp_path), {}, Feed(StoreDocs(store)), fake).bootstrap()

    out = tool.run(core, tool.args())   # built outside the API: not the owner until the API says so
    assert out["available"] is False and fake.reads == []

    core.real_account_allowed = True
    out = tool.run(core, tool.args())
    assert out["available"] is True and "REAL" in out["account"] and "look only" in out["read_only"]
    assert out["summary"]["cash"] == 5000.25 and out["holdings"][0]["symbol"] == "COMI" and out["holdings"][0]["available"] == 6
    text = json.dumps(out)
    assert "Test Owner" not in text and "567" not in text  # whose account it is stays out of the conversation
