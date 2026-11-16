"""Automatic real orders: the lock on the switch, the box, the automation's own book, and its stop-losses (no network)."""
import json
import re
import threading
import time as clock_module
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from pathlib import Path

import pytest

import app.data.calendar as calendar_module
import app.data.feed as feed_module
import app.data.market as market_module
from app import assistant, broker, real_auto, real_orders, services
from app.assistant_tools import TOOLS, parse
from app.config import Settings
from app.data.calendar import CAIRO
from app.data.depth import build
from app.data.feed import Feed, StoreDocs
from app.data.younit import OrderRefused, YounitError
from app.services import App
from app.store.errors import ConflictError
from app.store.sqlite_store import Store
from tests.test_broker import FakeBroker, client
from tests.test_feed import days

HAND = {"enabled": True, "max_order_value": 5000, "max_day_value": 100000, "max_day_orders": 40, "price_band_pct": 5, "symbols": []}
BOX = {"enabled": True, "budget": 3000, "max_order_value": 1000, "max_day_buys": 3, "max_loss": 300, "max_stop_pct": 8,
       "symbols": ["COMI", "TMGH"]}
WHY = "Closed above its 50-day average on twice the usual volume; wrong if it closes back under 34."
COMI, TMGH, NEWCO = 35.9, 45.9, 55.9   # the last prices of the stand-in feed


@pytest.fixture(autouse=True)
def _fresh():
    for module in (Feed, broker, real_orders):
        module.reset()
    services._DEPTH_CACHE.clear()
    yield
    for module in (Feed, broker, real_orders):
        module.reset()
    services._DEPTH_CACHE.clear()


@contextmanager
def a_floor(tmp_path, monkeypatch, **settings):
    """The API with a broker behind it, in the middle of a session, with live prices and a clock the test moves."""
    from app import background
    clock = {"now": datetime.combine(date.fromisoformat(days(1)[0]), time(11, 0), CAIRO)}
    for module in (calendar_module, feed_module, market_module, services, broker, real_orders, real_auto, background):
        monkeypatch.setattr(module, "cairo_now", lambda: clock["now"])
    fake = FakeBroker()
    fake.live_prices = {"COMI": COMI, "TMGH": TMGH, "NEWCO": NEWCO}
    with client(tmp_path, fake, live_trading_enabled=True, **settings) as c:
        c.post("/api/v1/data/refresh")
        c.fake, c.clock, c.dir, c.extra = fake, clock, tmp_path, settings
        price(c)
        fake.reads.clear()
        yield c


@pytest.fixture()
def floor(tmp_path, monkeypatch):
    with a_floor(tmp_path, monkeypatch) as c:
        yield c


# ---- helpers ---------------------------------------------------------------------------
def price(c, **prices):
    """The market moves: a new live price for these stocks, a few seconds later."""
    c.clock["now"] += timedelta(seconds=20)
    c.fake.live_prices.update({k.upper(): v for k, v in prices.items()})
    out = c.post("/api/v1/data/live").json()
    assert out["updated"], out


def arm(c, **change):
    res = c.put("/api/v1/real-orders/settings", json={**HAND, **change})
    assert res.status_code == 200, res.text


def box(c, **change):
    return c.put("/api/v1/real-orders/auto", json={**BOX, **change})


def by_hand(c, **change):
    made = c.post("/api/v1/real-orders", json={"symbol": "NEWCO", "side": "BUY", "qty": 1, "price": NEWCO, "reason": "", **change})
    assert made.status_code == 201, made.text
    made = made.json()
    res = c.post(f"/api/v1/real-orders/{made['id']}/approve", json={k: made[k] for k in ("symbol", "side", "qty", "price")})
    assert res.status_code == 200 and res.json()["status"] == "sent", res.text
    return res.json()


def fill(c, order, qty=None, average=None):
    """The broker fills an order of ours, partly or completely."""
    row = next(o for o in c.fake.book if o["order_id"] == order["broker"]["order_id"])
    qty = row["qty"] if qty is None else qty
    row.update(status="Executed" if qty >= row["qty"] else "Partially Executed", executed_qty=qty, average=average or row["price"])
    real_orders.reset()   # the broker's list is read again


def earn(c):
    """What unlocks automatic orders: three orders approved by hand and accepted by the broker, one of them filled."""
    sent = [by_hand(c, price=round(NEWCO - n / 10, 1)) for n in range(3)]
    fill(c, sent[0])
    c.get("/api/v1/real-orders")
    return sent


def on(c, **change):
    """Real orders on, the switch earned, the automatic box set and on."""
    arm(c)
    earn(c)
    res = box(c, **change)
    assert res.status_code == 200, res.text
    c.fake.sent.clear()
    return res.json()


def core_of(c):
    store = Store(c.dir / "t.sqlite3")
    core = App(store, Settings(data_dir=c.dir, live_trading_enabled=True, **c.extra), {}, Feed(StoreDocs(store)), c.fake).bootstrap()
    core.real_account_allowed = True
    return core


def suggest(c, **change):
    """The assistant writes a proposal with its own tool. Returns what the tool told it, and whether it failed."""
    args = {"symbol": "COMI", "side": "BUY", "qty": 10, "limit_price": COMI, "stop_price": 34.0, "reason": WHY, **change}
    tool, parsed, problem = parse("propose_real_order", {k: v for k, v in args.items() if v is not None})
    assert problem is None, problem
    content, failed = assistant._execute(core_of(c), tool, parsed)
    return json.loads(content), failed


def look(c):
    res = c.post("/api/v1/real-orders/auto/tick")
    assert res.status_code == 200, res.text
    return res.json()


def auto(c):
    return c.get("/api/v1/real-orders/auto").json()


def orders(c):
    v = c.get("/api/v1/real-orders").json()
    return {o["id"]: o for o in [*v["waiting"], *v["orders"]]}


def holds(c, *rows):
    """What the broker says the account holds: rows of (stock_id, code, qty, free to sell, price)."""
    c.fake.hold(*[(i, code, code, qty, free, last, last) for i, code, qty, free, last in rows])
    broker.reset()


def bought(c, qty=10, stop=34.0, target=None, **change):
    """The automation buys: the assistant proposes inside the box, a look sends it, the broker fills it."""
    out, failed = suggest(c, qty=qty, stop_price=stop, target_price=target, **change)
    assert not failed, out
    sent = look(c)["sent"]
    assert len(sent) == 1 and sent[0]["status"] == "sent", sent
    fill(c, sent[0])
    look(c)
    symbol = sent[0]["symbol"]
    holds(c, ({"COMI": 1, "TMGH": 2}[symbol], symbol, qty, qty, sent[0]["price"]))
    return sent[0]


def audit(c):
    return [(a["action"], a["entity"]) for a in c.get("/api/v1/audit").json() if a["entity"].startswith("real_")]


