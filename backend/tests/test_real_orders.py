"""Real orders: what may be proposed, what stands between a proposal and the broker, and sending exactly once (no network)."""
import json
import re
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from app import assistant, broker, real_orders
from app.assistant_tools import BY_NAME, TOOLS, parse
from app.config import Settings
from app.data.calendar import CAIRO
from app.data.feed import Feed, StoreDocs
from app.data.younit import OrderRefused, OrderUncertain, YounitClient, YounitError, YounitRateLimit
from app.services import App
from app.store.sqlite_store import Store
from tests.test_broker import FakeBroker, client, last_price

OPEN = datetime(2026, 11, 15, 11, 0, tzinfo=CAIRO)        # a Sunday, mid-session
EVENING = datetime(2026, 11, 15, 18, 0, tzinfo=CAIRO)     # the same day, after the close
NEXT_DAY = datetime(2026, 11, 16, 11, 0, tzinfo=CAIRO)    # Monday, mid-session
ARMED = {"enabled": True, "max_order_value": 5000, "max_day_value": 8000, "max_day_orders": 3, "price_band_pct": 2, "symbols": []}


@pytest.fixture(autouse=True)
def _fresh():
    Feed.reset()
    broker.reset()
    real_orders.reset()
    yield
    Feed.reset()
    broker.reset()
    real_orders.reset()


@pytest.fixture()
def desk(tmp_path, monkeypatch):
    """The API with a broker behind it, the server's switch on, and a clock the test moves."""
    clock = {"now": OPEN}
    monkeypatch.setattr(real_orders, "cairo_now", lambda: clock["now"])
    fake = FakeBroker()
    with client(tmp_path, fake, live_trading_enabled=True) as c:
        c.post("/api/v1/data/refresh")
        fake.reads.clear()
        yield c, fake, clock


def arm(c, **change):
    res = c.put("/api/v1/real-orders/settings", json={**ARMED, **change})
    assert res.status_code == 200, res.text
    return res.json()


def an_order(**change):
    return {"symbol": "COMI", "side": "BUY", "qty": 10, "price": 35.9, "reason": "", **change}


def propose(c, **change):
    res = c.post("/api/v1/real-orders", json=an_order(**change))
    assert res.status_code == 201, res.text
    return res.json()


def approve(c, made, **change):
    return c.post(f"/api/v1/real-orders/{made['id']}/approve",
                  json={"symbol": made["symbol"], "side": made["side"], "qty": made["qty"], "price": made["price"], **change})


def audit(c):
    return [(a["action"], a["entity"]) for a in c.get("/api/v1/audit").json() if a["entity"].startswith("real_")]


# ---- the HTTP client -------------------------------------------------------------------
BODY = {"profileID": 4242, "stockID": 536, "orderCategory": 0, "operationType": 100, "quantity": 10, "price": 82.5,
        "orderExpireTermsID": 7, "orderVia": 8, "isMarketPrice": False, "executionInstructionId": 1, "isEdit": False}
PLACED = httpx.Response(200, json={"messages": [""], "status": 1, "data": {"result": True, "orderId": 54250949}})


