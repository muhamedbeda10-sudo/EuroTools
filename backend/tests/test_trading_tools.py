"""Protective orders, the assistant's trading limits and tools, its settings and the autopilot."""
import json
from types import SimpleNamespace

import pytest

from app import assistant
from app.assistant_tools import parse
from app.config import Settings
from app.data.feed import Feed
from app.llm import ClaudeModel
from app.services import App
from app.store.sqlite_store import Store
from tests.test_assistant import Script, app_with, call, new_chat, results_of, say, trades
from tests.test_audit import DAYS, FLAT, FakeFeed, bars, client, clock, load, rising  # noqa: F401 - `clock` is a fixture


@pytest.fixture(autouse=True)
def _fresh_feed():
    Feed.reset()
    yield
    Feed.reset()


def order(c, symbol, kind, price, **more):
    return c.post("/api/v1/orders", json={"symbol": symbol, "kind": kind, "price": price, **more})


def process(c):
    return c.post("/api/v1/paper-runs/process").json()


def buy(c, symbol="COMI", qty=1000):
    r = c.post("/api/v1/trades", json={"side": "BUY", "symbol": symbol, "qty": qty})
    assert r.status_code == 201, r.text


# =============================================================================
# protective orders
# =============================================================================
def test_a_stop_loss_sells_by_itself_and_closes_the_take_profit_with_it(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    assert order(c, "COMI", "stop", 9.5).status_code == 422                       # nothing held yet
    buy(c)
    assert "below the latest price" in order(c, "COMI", "stop", 10.5).json()["detail"]
    assert "above the latest price" in order(c, "COMI", "target", 9.0).json()["detail"]
    assert "only 1000 COMI are held" in order(c, "COMI", "stop", 9.5, qty=5000).json()["detail"]
    first = order(c, "COMI", "stop", 9.0).json()
    stop = order(c, "COMI", "stop", 9.5, note="thesis broken").json()            # a new stop replaces the old one
    target = order(c, "COMI", "target", 12).json()
    listed = c.get("/api/v1/orders").json()
    assert {o["id"] for o in listed} == {stop["id"], target["id"]} and first["id"] not in {o["id"] for o in listed}
    assert stop["name"] == "Stop-loss" and stop["distance_pct"] == pytest.approx(-5.0) and stop["created_session"] == DAYS[29]
    assert process(c)["orders"] == []                                             # nothing reached yet

    # next session: opens at 10, trades down to 9.0, closes at 9.8 -> the stop fills at 9.50, not at the low or the close
    load(c, "COMI", bars(FLAT) + [(DAYS[30], 10, 10.1, 9.0, 9.8, 1000)])
    done = process(c)["orders"]
    assert [(o["symbol"], o["kind"], o["qty"], o["price"], o["date"]) for o in done] == [("COMI", "stop", 1000, 9.5, DAYS[30])]
    assert "Stop-loss on COMI: sold 1,000 at 9.5" in done[0]["message"]
    sell = trades(c)[0]
    assert (sell["type"], sell["price"], sell["trade_date"], sell["origin"]) == ("SELL", 9.5, DAYS[30], f"order:{stop['id']}")
    assert sell["note"] == "Stop-loss at 9.5000: thesis broken" and sell["realized_gross"] == pytest.approx(-500.0)
    assert process(c)["orders"] == [] and c.get("/api/v1/orders").json() == []    # idempotent; the target went with the position
    closed = {o["id"]: o for o in c.get("/api/v1/orders", params={"status": "all"}).json()}
    assert closed[stop["id"]]["status"] == "filled" and closed[stop["id"]]["filled"]["seq"] == sell["seq"]
    assert closed[target["id"]]["status"] == "cancelled" and closed[target["id"]]["reason"] == "the position was closed"
    assert any(a["entity"] == "protective_order" and a["action"] == "fill" for a in c.get("/api/v1/audit").json())


def test_gaps_targets_and_the_day_the_order_was_placed(tmp_path):
    c = client(tmp_path)
    # the placement day itself already traded down to 9.0 before the order existed: that must not trigger it
    load(c, "COMI", bars(FLAT[:-1]) + [(DAYS[29], 10, 10.1, 9.0, 10.0, 1000)])
    load(c, "TMGH", bars(FLAT))
    load(c, "SWDY", bars(FLAT))
    for symbol in ("COMI", "TMGH", "SWDY"):
        buy(c, symbol, 100)
    order(c, "COMI", "stop", 9.5)
    order(c, "TMGH", "target", 11)
    order(c, "SWDY", "target", 11)
    kept = order(c, "SWDY", "stop", 9.5).json()
    assert process(c)["orders"] == []
    load(c, "COMI", bars(FLAT[:-1]) + [(DAYS[29], 10, 10.1, 9.0, 10.0, 1000), (DAYS[30], 9.2, 9.4, 9.0, 9.3, 1000)])   # gaps below the stop
    load(c, "TMGH", bars(FLAT) + [(DAYS[30], 10, 11.5, 9.9, 11.2, 1000)])                                            # trades up through 11
    load(c, "SWDY", bars(FLAT) + [(DAYS[30], 11.4, 11.6, 11.3, 11.5, 1000)])                                         # gaps above 11
    got = {o["symbol"]: (o["kind"], o["price"]) for o in process(c)["orders"]}
    assert got == {"COMI": ("stop", 9.2), "TMGH": ("target", 11.0), "SWDY": ("target", 11.4)}    # a gap fills at the open
    assert c.get("/api/v1/portfolio").json()["holdings"] == []
    process(c)
    assert next(o for o in c.get("/api/v1/orders", params={"status": "all"}).json() if o["id"] == kept["id"])["status"] == "cancelled"

    # cancelling, and an order that covers more than is left after a manual sale
    buy(c, "TMGH", 100)
    a = order(c, "TMGH", "stop", 10.5).json()
    assert c.delete(f"/api/v1/orders/{a['id']}").json()["status"] == "cancelled"
    assert c.delete(f"/api/v1/orders/{a['id']}").status_code == 422 and c.delete("/api/v1/orders/nope").status_code == 404
    order(c, "TMGH", "stop", 10.5)
    c.post("/api/v1/trades", json={"side": "SELL", "symbol": "TMGH", "qty": 60})
    load(c, "TMGH", bars(FLAT) + [(DAYS[30], 10, 11.5, 9.9, 11.2, 1000), (DAYS[31], 11.2, 11.3, 10.0, 10.2, 1000)])
    (fill,) = process(c)["orders"]
    assert (fill["qty"], fill["price"]) == (40, 10.5)                                 # sells what is still held, no more


def test_during_the_session_a_stop_acts_on_the_latest_price(tmp_path, clock):  # noqa: F811
    fake = FakeFeed()
    fake.bars[1] = rising()
    c = client(tmp_path, younit=fake)
    clock(2026, 11, 12, 18)
    c.post("/api/v1/data/refresh")
    buy(c, "COMI", 100)                                                               # at Thursday's close, 106
    assert order(c, "COMI", "stop", 104).status_code == 201
    clock(2026, 11, 15, 11)
    fake.quotes = {"COMI": [105.0, 106.0, 106.5, 104.5, 500.0]}
    c.post("/api/v1/data/live")
    assert process(c)["orders"] == []                                                 # 105: above the stop
    clock(2026, 11, 15, 11, 5)
    fake.quotes = {"COMI": [103.2, 106.0, 106.5, 103.0, 900.0]}
    c.post("/api/v1/data/live")
    (fill,) = process(c)["orders"]
    assert (fill["kind"], fill["price"], fill["date"]) == ("stop", 103.2, "2026-11-15")   # the price seen, on today's session
    assert c.get("/api/v1/portfolio").json()["holdings"] == []


# =============================================================================
# the assistant's own trading: limits, sizing, screening
# =============================================================================
def run_tool(core, tool_name, /, **args):
    tool, parsed, problem = parse(tool_name, args)
    assert problem is None, problem
    content, failed = assistant._execute(core, tool, parsed)
    return json.loads(content), failed


def test_the_assistants_trades_stay_inside_the_users_limits(tmp_path):
    core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()
    last = core.preview_trade("BUY", "COMI", 1, None)["price"]
    too_big = int(50000 * 0.21 / last) + 1                                           # just over 20% of the portfolio
    out, failed = run_tool(core, "place_trade", side="BUY", symbol="COMI", qty=too_big)
    assert failed and "per trade" in out["error"] and "Settings -> Assistant" in out["error"]
    fits = int(50000 * 0.12 / last)
    out, failed = run_tool(core, "place_trade", side="BUY", symbol="COMI", qty=fits)
    assert not failed and out["recorded"]["qty"] == fits
    out, failed = run_tool(core, "place_trade", side="BUY", symbol="COMI", qty=fits)   # twice 12% in one stock: the first stays inside 25%
    assert not failed
    out, failed = run_tool(core, "place_trade", side="BUY", symbol="COMI", qty=fits)
    assert failed and "per stock" in out["error"]
    assert [t["origin"] for t in core.trades()["transactions"][:2]] == ["assistant", "assistant"]
    # the user loosens one limit and tightens another in Settings
    from app.assistant_prefs import PrefsIn, save_prefs
    saved = save_prefs(core, PrefsIn(max_position_pct=60, max_trades_per_day=3))
    assert saved["limits"] == {"max_position_pct": 60.0, "max_trade_pct": 20.0, "max_trades_per_day": 3, "min_cash_pct": 5.0}
    out, failed = run_tool(core, "place_trade", side="BUY", symbol="COMI", qty=fits)
    assert not failed
    out, failed = run_tool(core, "place_trade", side="SELL", symbol="COMI", qty=1)    # the fourth trade today
    assert failed and "limit of 3 trades for today" in out["error"]
    # a trade placed by hand is not the assistant's and is not counted or limited
    assert core.post_trade("BUY", "TMGH", 5, None, "", None)["origin"] == "manual"
    save_prefs(core, PrefsIn(max_trades_per_day=50, min_cash_pct=80))
    out, failed = run_tool(core, "place_trade", side="BUY", symbol="TMGH", qty=10)
    assert failed and "in cash" in out["error"]


def test_sizing_and_screening(tmp_path):
    core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()
    last = core.preview_trade("BUY", "COMI", 1, None)["price"]
    size, failed = run_tool(core, "size_position", symbol="comi", stop_pct=5, risk_pct=1)
    assert not failed and size["stop"] == pytest.approx(last * 0.95, abs=1e-3)
    # 1% of 50,000 at risk over a 5% stop is a 20% position: exactly what the per-trade limit allows too
    assert size["shares"] == min(int(500 // (last * 0.05)), int(10000 // (last * 1.006)))
    assert size["loss_if_stopped"] <= 500 and size["cost_with_fees"] <= 10000 and size["limited_by"]
    tight, _ = run_tool(core, "size_position", symbol="COMI", stop_pct=1, risk_pct=5)
    assert tight["limited_by"] == "the per-trade limit" and tight["shares"] == int(10000 // (last * 1.006))
    out, failed = run_tool(core, "size_position", symbol="COMI", stop_price=last * 2)
    assert failed and "below the latest price" in out["error"]
    out, failed = run_tool(core, "size_position", symbol="COMI")
    assert failed and "stop_price or stop_pct" in out["error"]

    everything, _ = run_tool(core, "screen_stocks", limit=40, sort_by="rsi")
    assert everything["screened"] == 53 and everything["matching"] == 53 and len(everything["stocks"]) == 40
    rsis = [s["rsi"] for s in everything["stocks"]]
    assert rsis == sorted(rsis, reverse=True) and {"trend", "above_sma50", "pct_from_high", "avg_turnover_20"} <= set(everything["stocks"][0])
    up, _ = run_tool(core, "screen_stocks", trend="uptrend", above_sma50=True, rsi_max=75, sector="Banks")
    assert all(s["trend"] == "uptrend" and s["above_sma50"] and s["rsi"] <= 75 and s["sector"] == "Banks" for s in up["stocks"])
    liquid, _ = run_tool(core, "screen_stocks", min_avg_turnover=1e12)
    assert liquid["matching"] == 0
    near, _ = run_tool(core, "screen_stocks", within_pct_of_high=3, sort_by="pct_from_high")
    assert all(s["pct_from_high"] >= -3 for s in near["stocks"])
    # protective orders through the assistant's tools
    run_tool(core, "place_trade", side="BUY", symbol="COMI", qty=10)
    listed, _ = run_tool(core, "protective_orders")
    assert listed["orders"] == [] and listed["holdings_without_a_stop"] == ["COMI"]
    placed, failed = run_tool(core, "set_protective_order", symbol="COMI", kind="stop", price=round(last * 0.9, 2))
    assert not failed and placed["origin"] == "assistant"
    assert run_tool(core, "protective_orders")[0]["holdings_without_a_stop"] == []
    assert run_tool(core, "cancel_protective_order", id=placed["id"])[0]["status"] == "cancelled"


# =============================================================================
# settings and autopilot
# =============================================================================
def test_the_model_and_everything_else_are_chosen_in_settings(tmp_path):
    with app_with(tmp_path, Script({"say": "hi"})) as c:
        status = c.get("/api/v1/assistant").json()
        assert status["model"] == "claude-opus-5-5" and status["settings"]["effort"] == "medium"
        assert [m["id"] for m in status["models"]] == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]
        assert status["models"][1]["input_usd_per_mtok"] == 2.0 and status["autopilot"]["mode"] == "off"
        out = c.put("/api/v1/assistant/settings", json={"model": "claude-sonnet-5-5", "effort": "high", "daily_usd": 2,
                                                         "access": "confirm", "max_trade_pct": 10}).json()
        assert (out["model"], out["settings"]["effort"], out["daily_limit_usd"], out["access"]) == ("claude-sonnet-5-5", "high", 2.0, "confirm")
        assert out["settings"]["limits"]["max_trade_pct"] == 10 and out["settings"]["limits"]["max_position_pct"] == 25
        assert c.put("/api/v1/assistant/settings", json={"model": "gpt-9"}).status_code == 422
        assert c.put("/api/v1/assistant/settings", json={"max_trade_pct": 500}).status_code == 422
        assert c.put("/api/v1/assistant/access", json={"access": "full"}).json() == {"access": "full"}
        assert c.get("/api/v1/assistant").json()["settings"]["model"] == "claude-sonnet-5-5"      # one change leaves the rest alone
        assert any(a["entity"] == "assistant_settings" for a in c.get("/api/v1/audit").json())

    # the real wrapper serves each account's choice on one shared connection
    sent = []

    class Stream:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def __iter__(self):
            return iter([])

        def get_final_message(self):
            usage = SimpleNamespace(input_tokens=1, output_tokens=1, cache_read_input_tokens=0, cache_creation_input_tokens=0)
            text = SimpleNamespace(type="text", text="ok")
            return SimpleNamespace(content=[text], stop_reason="end_turn", model="x", usage=usage, stop_details=None)

    fake = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=lambda **kw: (sent.append(kw), Stream())[1])))
    base = ClaudeModel("key", client=fake)
    cheap = base.using("claude-haiku-5-5", "low")
    list(cheap.turn(system="S", tools=[], messages=[{"role": "user", "content": "hi"}]))
    list(base.turn(system="S", tools=[], messages=[{"role": "user", "content": "hi"}]))
    assert [(k["model"], k["output_config"]["effort"]) for k in sent] == [("claude-haiku-5-5", "low"), ("claude-opus-5-5", "medium")]
    assert "display" not in sent[0]["thinking"] and sent[1]["thinking"]["display"] == "updates"   # progress notes only where supported
    assert cheap.client is base.client
    cheap.plain = True
    assert base.using("claude-haiku-5-5").plain is True and base.plain is False