# ---- the lock on the switch ------------------------------------------------------------
def test_the_switch_stays_locked_until_orders_approved_by_hand_have_worked(floor):
    c = floor
    # the box can be drawn at any time; switching it on is another matter
    saved = box(c, enabled=False, symbols=["tmgh", " comi "]).json()
    assert saved["box"]["symbols"] == ["COMI", "TMGH"] and saved["complete"] and not saved["on"]
    assert box(c).status_code == 422 and "switched off in Settings" in box(c).json()["detail"]   # real orders themselves are off
    arm(c)
    res = box(c)
    assert res.status_code == 422 and "So far: 0 accepted, 0 filled" in res.json()["detail"]
    assert auto(c)["proof"] == {"proven": False, "sent": 0, "filled": 0, "needed_sent": 3, "needed_filled": 1}

    # accepted is not enough, and neither is an order the broker turned down or one that never got there
    sent = [by_hand(c, price=round(NEWCO - n / 10, 1)) for n in range(3)]
    c.fake.order_error = OrderRefused("Insufficient buying power")
    made = c.post("/api/v1/real-orders", json={"symbol": "NEWCO", "side": "BUY", "qty": 2, "price": NEWCO, "reason": ""}).json()
    assert c.post(f"/api/v1/real-orders/{made['id']}/approve",
                  json={k: made[k] for k in ("symbol", "side", "qty", "price")}).json()["status"] == "rejected"
    c.fake.order_error = None
    res = box(c)
    assert res.status_code == 422 and "So far: 3 accepted, 0 filled" in res.json()["detail"]
    assert c.get("/api/v1/status").json()["real_orders"]["auto"] is False
    assert look(c)["ran"] is False and len(c.fake.sent) == 4          # a look does nothing while it is locked

    fill(c, sent[1], qty=1)
    c.get("/api/v1/real-orders")
    assert auto(c)["proof"]["proven"] and ("earn", "real_auto") in audit(c)
    # the box must be whole and inside what the owner allows by hand
    for change, words in (({"budget": 500}, "budget cannot be smaller"), ({"max_loss": 5000}, "cannot be larger than the budget"),
                          ({"max_order_value": 6000, "budget": 9000}, "more than an order you approve yourself"),
                          ({"symbols": []}, "not complete"), ({"symbols": ["NOPE"]}, "Not in the app's stock list"),
                          ({"max_day_buys": None}, "not complete")):
        res = box(c, **change)
        assert res.status_code == 422 and words in res.json()["detail"], (change, res.text)
    arm(c, symbols=["COMI"])
    assert "Not among the stocks you allow for real orders at all: TMGH" in box(c).json()["detail"]
    arm(c)
    now_on = box(c).json()
    assert now_on["on"] and now_on["why_not"] is None and c.get("/api/v1/status").json()["real_orders"]["auto"] is True
    assert ("update", "real_auto_settings") in audit(c)
    # earned once, it stays earned: the orders it was read from are kept a month at a time
    core = core_of(c)
    assert real_auto._earned([], real_auto._book(core))["proven"]


def test_only_orders_the_owner_approved_count_towards_the_lock():
    def rec(i, by, state="open", done=0, status="sent"):
        return {"id": i, "status": status, "approved_by": by, "broker": {"state": state, "executed_qty": done}}
    empty = {"proven_at": None, "proof": {"sent": [], "filled": []}}
    automatic = [rec("a", "auto", "filled", 5), rec("b", "auto", "filled", 5), rec("c", "auto", "filled", 5)]
    assert real_auto._earned(automatic, empty)["sent"] == 0
    old = [{"id": "x", "status": "sent", "broker": {"state": "filled", "executed_qty": 1}}]      # from before the field existed
    assert real_auto._earned(old, empty)["filled"] == 1
    mixed = [rec("a", "owner"), rec("b", "owner", "rejected"), rec("c", "owner", status="unknown"), rec("d", "owner", "partial", 2)]
    assert {k: real_auto._earned(mixed, empty)[k] for k in ("proven", "sent", "filled")} == {"proven": False, "sent": 2, "filled": 1}
    # what was counted in an earlier month is kept, and an order seen again is counted once
    kept = {"proven_at": None, "proof": {"sent": ["old-1", "a"], "filled": ["old-1"]}}
    assert {k: real_auto._earned(mixed, kept)[k] for k in ("proven", "sent", "filled")} == {"proven": True, "sent": 3, "filled": 2}


def test_automatic_orders_are_for_the_owner_only(tmp_path):
    doors = [("get", "/api/v1/real-orders/auto", None), ("put", "/api/v1/real-orders/auto", BOX),
             ("post", "/api/v1/real-orders/auto/stop", None), ("post", "/api/v1/real-orders/auto/tick", None),
             ("put", "/api/v1/real-orders/auto/positions/COMI", {"stop_price": 30})]
    fake = FakeBroker()
    with client(tmp_path / "a", fake, live_trading_enabled=True, broker_account_uids="") as c:
        for method, path, body in doors:
            assert c.request(method, path, json=body).status_code == 403, path
        assert c.get("/api/v1/status").json()["real_orders"]["auto"] is False and fake.reads == [] and fake.sent == []
    with client(tmp_path / "b", None, live_trading_enabled=True) as c:
        for method, path, body in doors:
            assert c.request(method, path, json=body).status_code == 404, path