def wire(*answers):
    """A client whose broker gives these answers in turn; returns it with the requests it made."""
    calls, queue, tokens = [], list(answers), {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/public-keys/token":
            tokens["n"] += 1
            return httpx.Response(200, json={"accessToken": f"t{tokens['n']}", "expiresIn": 3600, "tokenType": "Bearer"})
        calls.append((req.method, req.url.path, json.loads(req.content) if req.content else dict(req.url.params),
                      req.headers["authorization"]))
        answer = queue.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer
    YounitClient._tokens.clear()
    return YounitClient("tid-1", "key-1", transport=httpx.MockTransport(handler)), calls


def place(c, **change):
    return c.place_limit_order(**{"profile_id": 4242, "stock_id": 536, "side": "BUY", "qty": 10, "price": 82.5, **change})


def test_the_client_sends_the_brokers_own_order_shape_and_only_ever_a_day_limit_order():
    c, calls = wire(PLACED, PLACED)
    assert place(c) == 54250949
    assert place(c, side="SELL", qty=3, price=7.125) == 54250949
    # the body the broker's own SDK sends for a day limit order: nothing more, nothing less
    assert calls[0] == ("POST", "/api/v1/orders/normal", BODY, "Bearer t1")
    assert calls[1][2] == {**BODY, "operationType": 200, "quantity": 3, "price": 7.125}
    for _, _, body, _ in calls:   # never a market order, a hidden order, or one that outlives the day
        assert (body["isMarketPrice"], body["orderCategory"], body["orderExpireTermsID"]) == (False, 0, 7)

    # what is not an order never leaves
    c, calls = wire()
    for bad in ({"qty": 0}, {"qty": -5}, {"qty": True}, {"qty": 2.5}, {"price": 0}, {"price": -1}, {"price": float("nan")},
                {"price": float("inf")}, {"price": "82.5"}, {"side": "SHORT"}, {"side": "buy"}):
        with pytest.raises(YounitError, match="nothing was sent"):
            place(c, **bad)
    assert calls == []


def test_the_client_says_plainly_what_became_of_an_order_and_never_sends_it_twice():
    def outcome(*answers):
        c, calls = wire(*answers)
        with pytest.raises(YounitError) as info:
            place(c)
        return info.value, calls

    # the broker read it and said no: nothing was placed, and its own reason is kept
    for answer, reason in ((httpx.Response(200, json={"data": False, "messages": ["Insufficient funds"]}), "Insufficient funds"),
                           (httpx.Response(200, json={"data": {"result": False}, "messages": ["Price out of range", "", "x"]}), "Price out of range; x"),
                           (httpx.Response(400, json={"messages": ["Market not allow Expiry Term : GoodTillCrossing"]}), "GoodTillCrossing"),
                           (httpx.Response(403, json={}), "HTTP 403")):
        error, calls = outcome(answer)
        assert isinstance(error, OrderRefused) and reason in str(error) and len(calls) == 1

    # it was sent and no clear answer came back: doubtful, and not repeated
    for answer in (httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("cut"), httpx.Response(500, json={"messages": ["boom"]}),
                   httpx.Response(502), httpx.Response(200, json={"data": {"result": True}, "messages": []}),
                   httpx.Response(200, json={"data": True}), httpx.Response(200, text="OK")):
        error, calls = outcome(answer)
        assert isinstance(error, OrderUncertain) and len(calls) == 1, answer

    # it never left: not doubtful, and not repeated either
    for answer in (httpx.ConnectError("down"), httpx.ConnectTimeout("down")):
        error, calls = outcome(answer)
        assert not isinstance(error, (OrderUncertain, OrderRefused)) and "nothing was sent" in str(error) and len(calls) == 1
    error, calls = outcome(httpx.Response(429))
    assert isinstance(error, YounitRateLimit) and len(calls) == 1

    # a refused sign-in comes before the broker looks at the request: sign in again and send it once more, only then
    c, calls = wire(httpx.Response(401), PLACED)
    assert place(c) == 54250949 and [x[3] for x in calls] == ["Bearer t1", "Bearer t2"]
    error, calls = outcome(httpx.Response(401), httpx.Response(401))
    assert not isinstance(error, OrderUncertain) and "nothing was sent" in str(error) and len(calls) == 2
    assert "key-1" not in str(error) and "tid-1" not in str(error)


def test_the_client_cancels_and_reads_orders_buying_power_and_price_limits():
    c, calls = wire(httpx.Response(200, json={"data": True, "messages": []}),
                    httpx.Response(200, json={"data": False, "messages": ["Can't Edit Cancelled Order."]}))
    c.cancel_order(54250949, 4242)
    with pytest.raises(OrderRefused, match="Can't Edit Cancelled Order"):
        c.cancel_order(54250949, 4242)
    assert calls[0] == ("POST", "/api/v1/orders/normal/54250949/cancel", {"profileId": 4242}, "Bearer t1")

    rows = [{"OrderId": 54250949, "StockId": 536, "ProfileId": 4242, "Quantity": 10, "Price": 82.5, "OrderTypeName": "Buy",
             "ReuterId": "COMI.CA", "Status": "Accepted", "Average": 64.5, "ExecutedQty": 4},
            {"orderId": 7, "stockId": 2, "quantity": 5, "price": 9.1, "orderType": "Sell Order", "status": "Cancelled"},
            {"Status": "no id"}, "garbage"]
    c, calls = wire(httpx.Response(200, json=rows), httpx.Response(200, json={"data": rows}), httpx.Response(200, json={"data": None}))
    first = c.orders(4242)
    assert first == c.orders(4242) and c.orders(4242) == []
    assert first[0] == {"order_id": 54250949, "stock_id": 536, "symbol": "COMI", "side": "BUY", "qty": 10, "price": 82.5,
                        "status": "Accepted", "executed_qty": 4, "average": 64.5}
    assert (first[1]["order_id"], first[1]["side"], first[1]["status"], first[1]["executed_qty"]) == (7, "SELL", "Cancelled", 0)
    assert calls[0][:3] == ("POST", "/core-services/Orders", {"MarketId": 1, "ProfileIds": [4242], "GetFixOrders": False})

    c, calls = wire(httpx.Response(200, json={"data": [{"orderId": 9, "stockId": 536, "quantity": 2, "price": 80, "average": 79.9,
                                                        "status": "Rejected", "isRejected": True, "rejectReason": "Price limit",
                                                        "transactionType": "Buy"}]}))
    assert c.order_history(4242) == [{"order_id": 9, "stock_id": 536, "symbol": None, "side": "BUY", "qty": 2, "price": 80.0,
                                      "status": "Rejected", "executed_qty": 0, "average": 79.9, "rejected": True,
                                      "reject_reason": "Price limit"}]
    assert calls[0][:2] == ("GET", "/api/stocks/order-history/1/4242")

    c, calls = wire(httpx.Response(200, json={"data": {"profileID": 9, "title": "Cash", "rawValue": 1234.5, "value": "1,234.50",
                                                       "certificatesQuantityHolded": 3}}),
                    httpx.Response(200, json={"data": None}),
                    httpx.Response(200, json={"data": {"price": 82.4, "minPrice": 65.9, "maxPrice": 98.8}}),
                    httpx.Response(200, json={"data": {"price": 0, "minPrice": 0}}))
    assert c.buying_power(536) == {"profile_id": 9, "buying_power": 1234.5, "held": 3}
    with pytest.raises(YounitError, match="no trading profile"):
        c.buying_power(536)
    assert c.trading_limits(536) == {"last": 82.4, "min_price": 65.9, "max_price": 98.8}
    assert c.trading_limits(536) == {"last": None, "min_price": None, "max_price": None}   # zero means "not given"
    assert calls[0][:3] == ("GET", "/api/v1/trading/buying-power/normal/536", {"marketId": "1"})
    assert calls[2][:2] == ("GET", "/api/stocks/stock-trading-info/1/536")


# ---- who, and whether at all -----------------------------------------------------------
def test_real_orders_are_for_the_owner_and_off_until_switched_on_twice(tmp_path, monkeypatch):
    monkeypatch.setattr(real_orders, "cairo_now", lambda: OPEN)
    everything = [("get", "/api/v1/real-orders", None), ("get", "/api/v1/real-orders/settings", None),
                  ("put", "/api/v1/real-orders/settings", ARMED), ("post", "/api/v1/real-orders/check", an_order()),
                  ("post", "/api/v1/real-orders", an_order()), ("post", "/api/v1/real-orders/202611abcdef0123/check", None),
                  ("post", "/api/v1/real-orders/202611abcdef0123/approve", {"symbol": "COMI", "side": "BUY", "qty": 1, "price": 1}),
                  ("post", "/api/v1/real-orders/202611abcdef0123/decline", None),
                  ("post", "/api/v1/real-orders/202611abcdef0123/cancel", None),
                  ("post", "/api/v1/real-orders/202611abcdef0123/not-placed", None)]

    # not the owner: every door is shut, before the broker is asked anything
    fake = FakeBroker()
    with client(tmp_path / "a", fake, live_trading_enabled=True, broker_account_uids="") as c:
        for method, path, body in everything:
            res = c.request(method, path, json=body)
            assert res.status_code == 403, (path, res.text)
        assert c.get("/api/v1/status").json()["real_orders"] == {"allowed": False, "ready": False, "waiting": 0}
        assert fake.reads == [] and fake.sent == []

    # no broker connection at all
    with client(tmp_path / "b", None, live_trading_enabled=True) as c:
        assert c.get("/api/v1/real-orders").status_code == 404

    # the owner, but the server's switch is off (the default): limits can be written, nothing can be prepared or sent
    fake = FakeBroker()
    with client(tmp_path / "c", fake) as c:
        c.post("/api/v1/data/refresh")
        assert c.get("/api/v1/status").json()["live_trading_enabled"] is False
        saved = arm(c)
        assert (saved["server_on"], saved["owner_on"], saved["ready"]) == (False, True, False) and "LIVE_TRADING_ENABLED" in saved["why_not"]
        res = c.post("/api/v1/real-orders", json=an_order())
        assert res.status_code == 422 and "switched off on the server" in res.json()["detail"]
        assert c.get("/api/v1/real-orders").json()["waiting"] == [] and fake.sent == []

    # the server's switch is on, the owner's is not (the default): the same
    fake = FakeBroker()
    with client(tmp_path / "d", fake, live_trading_enabled=True) as c:
        c.post("/api/v1/data/refresh")
        start = c.get("/api/v1/real-orders/settings").json()
        assert start["limits"]["enabled"] is False and start["ready"] is False and "Settings" in start["why_not"]
        assert c.post("/api/v1/real-orders", json=an_order()).status_code == 422
        # it cannot be switched on without limits, and a limit per order cannot exceed the limit per day
        for bad in ({"max_order_value": None}, {"max_day_value": None}, {"max_day_orders": None}):
            assert c.put("/api/v1/real-orders/settings", json={**ARMED, **bad}).status_code == 422
        assert c.put("/api/v1/real-orders/settings", json={**ARMED, "max_order_value": 9000}).status_code == 422
        assert c.put("/api/v1/real-orders/settings", json={**ARMED, "symbols": ["NOSUCH"]}).status_code == 422
        for bad in ({"max_order_value": 0}, {"max_day_orders": 0}, {"price_band_pct": 50}, {"surprise": 1}):
            assert c.put("/api/v1/real-orders/settings", json={**ARMED, **bad}).status_code == 422
        assert c.get("/api/v1/real-orders/settings").json()["limits"]["enabled"] is False   # nothing of that was kept
        ready = arm(c, symbols=["comi", " TMGH "])
        assert ready["ready"] is True and ready["why_not"] is None and ready["limits"]["symbols"] == ["COMI", "TMGH"]
        assert c.get("/api/v1/status").json()["real_orders"] == {"allowed": True, "ready": True, "waiting": 0}
        assert ("update", "real_trading_settings") in audit(c)
        # switching it off again stops everything at once
        arm(c, enabled=False)
        assert c.post("/api/v1/real-orders", json=an_order()).status_code == 422 and fake.sent == []


# ---- proposals -------------------------------------------------------------------------
def test_a_proposal_is_words_until_it_is_approved(desk):
    c, fake, clock = desk
    arm(c)
    made = propose(c, reason="Above its 50-day average on rising volume.")
    assert (made["status"], made["origin"], made["symbol"], made["side"], made["qty"], made["price"], made["value"]) == \
           ("proposed", "manual", "COMI", "BUY", 10, 35.9, 359.0)
    assert made["session"] == "2026-11-15" and made["broker"] is None and not made["can_cancel"]
    assert made["checked"]["facts"]["buying_power"] == 20000.0 and made["checked"]["facts"]["reference_price"] == pytest.approx(35.9)
    assert fake.sent == []                                                     # nothing went anywhere

    v = c.get("/api/v1/real-orders").json()
    assert [w["id"] for w in v["waiting"]] == [made["id"]] and v["orders"] == [] and v["today"] == {"orders": 0, "value": 0}
    assert c.get("/api/v1/status").json()["real_orders"]["waiting"] == 1
    # the same order twice is one order
    assert "already waiting" in c.post("/api/v1/real-orders", json=an_order()).json()["detail"]
    # a different one is fine, and declining takes it off the list for good
    other = propose(c, symbol="TMGH", side="BUY", qty=5, price=45.9)
    assert c.post(f"/api/v1/real-orders/{other['id']}/decline").json()["status"] == "declined"
    assert c.post(f"/api/v1/real-orders/{other['id']}/decline").status_code == 422
    assert approve(c, other).status_code == 422 and fake.sent == []            # a declined proposal cannot be sent
    assert c.get("/api/v1/status").json()["real_orders"]["waiting"] == 1
    assert audit(c)[:3] == [("decline", "real_order"), ("propose", "real_order"), ("propose", "real_order")]

    # the paper portfolio knows nothing of any of it
    paper = c.get("/api/v1/portfolio").json()
    assert paper["holdings"] == [] and paper["summary"]["cash"] == 50000
    assert c.get("/api/v1/trades").json()["totals"]["count"] == 0
    assert c.get("/api/v1/real-orders/000000zzzzzzzzzz/check").status_code in (404, 405)
    assert c.post("/api/v1/real-orders/nonsense/decline").status_code == 404


def test_every_check_names_what_stands_in_the_way(desk):
    c, fake, clock = desk
    arm(c)
    fake.hold((1, "COMI", "Commercial Bank", 100, 60, 30.0, 35.9))

    def stopped(**change):
        res = c.post("/api/v1/real-orders/check", json=an_order(**change)).json()
        assert res["ok"] is False, res
        assert c.post("/api/v1/real-orders", json=an_order(**change)).status_code == 422   # and it cannot be written down either
        return " ".join(res["problems"])

    ok = c.post("/api/v1/real-orders/check", json=an_order()).json()
    assert ok["ok"] and ok["problems"] == [] and ok["facts"]["value"] == 359.0 and ok["facts"]["est_fees"] > 0
    assert ok["facts"]["day"] == {"orders": 0, "value": 0} and ok["facts"]["market_open"] is True
    assert any("placeholder" in n for n in ok["notes"])                        # the fee schedule was never verified

    assert "limit per order is 5,000.00" in stopped(qty=200)                   # 7,180
    assert "not a stock the broker lists" in stopped(symbol="NOSUCH")
    assert "at most three decimals" in stopped(price=35.9001)
    # the costly side of the market is fenced; the other side is not (such an order simply waits)
    assert "2.5% above the market" in stopped(price=36.8)
    assert "below the market" in stopped(side="SELL", price=34.9)
    assert c.post("/api/v1/real-orders/check", json=an_order(price=30)).json()["ok"]
    assert c.post("/api/v1/real-orders/check", json=an_order(side="SELL", price=40)).json()["ok"]
    # the broker's own facts
    fake.power = 300.0
    assert "the broker says 300.00 can be spent" in stopped()
    fake.power = 359.5                                                         # the price is covered, the fees are not
    assert "with fees" in stopped()
    fake.power = None
    assert "did not say how much can be spent" in stopped()
    fake.power = 20000.0
    assert "60 of the 100 held are free to sell" in stopped(side="SELL", qty=61)
    assert c.post("/api/v1/real-orders/check", json=an_order(side="SELL", qty=60)).json()["ok"]
    assert "holds no TMGH" in stopped(symbol="TMGH", side="SELL", qty=1, price=45.9)
    fake.limits[1] = {"min_price": 36.0, "max_price": 43.0}
    assert "accepts no price under 36" in stopped()
    fake.limits[1] = {"min_price": 30.0, "max_price": 35.0}
    assert "accepts no price over 35" in stopped()
    fake.limits[1] = {"last": 40.0}                                            # the broker's own price wins over the app's
    assert c.post("/api/v1/real-orders/check", json=an_order(price=40.5)).json()["facts"]["reference_price"] == 40.0
    fake.limits.clear()
    # a broker that cannot be asked means no order
    fake.buying_power = lambda stock_id: (_ for _ in ()).throw(YounitError("Younit request failed (HTTP 500)"))
    assert "could not be asked" in stopped()
    del fake.buying_power
    # the stocks the owner allows
    arm(c, symbols=["TMGH"])
    assert "not among the stocks allowed" in stopped()
    assert fake.sent == []


# ---- sending ---------------------------------------------------------------------------
def test_approval_sends_the_order_once_with_the_figures_that_were_approved(desk):
    c, fake, clock = desk
    arm(c)
    made = propose(c)
    look = c.post(f"/api/v1/real-orders/{made['id']}/check").json()            # the last look, as on sending
    assert look["ok"] and look["order"]["id"] == made["id"] and fake.sent == []

    # what was on screen must be what is stored, or nothing goes out
    for other in ({"qty": 11}, {"price": 35.8}, {"side": "SELL"}, {"symbol": "TMGH"}):
        assert approve(c, made, **other).status_code == 409
    assert fake.sent == []

    fake.reads.clear()
    sent = approve(c, made)
    assert sent.status_code == 200, sent.text
    sent = sent.json()
    assert fake.sent == [{"profile_id": 4242, "stock_id": 1, "side": "BUY", "qty": 10, "price": 35.9}]
    assert sent["status"] == "sent" and sent["broker"]["order_id"] == 54250949 and sent["can_cancel"] is True
    assert (sent["broker"]["status"], sent["broker"]["state"]) == ("Accepted", "open")   # the broker's own word, read back
    assert {"power", "limits"} <= set(fake.reads)                              # checked against fresh figures first

    # a second yes finds nothing to send
    assert approve(c, made).status_code == 422 and len(fake.sent) == 1
    v = c.get("/api/v1/real-orders").json()
    assert v["waiting"] == [] and v["orders"][0]["id"] == made["id"] and v["today"] == {"orders": 1, "value": 359.0}
    assert c.get("/api/v1/status").json()["real_orders"]["waiting"] == 0
    assert audit(c)[:3] == [("send", "real_order"), ("approve", "real_order"), ("propose", "real_order")]
    log = c.get("/api/v1/audit").json()[0]["detail"]
    assert log["broker_order_id"] == 54250949 and (log["symbol"], log["side"], log["qty"]) == ("COMI", "BUY", 10)
    assert c.get("/api/v1/portfolio").json()["holdings"] == []                 # the paper ledger is untouched

    # the look at the account is taken afresh after an order went out
    fake.reads.clear()
    c.get("/api/v1/real-account")
    assert "summary" in fake.reads


def test_the_last_look_is_binding_time_limits_and_figures_are_judged_at_approval(desk):
    c, fake, clock = desk
    arm(c)
    # written after the close: it is for tomorrow's session, and cannot be sent tonight
    clock["now"] = EVENING
    made = propose(c)
    assert made["session"] == "2026-11-16" and any("market is closed" in n for n in made["checked"]["notes"])
    res = approve(c, made)
    assert res.status_code == 422 and "market is closed" in res.json()["detail"] and fake.sent == []
    assert c.post(f"/api/v1/real-orders/{made['id']}/check").json()["ok"] is False

    # next morning: the figures of that moment decide, not those of last night
    clock["now"] = NEXT_DAY
    fake.limits[1] = {"last": 34.0}                                            # it opened lower: 35.9 is now 5.6% above the market
    res = approve(c, made)
    assert res.status_code == 422 and "above the market" in res.json()["detail"] and fake.sent == []
    fake.limits.clear()
    arm(c, max_order_value=300)                                                # the owner tightened the limit in the meantime
    assert "limit per order" in approve(c, made).json()["detail"] and fake.sent == []
    arm(c)
    assert approve(c, made).json()["status"] == "sent" and len(fake.sent) == 1

    # the day's limits count what was sent, and stop the next one at approval even if it was fine when written
    second = propose(c, symbol="TMGH", qty=5, price=45.9)                      # 229.50
    third = propose(c, symbol="NEWCO", qty=5, price=55.9)                      # 279.50
    arm(c, max_day_orders=2)
    assert approve(c, second).json()["status"] == "sent"
    res = approve(c, third)
    assert res.status_code == 422 and "limit is 2 a day" in res.json()["detail"]
    arm(c, max_day_orders=3, max_day_value=800, max_order_value=800)           # 359 + 229.5 sent; 279.5 more would be 868
    assert "limit per day is 800.00" in approve(c, third).json()["detail"]
    assert len(fake.sent) == 2 and c.get("/api/v1/real-orders").json()["today"] == {"orders": 2, "value": 588.5}

    # a proposal left undecided goes with its session
    clock["now"] = NEXT_DAY + timedelta(hours=7)
    v = c.get("/api/v1/real-orders").json()
    assert v["waiting"] == [] and next(o for o in v["orders"] if o["id"] == third["id"])["status"] == "expired"
    assert approve(c, third).status_code == 422 and len(fake.sent) == 2
    assert ("expire", "real_order") in audit(c)


def test_what_the_broker_answers_is_recorded_and_a_doubtful_order_is_never_sent_again(desk):
    c, fake, clock = desk
    arm(c)

    # the broker says no: nothing was placed, its reason is kept, and the day's limits are not used up
    fake.order_error = OrderRefused("Insufficient funds")
    gone = approve(c, propose(c)).json()
    assert (gone["status"], gone["status_note"], gone["broker"]["order_id"]) == ("rejected", "Insufficient funds", None)
    # the request never left
    fake.order_error = YounitError("cannot reach Younit (ConnectError); nothing was sent")
    lost = approve(c, propose(c, qty=11)).json()
    assert lost["status"] == "failed" and "nothing was sent" in lost["status_note"]
    assert c.get("/api/v1/real-orders").json()["today"] == {"orders": 0, "value": 0}
    assert len(fake.sent) == 2 and audit(c)[0] == ("fail", "real_order")

    # it left and no answer came back
    fake.order_error = OrderUncertain("no answer came back from Younit (ReadTimeout)")
    doubt = approve(c, propose(c, qty=12)).json()
    assert doubt["status"] == "unknown" and doubt["in_doubt"] and "has not been sent again" in doubt["status_note"]
    assert c.get("/api/v1/real-orders").json()["today"] == {"orders": 1, "value": 430.8}   # it may be there: it counts
    fake.order_error = None
    # while it is in doubt, no other order for that stock and side can go out; the other side and other stocks can
    blocked = c.post("/api/v1/real-orders", json=an_order(qty=1))
    assert blocked.status_code == 422 and "may or may not have reached the broker" in blocked.json()["detail"]
    assert propose(c, symbol="TMGH", qty=1, price=45.9)["status"] == "proposed"
    assert len(fake.sent) == 3                                                  # and it was not sent a second time by anything

    # the owner looked at the broker's own app: it is not there
    assert c.post(f"/api/v1/real-orders/{gone['id']}/not-placed").status_code == 422   # only a doubtful order can be settled so
    settled = c.post(f"/api/v1/real-orders/{doubt['id']}/not-placed").json()
    assert settled["status"] == "not_placed" and not settled["in_doubt"]
    assert c.get("/api/v1/real-orders").json()["today"] == {"orders": 0, "value": 0}
    assert propose(c, qty=1)["status"] == "proposed"

    # another doubtful one. An order just like it was at the broker BEFORE this one was sent (placed by hand in
    # the broker's own app): that one is never taken for ours.
    fake.book.append({"order_id": 600, "stock_id": 3, "symbol": "NEWCO", "side": "BUY", "qty": 4, "price": 55.9,
                      "status": "Accepted", "executed_qty": 0, "average": None})
    fake.order_error = OrderUncertain("Younit answered with a server error (HTTP 502)")
    doubt = approve(c, propose(c, symbol="NEWCO", qty=4, price=55.9)).json()
    assert doubt["status"] == "unknown"
    fake.order_error = None
    real_orders.reset()
    assert next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == doubt["id"])["status"] == "unknown"
    # and this time the broker's list shows a new one: it was placed after all
    fake.book.append({"order_id": 777, "stock_id": 3, "symbol": "NEWCO", "side": "BUY", "qty": 4, "price": 55.9,
                      "status": "Accepted", "executed_qty": 0, "average": None})
    fake.book.append({"order_id": 778, "stock_id": 3, "symbol": "NEWCO", "side": "SELL", "qty": 4, "price": 55.9,   # not it
                      "status": "Accepted", "executed_qty": 0, "average": None})
    real_orders.reset()
    found = next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == doubt["id"])
    assert (found["status"], found["broker"]["order_id"], found["broker"]["state"]) == ("sent", 777, "open")
    assert "Found in the broker's list" in found["status_note"] and found["can_cancel"]
    res = c.post(f"/api/v1/real-orders/{doubt['id']}/not-placed")                # it is not in doubt any more
    assert res.status_code == 422 and "it was placed" in res.json()["detail"]

    # when the broker's list could not be read before sending, nothing is ever taken for a doubtful order,
    # and it cannot be closed as "not placed" while the app itself cannot look
    listing, fake.orders = fake.orders, lambda profile_id: (_ for _ in ()).throw(YounitError("Younit took too long to answer"))
    fake.order_error = OrderUncertain("no answer came back from Younit (ReadTimeout)")
    blind = approve(c, propose(c, symbol="TMGH", qty=2, price=45.9)).json()
    assert blind["status"] == "unknown"
    fake.order_error = None
    res = c.post(f"/api/v1/real-orders/{blind['id']}/not-placed")
    assert res.status_code == 422 and "could not be read just now" in res.json()["detail"]
    fake.orders = listing
    fake.book.append({"order_id": 888, "stock_id": 2, "symbol": "TMGH", "side": "BUY", "qty": 2, "price": 45.9,
                      "status": "Accepted", "executed_qty": 0, "average": None})
    real_orders.reset()
    assert next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == blind["id"])["status"] == "unknown"
    assert c.post(f"/api/v1/real-orders/{blind['id']}/not-placed").json()["status"] == "not_placed"