class Chosen(Script):
    """A stand-in that, like the real wrapper, is asked for a model by name: it records which one each call ran on,
    and can be told that one of them is not available to the key."""

    def __init__(self, *turns, unavailable=(), _root=None, _name="claude-opus-5-5"):
        super().__init__(*turns)
        self.root, self.name, self.unavailable = _root or self, _name, unavailable
        self.ran = []

    def using(self, model=None, effort=None):
        return Chosen(unavailable=self.root.unavailable, _root=self.root, _name=model or self.name)

    def check(self):
        return "not available to this key" if self.name in self.root.unavailable else None

    def turn(self, **kw):
        if self is not self.root:
            self.root.ran.append(self.name)
            self.turns, self.seen = self.root.turns, self.root.seen
        yield from super().turn(**kw)


def test_the_model_that_trades_by_itself_is_chosen_apart_from_the_one_in_conversations(tmp_path):
    script = Chosen({"say": "hi"}, {"say": "Nothing to do today."}, {"say": "Because nothing moved."}, {"say": "hi again"},
                    unavailable=("claude-fable-5-2",))
    with app_with(tmp_path, script) as c:
        status = c.get("/api/v1/assistant").json()
        # until one is chosen for it, its own reviews run on the conversations' model: what was saved before means the same
        assert (status["model"], status["trading_model"], status["settings"]["trading_model"]) == ("claude-opus-5-5",) * 2 + ("same",)
        out = c.put("/api/v1/assistant/settings", json={"model": "claude-sonnet-5-5", "trading_model": "claude-fable-5-2"}).json()
        assert (out["model"], out["trading_model"], out["settings"]["trading_model"]) == ("claude-sonnet-5-5",) + ("claude-fable-5-2",) * 2
        assert out["trading_problem"] is None and out["problem"] is None          # its reviews are off: that model is not asked about
        assert c.put("/api/v1/assistant/settings", json={"trading_model": "gpt-9"}).status_code == 422
        chat = new_chat(c)
        assert say(c, chat, "hello")[-1]["type"] == "done"
        out = c.put("/api/v1/assistant/settings", json={"autopilot_mode": "after_close"}).json()
        assert out["trading_problem"] == "not available to this key" and out["problem"] is None
        review = c.post("/api/v1/assistant/autopilot").json()
        assert review["ran"] and review["error"] is None
        assert say(c, review["chat"], "why nothing?")[-1]["type"] == "done"      # a reply in a review stays on the review's model
        assert say(c, chat, "hello again")[-1]["type"] == "done"
        assert script.ran == ["claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-2", "claude-sonnet-5-5"]
        # each call is costed at its own model's prices: 1,000 tokens in and 200 out
        by = c.get("/api/v1/assistant").json()["spending"]["today_by"]
        assert by == {"chat": 0.008, "autopilot": 0.032}
        # the assistant is told which model does what, by the tool it reads its settings with
        core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()
        assert run_tool(core, "settings")[0]["assistant"]["models"] == {"conversations": "claude-sonnet-5-5",
                                                                        "trading_by_itself": "claude-fable-5-2"}
        # "same" hands the reviews back to the conversations' model, and changing that one then moves both
        out = c.put("/api/v1/assistant/settings", json={"trading_model": "same", "model": "claude-haiku-5-5"}).json()
        assert (out["model"], out["trading_model"], out["trading_problem"]) == ("claude-haiku-5-5", "claude-haiku-5-5", None)
        saved = [a for a in c.get("/api/v1/audit").json() if a["entity"] == "assistant_settings"]
        assert any("trading_model" in json.dumps(a) for a in saved)