# ---- the box ---------------------------------------------------------------------------
def test_a_proposal_inside_the_box_goes_out_without_the_owner_and_everything_else_waits(floor):
    c = floor
    on(c)
    out, failed = suggest(c)
    assert not failed and out["what_happens_next"].startswith("AUTOMATIC") and "WILL be sent" in out["what_happens_next"]
    inside = out["proposal"]
    assert (inside["stop"], inside["status"]) == (34.0, "proposed") and c.fake.sent == []      # written, not sent
    assert auto(c)["waiting"][inside["id"]] == {"automatic": True, "why_not": []}

    # each of these is outside the box, and says why
    outside = {
        "no stop-loss": (suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=None, qty=5), "needs a stop-loss"),
        "a stop too far": (suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=40.0, qty=6), "you allow at most 8%"),
        "too large": (suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=30), "may be at most 1,000.00"),
        "another stock": (suggest(c, symbol="NEWCO", limit_price=NEWCO, stop_price=54.0, qty=2), "not among the stocks the automation may trade"),
        "held back": (suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=7, hold_for_owner=True), "wait for your own decision"),
        "a sale of the owner's shares": (suggest(c, symbol="TMGH", side="SELL", limit_price=TMGH, stop_price=None, qty=1) if holds(
            c, (2, "TMGH", 50, 50, TMGH)) is None else None, "sells only shares it bought itself"),
    }
    for name, ((told, failed), words) in outside.items():
        assert not failed, (name, told)
        assert "Nothing was sent" in told["what_happens_next"] and words in " ".join(told["why_it_is_not_sent_automatically"]), name
        assert words in " ".join(auto(c)["waiting"][told["proposal"]["id"]]["why_not"]), name
    mine = c.post("/api/v1/real-orders", json={"symbol": "COMI", "side": "BUY", "qty": 3, "price": 35.8, "reason": ""}).json()
    assert "Only the assistant's proposals" in auto(c)["waiting"][mine["id"]]["why_not"][0]     # the owner's own wait for the owner

    done = look(c)
    assert done["ran"] and [(o["id"], o["status"], o["approved_by"]) for o in done["sent"]] == [(inside["id"], "sent", "auto")]
    assert c.fake.sent == [{"profile_id": 4242, "stock_id": 1, "side": "BUY", "qty": 10, "price": COMI}]
    assert look(c)["sent"] == [] and len(c.fake.sent) == 1                                      # sent once, and nothing else moved
    seen = orders(c)
    assert sum(1 for o in seen.values() if o["status"] == "proposed") == len(outside) + 1
    assert ("approve", "real_order") in audit(c) and ("send", "real_order") in audit(c)
    v = auto(c)
    assert v["today"]["buys"] == 1 and v["budget"]["used"] == pytest.approx(359) and v["budget"]["free"] == pytest.approx(2641)
    # the owner can still approve by hand what the box turned away
    waits = next(o for o in seen.values() if o["status"] == "proposed" and o["symbol"] == "NEWCO")
    res = c.post(f"/api/v1/real-orders/{waits['id']}/approve", json={k: waits[k] for k in ("symbol", "side", "qty", "price")})
    assert res.json()["status"] == "sent" and res.json()["approved_by"] == "owner"


def test_the_budget_the_day_and_the_switches_bound_what_goes_out(floor):
    c = floor
    on(c, budget=1000, max_order_value=600, max_day_buys=2)
    first = bought(c, qty=10)                                                   # 359 in the market, filled
    suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=10)        # 459 more: 818, and it rests at the broker
    assert len(look(c)["sent"]) == 1
    told, _ = suggest(c, symbol="TMGH", limit_price=45.8, stop_price=44.0, qty=5)
    why = " ".join(told["why_it_is_not_sent_automatically"])
    assert "2 automatic buys were already sent today; the limit is 2" in why
    assert "has 818.00 in the market; with this it would be 1,047.00, over the 1,000.00 left of its budget" in why
    assert look(c)["sent"] == [] and len(c.fake.sent) == 2

    # an open buy that is cancelled gives its part of the budget back; the day's count stays used
    open_buy = next(o for o in orders(c).values() if o["symbol"] == "TMGH" and o["status"] == "sent")
    assert c.post(f"/api/v1/real-orders/{open_buy['id']}/cancel").status_code == 200
    v = auto(c)
    assert v["budget"]["used"] == pytest.approx(359) and v["today"]["buys"] == 2
    # what a proposal was told when it was written stays true: room in the budget now does not send it later
    waits = v["waiting"][told["proposal"]["id"]]
    assert waits["automatic"] is False and waits["why_not"][0].startswith("It waits for you, as it was told when it was written: 2 automatic buys")

    # the owner's own switch, the server's switch and a closed market each stop a look before it does anything
    assert box(c, max_day_buys=5, budget=1000, max_order_value=600).status_code == 200
    assert look(c)["sent"] == [] and auto(c)["waiting"][told["proposal"]["id"]]["automatic"] is False   # nor does a wider box
    c.put("/api/v1/real-orders/settings", json={**HAND, "enabled": False})
    assert look(c) == {"ran": False, "why": "Real orders are switched off in Settings → Real trading."}
    arm(c)
    c.clock["now"] = c.clock["now"].replace(hour=16)
    assert look(c)["why"] == "The market is closed." and len(c.fake.sent) == 2
    c.clock["now"] = c.clock["now"].replace(hour=11)
    assert box(c, enabled=False, max_day_buys=5, budget=1000, max_order_value=600).json()["on"] is False
    assert look(c)["ran"] is False and len(c.fake.sent) == 2
    assert first["approved_by"] == "auto"


def test_an_automatic_order_still_passes_every_check_an_approved_one_does(floor, monkeypatch):
    c = floor
    on(c)
    told, _ = suggest(c)
    c.fake.power = 100.0                                                        # by the time of the look, the money is not there
    done = look(c)
    assert done["sent"] == [] and c.fake.sent == [] and "the broker says 100.00 can be spent" in done["notes"][0]
    waiting = orders(c)[told["proposal"]["id"]]
    assert waiting["status"] == "proposed" and waiting["auto"]["n"] == 1 and "can be spent" in waiting["auto"]["why"]
    # it is not hammered: the next looks leave it alone for a while, then try again, and give up after a few
    c.fake.reads.clear()
    assert look(c)["notes"] == [] and "power" not in c.fake.reads
    monkeypatch.setattr(real_auto, "AUTO_RETRY_SECONDS", -1)
    monkeypatch.setattr(real_auto, "MAX_AUTO_TRIES", 2)
    assert len(look(c)["notes"]) == 1 and orders(c)[waiting["id"]]["auto"]["n"] == 2
    c.fake.power = 20000.0
    assert look(c)["sent"] == [] and c.fake.sent == []                         # it now waits for the owner like any other
    # the owner's own daily limit binds the automation too
    told, _ = suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=5)
    c.put("/api/v1/real-orders/settings", json={**HAND, "max_day_orders": 3})   # the three approved by hand used it up
    done = look(c)
    assert done["sent"] == [] and "your limit is 3 a day" in done["notes"][0] and c.fake.sent == []
    told, failed = suggest(c, symbol="TMGH", limit_price=45.8, stop_price=44.0, qty=5)
    assert failed and "your limit is 3 a day" in told["error"]                 # and it cannot even be written