def test_a_send_that_never_reported_back_is_found_or_settled(tmp_path, monkeypatch):
    clock = {"now": OPEN}
    monkeypatch.setattr(real_orders, "cairo_now", lambda: clock["now"])
    fake = FakeBroker()
    with client(tmp_path, fake, live_trading_enabled=True) as c:
        c.post("/api/v1/data/refresh")
        arm(c)
        made = propose(c)
        # as if the server had stopped right after recording the yes: the record says "sending" and nothing else
        store = Store(tmp_path / "t.sqlite3")
        coll = f"real_orders_{made['id'][:6]}"
        rec = store.get(coll, made["id"])
        rec.update(status="sending", approved_at=assistant.now_iso(), sent_day="2026-11-15",
                   broker={"profile_id": 4242, "order_id": None, "status": None, "state": None, "executed_qty": 0,
                           "average": None, "seen_at": None})
        store.put(coll, made["id"], rec)

        now = next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == made["id"])
        assert now["status"] == "sending" and now["in_doubt"]                  # just now: give it a moment
        assert c.post(f"/api/v1/real-orders/{made['id']}/not-placed").status_code == 422
        assert approve(c, made).status_code == 422 and fake.sent == []          # and it cannot be sent "again"

        rec["approved_at"] = (datetime.fromisoformat(assistant.now_iso()) - timedelta(minutes=5)).isoformat()
        store.put(coll, made["id"], rec)
        later = next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == made["id"])
        assert later["status"] == "unknown" and "interrupted" in later["status_note"]
        assert c.post("/api/v1/real-orders", json=an_order(qty=2)).status_code == 422   # same stock, same side: wait
        assert c.post(f"/api/v1/real-orders/{made['id']}/not-placed").json()["status"] == "not_placed"
        assert fake.sent == []