def test_the_autopilot_reviews_once_per_session_inside_the_limits(tmp_path):
    script = Script({"calls": [call(1, "screen_stocks", trend="uptrend"), call(2, "place_trade", side="BUY", symbol="COMI", qty=5)]},
                    {"calls": [call(3, "set_protective_order", symbol="COMI", kind="stop", price=1.0)]},
                    {"say": "اشتريت 5 COMI وحطيت وقف خسارة."},
                    {"say": "No changes today."})
    with app_with(tmp_path, script) as c:
        assert c.post("/api/v1/assistant/autopilot").json()["ran"] is False and script.seen == []       # off unless switched on
        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "after_close", "autopilot_mandate": "ركز على البنوك ومتخاطرش بأكتر من 1%"})
        assert c.get("/api/v1/assistant").json()["autopilot"]["due"] == "close"
        out = c.post("/api/v1/assistant/autopilot").json()
        assert out["ran"] and out["changes"] == 2 and out["error"] is None and "COMI" in out["summary"]
        brief = script.seen[0]["messages"][0]["content"][0]["text"]
        assert brief.startswith("AUTOPILOT REVIEW") and "ركز على البنوك" in brief and "- no holdings" in brief
        assert "at most 20% of the portfolio per trade" in brief and "(0 used today)" in brief
        assert "page autopilot; access full" in script.seen[0]["messages"][0]["content"][1]["text"]
        (trade,) = trades(c)
        assert trade["origin"] == "assistant" and c.get("/api/v1/orders").json()[0]["kind"] == "stop"
        # the same session is not reviewed twice, in this window or another
        again = c.post("/api/v1/assistant/autopilot").json()
        assert again["ran"] is False and again["due"] is None and len(script.seen) == 3
        listed = c.get("/api/v1/assistant").json()
        assert listed["chats"][0]["kind"] == "autopilot" and listed["chats"][0]["title"].startswith("Autopilot · ")
        assert listed["autopilot"]["last_chat"] == out["chat"]
        # with anything less than full access the review looks and reports only
        c.put("/api/v1/assistant/settings", json={"access": "confirm"})
        from app.assistant_prefs import note_autopilot
        core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()
        note_autopilot(core, last_session="2000-01-01")                                                # as if a new session had closed
        out = c.post("/api/v1/assistant/autopilot").json()
        assert out["ran"] and out["changes"] == 0 and out["summary"] == "No changes today."
        later = script.seen[3]["messages"][0]["content"]
        assert "stop-loss 1" in later[0]["text"] and "access read" in later[1]["text"]                  # holdings listed with their stops


def test_autopilot_with_look_only_access_cannot_trade_and_respects_the_budget(tmp_path):
    script = Script({"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=5)]}, {"say": "I could not trade."})
    with app_with(tmp_path, script, assistant_daily_usd=0.01) as c:
        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "after_close", "access": "read"})
        out = c.post("/api/v1/assistant/autopilot").json()
        assert out["ran"] and out["changes"] == 0 and trades(c) == []
        assert results_of(script.seen[1]["messages"][2])[0]["is_error"]
        core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path, assistant_daily_usd=0.01)).bootstrap()
        from app.assistant_prefs import note_autopilot
        note_autopilot(core, last_session="2000-01-01")
        out = c.post("/api/v1/assistant/autopilot").json()                                             # 0.016 spent: over the ceiling
        assert out["ran"] is False and "budget" in out["skipped"] and len(script.seen) == 2
        chat = new_chat(c)
        assert c.post(f"/api/v1/assistant/chats/{chat}/messages", json={"text": "hi"}).status_code == 422
        c.put("/api/v1/assistant/settings", json={"daily_usd": 50})                                    # the user raises it
        script.turns.append({"say": "hello"})
        assert say(c, chat, "hi")[-1]["type"] == "done"