# ---- the automation's own book ---------------------------------------------------------
def test_fills_build_the_book_once_each_and_the_latest_stop_watches_the_position(floor):
    c = floor
    on(c)
    suggest(c, qty=10, stop_price=34.0, target_price=40.0)
    sent = look(c)["sent"][0]
    assert auto(c)["positions"] == [] and auto(c)["budget"]["used"] == pytest.approx(359)   # resting at the broker: counted, not held
    fill(c, sent, qty=4, average=35.8)
    assert "Bought 4 COMI at about 35.8" in look(c)["notes"][0]
    v = auto(c)
    (pos,) = v["positions"]
    assert (pos["symbol"], pos["qty"], pos["cost"], pos["stop"], pos["target"]) == ("COMI", 4, pytest.approx(143.2), 34.0, 40.0)
    assert v["budget"]["used"] == pytest.approx(143.2 + 6 * COMI)               # what it holds, and what is still open
    assert look(c)["notes"] == [] and auto(c)["positions"][0]["qty"] == 4       # the same fill is not counted again
    # the owner moves the levels while the order is still filling: the rest of the order does not put them back
    assert c.put("/api/v1/real-orders/auto/positions/COMI", json={"stop_price": 34.2, "target_price": 41}).status_code == 200
    fill(c, sent, average=35.85)                                                # the rest: 10 at an average of 35.85
    look(c)
    (pos,) = auto(c)["positions"]
    assert (pos["cost"], pos["stop"], pos["target"]) == (pytest.approx(358.5), 34.2, 41.0)
    assert auto(c)["budget"]["used"] == pytest.approx(358.5)

    # a second buy adds to the position; its stop is higher, so it now watches all of it, and the target stays
    suggest(c, qty=5, limit_price=35.8, stop_price=34.5)
    fill(c, look(c)["sent"][0])
    look(c)
    (pos,) = auto(c)["positions"]
    assert (pos["qty"], pos["cost"], pos["stop"], pos["target"]) == (15, pytest.approx(537.5), 34.5, 41.0)
    # a third with a lower stop does not move the stop down: only the owner does that
    suggest(c, qty=2, limit_price=35.7, stop_price=33.5, target_price=42.0)
    fill(c, look(c)["sent"][0])
    look(c)
    (pos,) = auto(c)["positions"]
    assert (pos["qty"], pos["stop"], pos["target"]) == (17, 34.5, 42.0)
    # an order the owner approved by hand is the owner's: it never enters the automation's book
    mine = by_hand(c, symbol="TMGH", qty=5, price=TMGH)
    fill(c, mine)
    look(c)
    assert [p["symbol"] for p in auto(c)["positions"]] == ["COMI"]


def test_the_book_gives_way_when_the_broker_shows_fewer_shares(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10)
    holds(c, (1, "COMI", 4, 4, COMI))                                           # the owner sold six of them in the broker's own app
    assert look(c)["notes"] == [] and auto(c)["positions"][0]["qty"] == 10      # too soon after the fill to conclude anything
    monkeypatch.setattr(real_auto, "SETTLING_SECONDS", -1)
    monkeypatch.setattr(real_auto, "SHORT_SECONDS", -1)
    # one reading is not believed: the broker must show it at several looks in a row
    assert look(c)["notes"] == [] and look(c)["notes"] == [] and auto(c)["positions"][0]["qty"] == 10
    holds(c, (1, "COMI", 10, 10, COMI))                                         # an odd answer that put itself right: forgotten
    look(c)
    holds(c, (1, "COMI", 4, 4, COMI))
    assert [look(c)["notes"] for _ in range(2)] == [[], []]
    assert "The broker shows 4 COMI, not the 10 the automation counted" in look(c)["notes"][0]
    (pos,) = auto(c)["positions"]
    assert (pos["qty"], pos["cost"]) == (4, pytest.approx(143.6)) and ("reconcile", "real_auto") in audit(c)
    holds(c)                                                                    # and then the rest
    for _ in range(3):
        look(c)
    assert auto(c)["positions"] == [] and auto(c)["budget"]["used"] == 0
    # shares bought today that the broker lists as not settled yet are still the account's
    monkeypatch.setattr(real_auto, "SETTLING_SECONDS", 600)
    bought(c, qty=10, limit_price=35.8)
    c.fake.positions = [{**c.fake.positions[0], "qty": 2, "unsettled": 8, "available": 0}]
    broker.reset()
    monkeypatch.setattr(real_auto, "SETTLING_SECONDS", -1)
    assert [look(c)["notes"] for _ in range(4)] == [[]] * 4 and auto(c)["positions"][0]["qty"] == 10