def test_fills_are_followed_and_an_open_order_can_be_cancelled(desk):
    c, fake, clock = desk
    arm(c)
    fake.hold((1, "COMI", "Commercial Bank", 100, 100, 30.0, 35.9))
    sell = approve(c, propose(c, side="SELL", qty=40, price=36.2)).json()
    assert sell["status"] == "sent" and fake.sent[-1]["side"] == "SELL"
    order = fake.book[0]

    def seen():
        real_orders.reset()
        return next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == sell["id"])

    order.update(status="Partially Executed", executed_qty=15, average=36.2)
    part = seen()
    assert (part["broker"]["state"], part["broker"]["executed_qty"], part["broker"]["average"], part["can_cancel"]) == ("partial", 15, 36.2, True)
    order.update(status="Some New Word")                                       # an unfamiliar word is shown as it is
    assert seen()["broker"]["status"] == "Some New Word"
    # a word in between does not end the order: it is still followed, and still cancellable
    for word in ("Pending Cancel", "Cancel Rejected", "Cancel Requested"):
        order.update(status=word)
        now = seen()
        assert (now["broker"]["status"], now["broker"]["state"], now["can_cancel"]) == (word, "partial", True)
    # and a state read today is read again at every look, so a word that turns out to mean something else corrects itself
    order.update(status="Cancelled")
    assert seen()["broker"]["state"] == "cancelled"
    order.update(status="Partially Executed", executed_qty=20)
    assert (seen()["broker"]["state"], seen()["broker"]["executed_qty"]) == ("partial", 20)

    # cancelling what is still open: allowed even with the owner's switch off, since it only reduces what is at stake
    arm(c, enabled=False)
    fake.cancel_error = OrderRefused("Can't Edit Cancelled Order.")
    res = c.post(f"/api/v1/real-orders/{sell['id']}/cancel")
    assert res.status_code == 422 and "Can't Edit Cancelled Order" in res.json()["detail"]
    fake.cancel_error = None
    done = c.post(f"/api/v1/real-orders/{sell['id']}/cancel").json()
    assert fake.cancels[-1] == (order["order_id"], 4242) and done["cancel"]["outcome"] == "accepted"
    assert (done["broker"]["state"], done["can_cancel"]) == ("cancelled", False)
    assert c.post(f"/api/v1/real-orders/{sell['id']}/cancel").status_code == 422   # nothing left to cancel
    assert ("cancel", "real_order") in audit(c)

    # an order that filled completely, then drops off the broker's current list and is found in its history
    arm(c)
    buy = approve(c, propose(c, qty=6)).json()
    fake.past.append({**fake.book.pop(), "status": "Executed", "executed_qty": 6, "average": 35.85, "rejected": False, "reject_reason": None})
    real_orders.reset()
    filled = next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == buy["id"])
    assert (filled["broker"]["state"], filled["broker"]["average"], filled["can_cancel"]) == ("filled", 35.85, False)
    assert c.post(f"/api/v1/real-orders/{buy['id']}/cancel").status_code == 422
    # the broker's list failing is said, and the last known states stay on screen
    fake.orders = lambda profile_id: (_ for _ in ()).throw(YounitError("Younit took too long to answer"))
    third = approve(c, propose(c, qty=7)).json()
    real_orders.reset()
    v = c.get("/api/v1/real-orders").json()
    assert "could not be read just now" in v["sync_problem"] and next(o for o in v["orders"] if o["id"] == third["id"])["status"] == "sent"