def test_a_sale_that_just_filled_is_never_taken_for_shares_that_left_the_account(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    monkeypatch.setattr(real_auto, "SETTLING_SECONDS", -1)
    monkeypatch.setattr(real_auto, "SHORT_SECONDS", -1)
    price(c, comi=33.5)
    (sale,) = look(c)["exits"]
    # the sale fills and the shares leave the account, but the broker's order list cannot be read for a while
    fill(c, sale, average=33.5)
    holds(c)
    c.fake.orders = lambda profile_id: (_ for _ in ()).throw(YounitError("Younit request failed (HTTP 429)"))
    for _ in range(4):
        done = look(c)
        assert any("order list could not be read" in n for n in done["notes"])
    assert auto(c)["positions"][0]["qty"] == 10                                 # the book waits for the orders' own word
    del c.fake.orders
    real_orders.reset()
    assert "Sold 10 COMI at about 33.5" in " ".join(look(c)["notes"])
    v = auto(c)
    assert v["positions"] == [] and v["today"]["realized"] == pytest.approx(335 - 359) and v["budget"]["lost"] == pytest.approx(24)


# ---- stop-loss and take-profit ---------------------------------------------------------
def book_at(c, last, *bids):
    c.fake.depth = lambda stock_id, timeout=6.0: build({
        "m_LastTradePrice": str(last), "m_BidPrice": str(bids[0]), "m_AskPrice": str(last + 0.05),
        "m_BidBook": "|".join(f"{p},1000,2" for p in bids), "m_AskBook": f"{last + 0.05},900,1"})
    services._DEPTH_CACHE.clear()


def test_a_stop_loss_reached_sells_the_automations_shares_at_a_price_that_fills(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    holds(c, (1, "COMI", 60, 60, COMI))                                         # the owner holds fifty more of their own
    price(c, comi=34.6)
    assert look(c) == {"ran": True, "sent": [], "exits": [], "notes": [], "paused": None}       # above the stop: nothing
    # the owner's daily limit is used up and the stock is no longer on their list: neither may hold back a way out
    c.put("/api/v1/real-orders/settings", json={**HAND, "max_day_orders": 4, "symbols": ["TMGH"]})
    book_at(c, 33.9, 33.9, 33.85, 33.8, 33.75, 33.7, 33.6, 30.0)
    price(c, comi=33.9)
    done = look(c)
    (sale,) = done["exits"]
    assert (sale["side"], sale["qty"], sale["price"], sale["status"]) == ("SELL", 10, 33.7, "sent")   # five levels into the bids
    assert (sale["origin"], sale["approved_by"], sale["protective"]) == ("automation", "auto", True)
    assert sale["reason"] == "Stop-loss: the price reached 33.9, at or under the stop at 34."
    assert c.fake.sent[-1] == {"profile_id": 4242, "stock_id": 1, "side": "SELL", "qty": 10, "price": 33.7}
    v = auto(c)
    assert v["positions"][0]["selling"] and v["positions"][0]["at_stop"]
    assert look(c)["exits"] == [] and len([s for s in c.fake.sent if s["side"] == "SELL"]) == 1   # one sale, not one per look

    fill(c, sale, average=33.75)
    assert "Sold 10 COMI at about 33.75" in look(c)["notes"][0]
    v = auto(c)
    assert v["positions"] == [] and v["today"]["realized"] == pytest.approx(337.5 - 359)
    assert v["budget"] == {"limit": 3000, "lost": pytest.approx(21.5), "room": pytest.approx(2978.5), "used": 0, "free": pytest.approx(2978.5)}
    assert look(c)["exits"] == []                                               # nothing left to sell
    # stopped out of it today: the automation does not walk back in the same day
    arm(c)
    told, failed = suggest(c, qty=5, limit_price=33.9, stop_price=32.5)
    assert not failed, told
    assert "does not buy it again the same day" in " ".join(told["why_it_is_not_sent_automatically"])
    assert look(c)["sent"] == []


def test_a_sale_that_does_not_fill_is_priced_again_and_the_app_says_when_it_gives_up(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    price(c, comi=33.5)                                                         # no order book to read: the last price is used
    (sale,) = look(c)["exits"]
    assert sale["price"] == 33.5 and look(c)["exits"] == []                     # it rests at the broker, and is given time
    monkeypatch.setattr(real_auto, "EXIT_PATIENCE_SECONDS", -1)
    monkeypatch.setattr(real_auto, "EXIT_RETRY_SECONDS", -1)
    price(c, comi=33.0)
    assert "did not fill; it was cancelled, to be priced again" in look(c)["notes"][0]
    assert c.fake.cancels == [(sale["broker"]["order_id"], 4242)]
    (again,) = look(c)["exits"]
    assert again["price"] == 33.0 and again["id"] != sale["id"] and auto(c)["positions"][0]["qty"] == 10

    # the broker turns every sale down: after a few attempts in the day the app stops and tells the owner
    c.fake.cancel_error = None
    monkeypatch.setattr(real_auto, "MAX_EXIT_TRIES", 4)
    next(o for o in c.fake.book if o["order_id"] == again["broker"]["order_id"])["status"] = "Cancelled"
    real_orders.reset()
    c.fake.order_error = OrderRefused("Order rejected by the exchange")
    for _ in range(2):
        (refused,) = look(c)["exits"]
        assert refused["status"] == "rejected"
    done = look(c)
    assert done["exits"] == [] and "4 sales of it today did not complete" in done["notes"][0]
    assert "sell it yourself" in done["notes"][0] and auto(c)["positions"][0]["gave_up"]
    assert len([s for s in c.fake.sent if s["side"] == "SELL"]) == 4
    # the owner moves the stop: the count starts again
    assert c.put("/api/v1/real-orders/auto/positions/COMI", json={"stop_price": 33.5}).status_code == 200
    c.fake.order_error = None
    assert look(c)["exits"][0]["status"] == "sent"


def test_a_stop_waits_for_what_it_needs_and_says_so(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0, target=38.0)
    # the shares are not free to sell yet
    holds(c, (1, "COMI", 10, 0, COMI))
    price(c, comi=33.0)
    done = look(c)
    assert done["exits"] == [] and "does not show its shares as free to sell yet" in done["notes"][0]
    # part of them are: that part is sold
    holds(c, (1, "COMI", 10, 6, COMI))
    assert look(c)["exits"][0]["qty"] == 6
    # the broker's holdings cannot be read
    monkeypatch.setattr(real_auto, "EXIT_RETRY_SECONDS", -1)
    holds(c, (2, "TMGH", 5, 5, TMGH))
    c.fake.account_positions = lambda: (_ for _ in ()).throw(YounitError("Younit request failed (HTTP 502)"))
    broker.reset()
    assert any("holdings could not be read" in n for n in look(c)["notes"])
    assert len([s for s in c.fake.sent if s["side"] == "SELL"]) == 1


def test_without_a_fresh_live_price_no_stop_is_acted_on(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    price(c, comi=33.0)
    c.clock["now"] += timedelta(minutes=5)                                      # the price on screen is five minutes old
    done = look(c)
    assert done["exits"] == [] and done["notes"] == ["There is no fresh price for COMI right now, so its stop-loss is not being watched."]
    assert auto(c)["positions"][0]["live"] is False
    # a stock that did not answer the feed this time keeps its old figure on screen; that figure is not acted on
    del c.fake.live_prices["COMI"]
    price(c, tmgh=TMGH)
    assert look(c)["exits"] == [] and auto(c)["positions"][0]["last"] == 33.0 and auto(c)["positions"][0]["live"] is False
    # then the broker's own price for the stock is what the stop is judged by
    c.fake.limits[1] = {"last": 34.4}
    assert look(c)["exits"] == [] and look(c)["notes"] == []                    # above the stop: nothing, and nothing to say
    c.fake.limits[1] = {"last": 33.2}
    (sale,) = look(c)["exits"]
    assert sale["reason"].startswith("Stop-loss: the price reached 33.2")


def test_a_take_profit_sells_at_the_target_or_better_never_under_it(floor):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0, target=37.0)
    book_at(c, 37.2, 37.15, 37.1, 37.05, 36.95, 36.9)                           # only three bids at the target or over it
    price(c, comi=37.2)
    (sale,) = look(c)["exits"]
    assert (sale["side"], sale["qty"], sale["price"]) == ("SELL", 10, 37.05)
    assert sale["reason"] == "Take-profit: the price reached 37.2, at or over the target at 37."
    fill(c, sale)
    look(c)
    v = auto(c)
    assert v["positions"] == [] and v["today"]["realized"] == pytest.approx(11.5) and v["budget"]["lost"] == 0
    assert v["budget"]["room"] == 3000                                          # a profit does not widen the budget


def test_an_interrupted_way_out_is_tidied_up_and_tried_again(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    core = core_of(c)
    bk = real_auto._book(core)
    # a look claimed the way out, wrote the sale down, and died before sending it
    made = real_orders.propose(core, real_orders.OrderIn(symbol="COMI", side="SELL", qty=10, price=COMI, reason="x"),
                               "automation", protective=True)
    bk["positions"]["COMI"]["exit"] = {"at": services.now_iso(), "order": made["id"]}
    real_auto._keep(core, bk)
    price(c, comi=33.0)
    assert look(c)["exits"] == [] and c.fake.sent[-1]["side"] == "BUY"          # another look may still be at it: hands off
    monkeypatch.setattr(real_auto, "CLAIM_SECONDS", -1)
    (sale,) = look(c)["exits"]
    assert sale["id"] != made["id"] and sale["qty"] == 10
    stale = orders(c)[made["id"]]
    assert stale["status"] == "failed" and "interrupted before this sale was sent" in stale["status_note"]
    assert ("drop", "real_order") in audit(c)


def test_a_sale_in_doubt_is_never_followed_by_another(floor, monkeypatch):
    from app.data.younit import OrderUncertain
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    price(c, comi=33.0)
    c.fake.order_error = OrderUncertain("no answer from the broker")
    (sale,) = look(c)["exits"]
    assert sale["status"] == "unknown"
    c.fake.order_error = None
    monkeypatch.setattr(real_auto, "EXIT_RETRY_SECONDS", -1)
    for _ in range(3):
        done = look(c)
        assert done["exits"] == [] and "may or may not have reached the broker" in done["notes"][0]
    assert len([s for s in c.fake.sent if s["side"] == "SELL"]) == 1


# ---- the brake, the stop button, the levels --------------------------------------------
def test_down_by_more_than_allowed_it_stops_buying_for_the_day_but_still_sells(floor):
    c = floor
    on(c, max_loss=20)
    bought(c, qty=10, stop=34.0)
    suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=5)         # written before the fall
    price(c, comi=33.0)                                                         # 29 down on ten shares
    done = look(c)
    assert done["paused"]["why"] == "it is down 29.00, more than the 20.00 you allow."
    assert len(done["exits"]) == 1 and done["sent"] == []                       # it sells; it does not buy
    assert any("stopped buying for today" in n for n in done["notes"]) and ("pause", "real_auto") in audit(c)
    told, _ = suggest(c, symbol="TMGH", limit_price=45.8, stop_price=44.0, qty=5)
    assert "not buying for the rest of today" in " ".join(told["why_it_is_not_sent_automatically"])
    assert auto(c)["paused"] and [s["side"] for s in c.fake.sent] == ["BUY", "SELL"]
    # the next day it may buy again
    core = core_of(c)
    bk = real_auto._book(core)
    bk["paused"]["day"] = "2000-01-01"
    real_auto._keep(core, bk)
    assert auto(c)["paused"] is None


def test_the_owner_stops_it_with_one_tap_and_moves_a_stop(floor):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=5)
    (resting,) = look(c)["sent"]                                                # an automatic buy still open at the broker
    by_hand(c, symbol="NEWCO", qty=1, price=55.5)                               # and one of the owner's own

    assert c.put("/api/v1/real-orders/auto/positions/COMI", json={"stop_price": 35.0, "target_price": 34.0}).status_code == 422
    assert c.put("/api/v1/real-orders/auto/positions/TMGH", json={"stop_price": 40}).status_code == 404
    moved = c.put("/api/v1/real-orders/auto/positions/comi", json={"stop_price": 35.0, "target_price": 39.5}).json()
    assert (moved["positions"][0]["stop"], moved["positions"][0]["target"]) == (35.0, 39.5) and ("levels", "real_auto") in audit(c)

    stopped = c.post("/api/v1/real-orders/auto/stop").json()
    assert stopped["on"] is False and stopped["box"]["enabled"] is False and stopped["box"]["budget"] == "3000"
    assert stopped["box"]["enabled_at"] is None
    assert stopped["stop_notes"] == ["Asked the broker to cancel the open buy of 5 TMGH."]
    assert c.fake.cancels == [(resting["broker"]["order_id"], 4242)]            # the automation's buy, not the owner's
    assert [p["symbol"] for p in stopped["positions"]] == ["COMI"] and ("stop", "real_auto") in audit(c)
    price(c, comi=30.0)
    assert look(c)["ran"] is False and [s["side"] for s in c.fake.sent].count("SELL") == 0     # stopped means stopped: no sale either
    assert c.get("/api/v1/status").json()["real_orders"]["auto"] is False
    assert c.post("/api/v1/real-orders/auto/stop").status_code == 200           # pressing it again is harmless


# ---- two at once -----------------------------------------------------------------------
def test_two_looks_at_once_send_one_order(floor):
    c = floor
    on(c)
    suggest(c)
    asked = c.fake.buying_power

    def slow(stock_id):
        clock_module.sleep(0.25)
        return asked(stock_id)
    c.fake.buying_power = slow
    results = []
    threads = [threading.Thread(target=lambda: results.append(look(c))) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(r["ran"] for r in results) == [False, False, True] and len(c.fake.sent) == 1
    assert {r["why"] for r in results if not r["ran"]} == {"Another look is running."}


def test_a_book_that_changed_under_a_look_stops_that_look(floor):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    core = core_of(c)
    mine, theirs = real_auto._book(core), real_auto._book(core)
    theirs["positions"]["COMI"]["exit"] = {"at": services.now_iso(), "order": None}
    real_auto._keep(core, theirs)                                               # another window got there first
    mine["positions"].pop("COMI")
    with pytest.raises(real_auto._Busy):
        real_auto._keep(core, mine)
    assert real_auto._book(core)["positions"]["COMI"]["exit"]                   # and what it wrote stands


# ---- the assistant ---------------------------------------------------------------------
def test_the_assistant_is_told_what_the_box_is_and_what_became_of_its_proposal(floor):
    c = floor
    arm(c)

    def tool(name):
        t, parsed, problem = parse(name, {})
        content, failed = assistant._execute(core_of(c), t, parsed)
        assert not failed, content
        return json.loads(content)

    def note():
        return " ".join(assistant._real_note(core_of(c)))

    told, _ = suggest(c)
    assert "Nothing was sent" in told["what_happens_next"] and "switched off" in told["why_it_is_not_sent_automatically"][0]
    assert tool("real_orders")["automatic_orders"]["on"] is False and "AUTOMATIC" not in note()
    assert "it is not sent, it waits for the owner" in note()

    on(c)
    # what it wrote before the switch was turned stays what it said it was: waiting for the owner
    assert "as it was told when it was written: Automatic orders are switched off" in auto(c)["waiting"][told["proposal"]["id"]]["why_not"][0]
    assert look(c)["sent"] == [] and c.fake.sent == []
    bought(c, qty=10, stop=34.0, limit_price=35.8)
    seen = tool("real_orders")["automatic_orders"]
    assert seen["on"] and seen["box"]["symbols"] == ["COMI", "TMGH"] and seen["budget"]["free"] == pytest.approx(2642)
    assert seen["positions"] == [{"symbol": "COMI", "qty": 10, "avg_cost": pytest.approx(35.8), "stop": 34.0, "target": None,
                                  "last": COMI, "result": pytest.approx(1.0), "selling": False}]
    brief = note()
    for words in ("AUTOMATIC REAL ORDERS ARE ON", "stocks COMI, TMGH", "at most EGP 1,000.00 per order", "1 of 3 automatic buys used today",
                  "EGP 2,642.00 free of a budget of EGP 3,000.00", "at most 8% under its limit price",
                  "the automation holds 10 COMI at about 35.8", "stop-loss 34.0", "propose nothing: that is a good outcome"):
        assert words in brief, words
    assert "it is not sent, it waits for the owner" not in brief
    # the assistant may sell what the automation holds, and that goes out too
    told, failed = suggest(c, side="SELL", qty=4, limit_price=COMI, stop_price=None)
    assert not failed and told["what_happens_next"].startswith("AUTOMATIC")
    assert [(o["side"], o["qty"], o["origin"]) for o in look(c)["sent"]] == [("SELL", 4, "assistant")]
    told, _ = suggest(c, side="SELL", qty=7, limit_price=35.8, stop_price=None)
    assert "holds 10 COMI, 4 of them already being sold; this would sell 7" in told["why_it_is_not_sent_automatically"][0]


def test_nothing_but_the_owners_open_app_and_their_timer_starts_a_look():
    """The fence, kept by a test: the assistant can read the box and nothing more, and sending has two callers."""
    app_dir = Path(__file__).resolve().parent.parent / "app"
    source = {str(p.relative_to(app_dir)): p.read_text() for p in app_dir.rglob("*.py")}
    for name in ("assistant_tools.py", "assistant.py", "assistant_prefs.py"):
        used = set(re.findall(r"real_auto\.(\w+)", source[name]))
        assert used <= {"brief", "admit", "tick"} and "real_auto.tick(" not in source[name], (name, used)   # `tick` is named in a comment only
        for call in ("send_waiting(", "real_auto.save(", "real_auto.stop(", "real_auto.set_levels(", "note_auto(", "discard("):
            assert call not in source[name], f"{name} must not reach {call}"
    assert {name for name, text in source.items() if "send_waiting(" in text} == {"real_orders.py", "real_auto.py"}
    # a look is asked for by the owner's open app (main.py) or by the timer working with the owner's key (background.py)
    assert {name for name, text in source.items() if "real_auto.tick(" in text} == {"main.py", "background.py"}
    assert {name for name, text in source.items() if re.search(r"background\.(wake|look)\(", text)} == {"main.py"}
    for name in ("assistant_tools.py", "assistant.py", "assistant_prefs.py"):
        assert "background" not in source[name] and "push." not in source[name], name
    assert {name for name, text in source.items() if "place_limit_order(" in text} == {"data/younit.py", "real_orders.py"}
    assert "place_limit_order" not in source["real_auto.py"] and "core.younit.cancel_order" not in source["real_auto.py"]
    # paper trading, strategies and the automatic paper runs have no way in
    for paper in ("services.py", "paper.py", "orders.py", "extras.py", "domain/backtest.py", "domain/ledger.py"):
        assert "real_auto" not in source[paper], paper
    assert not [t.name for t in TOOLS if re.search(r"auto|tick|box|levels", t.name) and "real" in t.name]
    assert real_auto.AutoIn().enabled is False and real_auto.PROOF_SENT >= 3 and real_auto.PROOF_FILLED >= 1


# ---- what an independent review found, each kept shut by a test ---------------------------
def test_another_sale_resting_at_the_broker_does_not_keep_the_stop_from_selling(floor):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    told, _ = suggest(c, side="SELL", qty=10, limit_price=36.5, stop_price=None)   # the assistant asks more than the market gives
    (resting,) = look(c)["sent"]
    price(c, comi=33.0)                                                           # and the price falls through the stop instead
    done = look(c)
    assert done["exits"] == [] and "were cancelled, and the sale follows at the next look" in done["notes"][0]
    assert c.fake.cancels == [(resting["broker"]["order_id"], 4242)]
    (sale,) = look(c)["exits"]
    assert (sale["qty"], sale["price"], sale["origin"]) == (10, 33.0, "automation")
    # with one of its sales in doubt, it says so instead of staying silent
    assert auto(c)["positions"][0]["selling"]


def test_a_take_profit_that_will_not_fill_leaves_the_stop_loss_its_own_tries(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0, target=37.0)
    monkeypatch.setattr(real_auto, "EXIT_PATIENCE_SECONDS", -1)
    monkeypatch.setattr(real_auto, "EXIT_RETRY_SECONDS", -1)
    monkeypatch.setattr(real_auto, "MAX_EXIT_TRIES", 2)
    price(c, comi=37.2)
    for _ in range(2):                                                            # two sales at the target rest and are taken back
        assert len(look(c)["exits"]) == 1
        assert "did not fill" in look(c)["notes"][0]
    done = look(c)
    assert done["exits"] == [] and "leaves the take-profit for today; the stop-loss still stands" in done["notes"][0]
    assert auto(c)["positions"][0]["gave_up"] is False
    price(c, comi=33.0)
    (sale,) = look(c)["exits"]                                                    # the stop still has all its tries
    assert sale["reason"].startswith("Stop-loss") and sale["qty"] == 10


def test_a_sale_that_could_not_even_be_prepared_is_not_counted_as_a_try(floor, monkeypatch):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    monkeypatch.setattr(real_auto, "EXIT_RETRY_SECONDS", -1)
    monkeypatch.setattr(real_auto, "MAX_EXIT_TRIES", 2)
    price(c, comi=33.0)
    asked = c.fake.trading_limits
    c.fake.trading_limits = lambda stock_id: (_ for _ in ()).throw(YounitError("Younit request failed (HTTP 503)"))
    for _ in range(4):                                                            # the broker cannot be asked, look after look
        done = look(c)
        assert done["exits"] == [] and "could not be prepared" in done["notes"][0]
    c.fake.trading_limits = asked
    (sale,) = look(c)["exits"]                                                    # none of that used the stop up
    assert sale["status"] == "sent" and not auto(c)["positions"][0]["gave_up"]
    assert [o["status"] for o in orders(c).values() if o["side"] == "SELL"] == ["sent"]   # and nothing was left waiting


def test_a_sale_of_the_automations_shares_comes_off_its_book_whoever_approves_it(floor):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    holds(c, (1, "COMI", 60, 60, COMI))                                           # the owner holds fifty more of their own
    told, _ = suggest(c, side="SELL", qty=10, limit_price=35.8, stop_price=None, hold_for_owner=True)
    assert "Nothing was sent" in told["what_happens_next"] and look(c)["sent"] == []
    waits = orders(c)[told["proposal"]["id"]]
    assert waits["of_book"] and not waits["auto_ok"]
    res = c.post(f"/api/v1/real-orders/{waits['id']}/approve", json={k: waits[k] for k in ("symbol", "side", "qty", "price")})
    assert res.json()["status"] == "sent" and res.json()["approved_by"] == "owner"
    fill(c, res.json(), average=35.8)
    assert "Sold 10 COMI at about 35.8" in look(c)["notes"][0]
    v = auto(c)
    assert v["positions"] == [] and v["today"]["realized"] == pytest.approx(358 - 359)
    holds(c, (1, "COMI", 50, 50, COMI))
    price(c, comi=33.0)                                                           # the old stop is gone with the shares
    assert look(c)["exits"] == [] and [s["side"] for s in c.fake.sent] == ["BUY", "SELL"]

    # a sale larger than what the automation holds is about the owner's own shares: the book is not touched
    bought(c, qty=5, stop=44.0, symbol="TMGH", limit_price=TMGH)
    holds(c, (2, "TMGH", 55, 55, TMGH))
    told, _ = suggest(c, symbol="TMGH", side="SELL", qty=30, limit_price=45.8, stop_price=None)
    waits = orders(c)[told["proposal"]["id"]]
    assert not waits["of_book"] and "holds 5 TMGH" in " ".join(told["why_it_is_not_sent_automatically"])
    res = c.post(f"/api/v1/real-orders/{waits['id']}/approve", json={k: waits[k] for k in ("symbol", "side", "qty", "price")})
    fill(c, res.json())
    look(c)
    assert [(p["symbol"], p["qty"]) for p in auto(c)["positions"]] == [("TMGH", 5)]


def test_a_stop_pressed_while_a_look_is_running_wins(floor):
    c = floor
    on(c)
    suggest(c)
    suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=5)
    asked, pressed = c.fake.buying_power, []

    def while_it_is_checked(stock_id):
        if not pressed:
            pressed.append(c.post("/api/v1/real-orders/auto/stop").status_code)   # the owner taps Stop at that very moment
        return asked(stock_id)
    c.fake.buying_power = while_it_is_checked
    done = look(c)
    c.fake.buying_power = asked
    assert pressed == [200] and c.fake.sent == [] and not done.get("sent")       # the order being checked did not go out
    assert auto(c)["on"] is False and auto(c)["box"]["enabled"] is False        # and the stop was not undone
    assert look(c)["ran"] is False and c.fake.sent == []

    # between two orders of one look, the switches are read again
    assert box(c).status_code == 200
    suggest(c, limit_price=35.8)
    suggest(c, symbol="TMGH", limit_price=45.8, stop_price=44.0, qty=5)
    place = c.fake.place_limit_order

    def then_stop(**order):
        placed = place(**order)
        c.put("/api/v1/real-orders/auto", json={**BOX, "enabled": False})         # switched off right after the first went out
        return placed
    c.fake.place_limit_order = then_stop
    done = look(c)
    c.fake.place_limit_order = place
    assert len(done["sent"]) == 1 and len(c.fake.sent) == 1
    assert "switched off while this look was running; nothing more was sent" in " ".join(done["notes"])


def test_a_buy_under_its_own_stop_or_into_a_sale_is_not_sent(floor):
    c = floor
    on(c)
    told, failed = suggest(c, limit_price=36.0, stop_price=35.95)                 # the market is at 35.9: that stop is already hit
    assert failed and "at or above the market" in told["error"]
    bought(c, qty=10, stop=34.0)
    assert c.put("/api/v1/real-orders/auto/positions/COMI", json={"stop_price": 35.5}).status_code == 200
    told, _ = suggest(c, qty=5, limit_price=35.4, stop_price=34.5)
    assert "would be bought under its own stop" in " ".join(told["why_it_is_not_sent_automatically"])
    c.put("/api/v1/real-orders/auto/positions/COMI", json={"stop_price": 34.0})
    suggest(c, side="SELL", qty=10, limit_price=36.5, stop_price=None)
    assert len(look(c)["sent"]) == 1                                              # a sale of it now rests at the broker
    told, _ = suggest(c, qty=5, limit_price=35.8, stop_price=34.5)
    assert "is selling COMI right now" in " ".join(told["why_it_is_not_sent_automatically"])
    assert look(c)["sent"] == []


def test_what_is_left_of_a_buy_never_makes_a_position_without_a_stop(floor):
    c = floor
    on(c)
    suggest(c, qty=10, stop_price=34.0, target_price=37.0)
    buy = look(c)["sent"][0]
    fill(c, buy, qty=4)
    look(c)
    holds(c, (1, "COMI", 4, 4, COMI))
    price(c, comi=37.2)                                                           # the four that filled reach their target and are sold
    (sale,) = look(c)["exits"]
    fill(c, sale)
    look(c)
    assert auto(c)["positions"] == []
    fill(c, buy)                                                                  # then the rest of the same buy fills
    look(c)
    (pos,) = auto(c)["positions"]
    assert (pos["qty"], pos["stop"], pos["target"]) == (6, 34.0, 37.0)            # watched from the first moment

    # at a stop-loss, a buy of the same stock still open is taken back before anything is sold
    suggest(c, symbol="TMGH", qty=10, limit_price=TMGH, stop_price=44.0)
    buy = look(c)["sent"][0]
    fill(c, buy, qty=4)
    look(c)
    holds(c, (2, "TMGH", 4, 4, TMGH), (1, "COMI", 6, 0, COMI))
    price(c, tmgh=43.5, comi=COMI)
    done = look(c)
    assert done["exits"] == [] and c.fake.cancels[-1] == (buy["broker"]["order_id"], 4242)
    (sale,) = look(c)["exits"]
    assert (sale["symbol"], sale["qty"]) == ("TMGH", 4)


def test_ways_out_do_not_use_up_the_owners_limits_and_the_count_lives_in_the_book(floor):
    c = floor
    on(c)
    bought(c, qty=10, stop=34.0)
    before = c.get("/api/v1/real-orders").json()["today"]
    price(c, comi=33.5)
    (sale,) = look(c)["exits"]
    after = c.get("/api/v1/real-orders").json()["today"]
    assert after == before == {"orders": 4, "value": pytest.approx(55.9 + 55.8 + 55.7 + 359)}
    c.put("/api/v1/real-orders/settings", json={**HAND, "max_day_orders": 5})
    by_hand(c, symbol="TMGH", qty=1, price=TMGH)                                  # the owner's own order still has its place

    # what the book has counted of an order is not on the order's record, so nothing that rewrites the record can undo it
    fill(c, sale, average=33.5)
    look(c)
    core = core_of(c)
    rec = real_orders._get(core, sale["id"])
    assert "applied" not in rec and real_auto._book(core)["applied"][sale["id"]] == {"qty": 10, "amount": "335.00"}
    real_orders._put(core, {**rec, "cancel": {"asked_at": "x", "outcome": "a stale copy written over it"}})
    assert look(c)["notes"] == [] and auto(c)["today"]["realized"] == pytest.approx(335 - 359)


def test_what_a_look_did_before_a_collision_is_still_told(floor, monkeypatch):
    c = floor
    on(c)
    suggest(c)
    suggest(c, symbol="TMGH", limit_price=TMGH, stop_price=44.0, qty=5)
    real, calls = real_orders.send_waiting, []

    def collide_on_the_second(core, id, gate, touch=()):
        calls.append(id)
        if len(calls) == 2:
            raise ConflictError("the data changed in another window")
        return real(core, id, gate, touch)
    monkeypatch.setattr(real_orders, "send_waiting", collide_on_the_second)
    done = look(c)
    assert done["ran"] and len(done["sent"]) == 1 and len(c.fake.sent) == 1
    assert "stopped early" in done["notes"][-1]