def test_the_brokers_words_are_read_cautiously():
    def state(status, executed=0, qty=10, **more):
        return real_orders._state({"status": status, "executed_qty": executed, **more}, qty)

    assert [state(w) for w in ("Accepted", "Open", "Queued", None, "", "Some New Word")] == ["open"] * 6
    assert state("Partially Executed", 4) == "partial" and state("Accepted", 4) == "partial" and state("Partially Filled") == "partial"
    assert state("Executed", 10) == "filled" and state("Accepted", 10) == "filled" and state("Executed") == "filled"
    assert state("Executed", 4) == "partial"                                    # the count is believed over the word
    assert state("Cancelled") == "cancelled" and state("Canceled", 3) == "cancelled"
    assert state("Rejected") == "rejected" and state("Accepted", rejected=True) == "rejected" and state("Expired", 6) == "expired"
    # in between, or the opposite of what one word in it suggests: the order is not over
    assert [state(w) for w in ("Pending Cancel", "Cancel Requested", "Cancel Rejected", "Pending New", "Not Executed",
                               "Not Cancelled", "Waiting Approval")] == ["open"] * 7


def test_two_yeses_at_once_on_one_server_send_one_order(desk):
    """Where the store cannot refuse a stale write (a local run), approvals take turns, and the second finds nothing to send."""
    import threading
    import time as clock_module
    c, fake, clock = desk
    arm(c, max_day_orders=1)
    one, two = propose(c), propose(c, symbol="TMGH", qty=5, price=45.9)
    asked = fake.buying_power

    def slow(stock_id):
        clock_module.sleep(0.25)          # long enough for the other yes to arrive meanwhile
        return asked(stock_id)
    fake.buying_power = slow

    def together(*orders):
        results = []
        threads = [threading.Thread(target=lambda o=o: results.append(approve(c, o))) for o in orders]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return sorted(r.status_code for r in results)

    assert together(one, one, one) == [200, 422, 422] and len(fake.sent) == 1   # the same proposal, three times
    arm(c, max_day_orders=2)
    three = propose(c, symbol="NEWCO", qty=2, price=55.9)
    assert together(two, three) == [200, 422] and len(fake.sent) == 2           # two proposals, one left of the day's limit
    assert c.get("/api/v1/real-orders").json()["today"]["orders"] == 2


def test_an_order_that_went_out_is_never_reported_as_not_sent(desk, monkeypatch):
    """If the record cannot be written after the broker took the order, the answer still says what happened."""
    from app.store.errors import ConflictError
    c, fake, clock = desk
    arm(c)
    made = propose(c)
    real_put, failing = real_orders._put, {"on": False}

    def put(core, rec):
        if failing["on"] and rec["status"] != "sending":
            raise ConflictError("the data changed in another window; reload and try again")
        return real_put(core, rec)
    monkeypatch.setattr(real_orders, "_put", put)
    failing["on"] = True
    res = approve(c, made)
    assert res.status_code == 200 and len(fake.sent) == 1                       # not a 409, which would read as "nothing was sent"
    out = res.json()
    assert out["status"] == "sent" and out["broker"]["order_id"] == 54250949 and "could not be written" in out["status_note"]
    failing["on"] = False
    # the record was left at "sending"; it cannot be sent a second time, and it is settled from the broker's own list
    assert approve(c, made).status_code == 422 and len(fake.sent) == 1
    stuck = next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == made["id"])
    assert stuck["status"] == "sending" and stuck["in_doubt"]
    monkeypatch.setattr(real_orders, "STALE_SENDING_SECONDS", -1.0)             # as if two minutes had passed
    real_orders.reset()
    found = next(o for o in c.get("/api/v1/real-orders").json()["orders"] if o["id"] == made["id"])
    assert (found["status"], found["broker"]["order_id"]) == ("sent", 54250949)
    assert [a for a in audit(c) if a[0] in ("doubt", "settle")] == [("settle", "real_order"), ("doubt", "real_order")]


def test_what_waits_is_counted_as_of_now_and_an_interrupted_send_is_written_down(desk):
    c, fake, clock = desk
    arm(c)
    propose(c)
    propose(c, symbol="TMGH", qty=5, price=45.9)
    assert c.get("/api/v1/status").json()["real_orders"]["waiting"] == 2
    clock["now"] = NEXT_DAY                                                     # their session is over; nobody opened the page
    assert c.get("/api/v1/status").json()["real_orders"]["waiting"] == 0
    assert propose(c, symbol="NEWCO", qty=1, price=55.9)["session"] == "2026-11-16"
    assert c.get("/api/v1/status").json()["real_orders"]["waiting"] == 1


# ---- the assistant ---------------------------------------------------------------------
def test_the_assistant_can_propose_and_nothing_more(tmp_path, monkeypatch):
    monkeypatch.setattr(real_orders, "cairo_now", lambda: OPEN)
    fake = FakeBroker()
    with client(tmp_path, fake, live_trading_enabled=True) as c:
        c.post("/api/v1/data/refresh")
        comi = round(last_price(c, "COMI"), 3)
        store = Store(tmp_path / "t.sqlite3")
        settings = Settings(data_dir=tmp_path, live_trading_enabled=True)

        def run(name, *, owner=True, **args):
            core = App(store, settings, {}, Feed(StoreDocs(store)), fake).bootstrap()
            core.real_account_allowed = owner
            tool, parsed, problem = parse(name, args)
            assert problem is None, problem
            content, failed = assistant._execute(core, tool, parsed)
            return json.loads(content), failed

        why = "Closed above its 50-day average on twice the usual volume; wrong if it closes back under 34."
        # not the owner: nothing to see, nothing to write
        assert run("real_orders", owner=False)[0]["available"] is False
        out, failed = run("propose_real_order", owner=False, symbol="COMI", side="BUY", qty=10, limit_price=comi, reason=why)
        assert failed and fake.reads.count("power") == 0
        # the owner has not switched real orders on: the assistant is told so and writes nothing
        out, failed = run("propose_real_order", symbol="COMI", side="BUY", qty=10, limit_price=comi, reason=why)
        assert failed and "switched off in Settings" in out["error"]
        assert run("real_orders")[0]["can_propose_now"] is False

        arm(c)
        # a proposal needs its reasoning
        assert parse("propose_real_order", {"symbol": "COMI", "side": "BUY", "qty": 10, "limit_price": comi, "reason": "buy"})[2]
        out, failed = run("propose_real_order", symbol="comi", side="BUY", qty=10, limit_price=comi, reason=why)
        assert not failed and out["proposal"]["status"] == "proposed" and out["proposal"]["origin"] == "assistant"
        assert "Nothing was sent" in out["what_happens_next"] and "only the owner can approve" in out["what_happens_next"]
        assert fake.sent == []
        seen = run("real_orders")[0]
        assert seen["can_propose_now"] and [w["reason"] for w in seen["waiting_for_the_owner"]] == [why]
        # the owner's limits bind the assistant exactly as they bind the owner
        out, failed = run("propose_real_order", symbol="COMI", side="BUY", qty=500, limit_price=comi, reason=why)
        assert failed and "limit per order" in out["error"]
        # it can take its own proposal back, and nobody else's
        mine = out = run("propose_real_order", symbol="TMGH", side="BUY", qty=3, limit_price=45.9, reason=why)[0]["proposal"]
        assert run("withdraw_real_order_proposal", id=mine["id"])[0]["withdrawn"]["status"] == "withdrawn"
        owners = propose(c, symbol="NEWCO", qty=2, price=55.9)
        out, failed = run("withdraw_real_order_proposal", id=owners["id"])
        assert failed and "Only a proposal the assistant wrote" in out["error"]
        # its proposals are capped for a day
        monkeypatch.setattr(real_orders, "MAX_ASSISTANT_PER_DAY", 2)
        out, failed = run("propose_real_order", symbol="NEWCO", side="BUY", qty=1, limit_price=55.9, reason=why)
        assert failed and "its limit" in out["error"]
        assert fake.sent == [] and fake.cancels == []

        # the owner approves the assistant's proposal: only then does it go out, and the assistant can see what became of it
        first = next(w for w in c.get("/api/v1/real-orders").json()["waiting"] if w["origin"] == "assistant")
        assert first["reason"] == why and approve(c, first).json()["status"] == "sent"
        assert [o["broker"]["order_id"] for o in run("real_orders")[0]["earlier"] if o["status"] == "sent"] == [54250949]

    # no tool approves, sends, declines, cancels or changes the limits: by name, by kind and by what the code calls
    real = {t.name: t.kind for t in TOOLS if "real" in t.name}
    assert real == {"real_account": "read", "real_orders": "read", "propose_real_order": "write", "withdraw_real_order_proposal": "write"}
    assert not [t.name for t in TOOLS if re.search(r"approve|send|confirm_real|cancel_real|limits", t.name)]
    assert BY_NAME["place_trade"].description.count("Paper only") == 1          # the paper tool still says what it is
    app_dir = Path(__file__).resolve().parent.parent / "app"
    for name in ("assistant_tools.py", "assistant.py", "assistant_prefs.py"):
        text = (app_dir / name).read_text()
        for call in ("real_orders.approve(", "real_orders.cancel(", "real_orders.decline(", "real_orders.not_placed(",
                     "real_orders.save_limits(", "place_limit_order", ".cancel_order(", "core.younit", "_change("):
            assert call not in text, f"{name} must not reach {call}"


def test_orders_reach_the_broker_from_one_place_only():
    """The fence, kept by a test: one module sends, on one function's say-so; paper trading never touches it."""
    app_dir = Path(__file__).resolve().parent.parent / "app"
    source = {str(p.relative_to(app_dir)): p.read_text() for p in app_dir.rglob("*.py")}
    callers = {name for name, text in source.items() if "place_limit_order(" in text}
    assert callers == {"data/younit.py", "real_orders.py"}
    assert source["real_orders.py"].count("place_limit_order(") == 1 and "def approve(" in source["real_orders.py"]
    assert {name for name, text in source.items() if ".cancel_order(" in text} == {"real_orders.py"}
    assert {name for name, text in source.items() if "real_orders.approve(" in text} == {"main.py"}
    younit = source["data/younit.py"]
    assert younit.count("self._change(") == 2                                   # placing and cancelling, nothing else changes anything
    assert '"isMarketPrice": False' in younit and '"isMarketPrice": True' not in younit
    assert not re.search(r"\.(put|patch|delete)\(", younit)                     # no amending, no deleting
    for forbidden in ("/orders/fund", "MarketBeatTrading", "withdraw", "transfer"):
        assert forbidden not in younit
    # paper trading, strategies, automatic runs and stop-loss orders have no way in
    for paper in ("services.py", "paper.py", "orders.py", "extras.py", "domain/backtest.py", "domain/ledger.py"):
        assert "real_orders" not in source[paper] and "place_limit_order" not in source[paper], paper
    assert Settings().live_trading_enabled is False                             # off unless the server says otherwise


def test_the_autopilot_hears_about_real_orders_only_when_its_owner_switched_them_on(tmp_path, monkeypatch):
    monkeypatch.setattr(real_orders, "cairo_now", lambda: OPEN)
    fake = FakeBroker()
    with client(tmp_path, fake, live_trading_enabled=True) as c:
        c.post("/api/v1/data/refresh")
        store = Store(tmp_path / "t.sqlite3")

        def note(owner=True, server=True):
            core = App(store, Settings(data_dir=tmp_path, live_trading_enabled=server), {}, Feed(StoreDocs(store)), fake).bootstrap()
            core.real_account_allowed = owner
            return " ".join(assistant._real_note(core))

        assert note() == ""                                                     # the owner has not switched them on
        arm(c)
        propose(c)
        assert "1 proposal(s)" in note() and "only if the mandate asks for real orders" in note() and "PAPER" in note()
        assert note(owner=False) == "" and note(server=False) == ""
