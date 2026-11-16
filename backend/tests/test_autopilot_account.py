"""The account the autopilot works on: the paper portfolio, the real account, or both (no network, no cost).

The owner chooses it in Settings → Assistant. The choice is kept by the app, not left to the model: a review
made for one account is refused the tools that move the other account's money, and nothing here opens a new
way to the broker: a review still only writes proposals.
"""
from contextlib import contextmanager
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import assistant, broker, push, real_orders, wakes
from app.assistant_prefs import autopilot_account, prefs
from app.assistant_tools import TOOLS
from app.config import Settings
from app.data.calendar import CAIRO
from app.data.feed import Feed, StoreDocs
from app.data.younit import YounitError
from app.main import create_app
from app.services import App
from app.store.sqlite_store import Store
from tests.test_assistant import Script, call, new_chat, results_of, say, trades
from tests.test_broker import FakeBroker, last_price
from tests.test_real_auto import a_floor, bought, on
from tests.test_real_auto import core_of as floor_core

OPEN = datetime(2026, 11, 15, 11, 0, tzinfo=CAIRO)        # a Sunday, mid-session
ARMED = {"enabled": True, "max_order_value": 5000, "max_day_value": 8000, "max_day_orders": 3, "price_band_pct": 2, "symbols": []}
WHY = "Closed above its 50-day average on twice the usual volume; wrong if it closes back under 34."
SETTINGS = "/api/v1/assistant/settings"
REVIEW = {"due": "close", "session": "2026-11-15"}


@pytest.fixture(autouse=True)
def _fresh():
    for module in (Feed, broker, real_orders):
        module.reset()
    yield
    for module in (Feed, broker, real_orders):
        module.reset()


@contextmanager
def desk(tmp_path, monkeypatch, script, *, owner=True):
    """The API with the assistant and a broker behind it, in the middle of a session. `owner` says whether this
    sign-in is the brokerage account's owner."""
    monkeypatch.setattr(real_orders, "cairo_now", lambda: OPEN)
    tmp_path.mkdir(exist_ok=True)
    fake = FakeBroker()
    app = create_app(Settings(data_dir=tmp_path, younit_trading_id="", younit_api_key="", live_trading_enabled=True,
                              broker_account_uids="local" if owner else ""),
                     Store(tmp_path / "t.sqlite3"), younit=fake, assistant_model=script)
    with TestClient(app) as c:
        c.post("/api/v1/data/refresh")
        c.fake, c.dir = fake, tmp_path
        yield c


def core_of(c, *, owner=True) -> App:
    store = Store(c.dir / "t.sqlite3")
    core = App(store, Settings(data_dir=c.dir, live_trading_enabled=True), {}, Feed(StoreDocs(store)), c.fake).bootstrap()
    core.real_account_allowed = owner
    return core


def arm(c):
    assert c.put("/api/v1/real-orders/settings", json=ARMED).status_code == 200


def choose(c, **change):
    res = c.put(SETTINGS, json={"autopilot_mode": "after_close", **change})
    assert res.status_code == 200, res.text
    return res.json()


def review(c):
    return c.post("/api/v1/assistant/autopilot").json()


def brief_of(script, n=0) -> str:
    return script.seen[n]["messages"][0]["content"][0]["text"]


def waiting(c) -> list[dict]:
    return c.get("/api/v1/real-orders").json()["waiting"]


# ---- the choice itself -----------------------------------------------------------------
def test_the_owner_chooses_the_account_and_nobody_else_can_choose_the_real_one(tmp_path, monkeypatch):
    with desk(tmp_path / "owner", monkeypatch, Script()) as c:
        s = c.get("/api/v1/assistant").json()
        assert s["autopilot_accounts"] == ["paper", "real", "both"]
        # nothing was chosen yet: it works as it always did, on both
        assert s["settings"]["autopilot"]["account"] == "both" and s["autopilot"]["account"] == "both" and s["autopilot"]["blocked"] is None
        for account in ("real", "paper", "both", "real"):
            saved = c.put(SETTINGS, json={"autopilot_account": account}).json()
            assert saved["settings"]["autopilot"]["account"] == account == saved["autopilot"]["account"] and saved["autopilot"]["blocked"] is None
        assert c.put(SETTINGS, json={"autopilot_account": "margin"}).status_code == 422
        assert c.put(SETTINGS, json={"autopilot_max_per_day": 5}).json()["settings"]["autopilot"]["account"] == "real"   # one change leaves the rest
        logged = [a["detail"] for a in c.get("/api/v1/audit").json() if a["entity"] == "assistant_settings"]
        assert any("autopilot_account" in str(d) and "real" in str(d) for d in logged)                 # the choice is in the activity log
        # a value nobody could have saved reads as "both"
        Store(c.dir / "t.sqlite3").put("settings", "assistant", {"autopilot": {"account": "margin"}})
        assert c.get("/api/v1/assistant").json()["settings"]["autopilot"]["account"] == "both"

    with desk(tmp_path / "guest", monkeypatch, Script(), owner=False) as c:
        s = c.get("/api/v1/assistant").json()
        # without a real account "both" is simply the paper portfolio
        assert s["settings"]["autopilot"]["account"] == "both" and s["autopilot"]["account"] == "paper" and s["autopilot"]["blocked"] is None
        res = c.put(SETTINGS, json={"autopilot_account": "real"})
        assert res.status_code == 422 and "Only the brokerage account's owner" in res.json()["detail"]
        assert c.get("/api/v1/assistant").json()["settings"]["autopilot"]["account"] == "both"
        # the page sends back what was saved with every save: that still saves, and so does the paper portfolio
        assert c.put(SETTINGS, json={"autopilot_account": "both", "autopilot_mode": "after_close"}).status_code == 200
        assert c.put(SETTINGS, json={"autopilot_account": "paper"}).json()["autopilot"]["account"] == "paper"


def test_the_tools_that_move_money_say_whose_money_it_is():
    assert {t.name: t.account for t in TOOLS if t.account} == {
        "propose_real_order": "real", "withdraw_real_order_proposal": "real", "update_settings": "paper", "place_trade": "paper", "set_protective_order": "paper", "cancel_protective_order": "paper",
        "start_paper_run": "paper", "set_paper_run_status": "paper", "reset_portfolio": "paper"}
    assert all(t.kind != "read" for t in TOOLS if t.account)       # none of them is a look: "look only" stops them all as well
    prompt = assistant.system_prompt()
    assert "which account the autopilot works on" in prompt and "refuses the tools that move the other account's money" in prompt


# ---- the paper portfolio only ------------------------------------------------------------
def test_set_to_the_paper_portfolio_a_review_writes_nothing_for_the_real_account(tmp_path, monkeypatch):
    script = Script({"calls": [call(1, "propose_real_order", symbol="COMI", side="BUY", qty=10, limit_price=35.9, reason=WHY),
                               call(2, "place_trade", side="BUY", symbol="COMI", qty=5)]},
                    {"say": "Bought 5 COMI on paper."})
    with desk(tmp_path, monkeypatch, script) as c:
        arm(c)                                                                  # real orders are on: it could propose, were it allowed to
        choose(c, autopilot_account="paper", autopilot_mandate="Buy COMI with real money every day.")
        out = review(c)
        assert out["ran"] and out["account"] == "paper" and out["changes"] == 1 and out["error"] is None
        brief = brief_of(script)
        assert brief.startswith("AUTOPILOT REVIEW") and "Portfolio: total EGP" in brief and "Limits enforced on your trades" in brief
        assert "PAPER portfolio only: write no proposal for the real account in this review, whatever the mandate says" in brief
        assert "Real orders are switched on" not in brief and "REAL brokerage account" not in brief
        # the app, not the brief, keeps it: the proposal is refused whatever the mandate asks, and the paper trade goes through
        refused, placed = results_of(script.seen[1]["messages"][2])
        assert refused["is_error"] and "paper portfolio only" in refused["content"] and not placed.get("is_error")
        assert waiting(c) == [] and c.fake.sent == [] and c.fake.reads.count("power") == 0
        assert [(t["symbol"], t["origin"]) for t in trades(c)] == [("COMI", "assistant")]
        assert c.get("/api/v1/assistant").json()["chats"][0]["title"].startswith("Autopilot · 20")
        # the fence is the review's own: asked in a conversation, the assistant may still prepare a real order
        comi = round(last_price(c, "COMI"), 3)
        script.turns += [{"calls": [call(3, "propose_real_order", symbol="COMI", side="BUY", qty=10, limit_price=comi, reason=WHY)]},
                         {"say": "Prepared. It waits for your approval."}]
        say(c, new_chat(c), "prepare a real order for 10 COMI")
        assert [w["origin"] for w in waiting(c)] == ["assistant"] and c.fake.sent == []
        assert "- Autopilot: they set it to work on the paper portfolio only" in script.seen[-1]["system"]
        # with real orders off there is nothing to say about them: the review reads as it always did
        assert c.put("/api/v1/real-orders/settings", json={**ARMED, "enabled": False}).status_code == 200
        quiet = assistant._brief(core_of(c), prefs(core_of(c)), REVIEW)
        assert "PAPER portfolio only" not in quiet and "Portfolio: total EGP" in quiet


def test_a_real_exit_does_not_wake_an_autopilot_set_to_the_paper_portfolio(tmp_path):
    core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()
    look = {"exits": [{"status": "sent", "symbol": "COMI", "qty": 10, "price": "34.5", "reason": "Stop-loss 34.60 reached."}]}
    for account, told in (("paper", 0), ("real", 1), ("both", 1)):
        core.store.put("settings", "assistant", {"autopilot": {"mode": "events", "account": account}})
        assert wakes.note_exits(core, look) == told, account
    assert [e["kind"] for e in wakes.pending(core)] == ["real_exit", "real_exit"]


# ---- the real account only ---------------------------------------------------------------
def test_set_to_the_real_account_a_review_is_about_it_and_leaves_the_paper_portfolio_alone(tmp_path, monkeypatch):
    script = Script()
    with desk(tmp_path, monkeypatch, script) as c:
        comi = round(last_price(c, "COMI"), 3)
        c.fake.hold((1, None, "Commercial Bank", 10, 6, comi - 1, comi))
        arm(c)
        choose(c, autopilot_account="real", autopilot_mandate="خليك في الأسهم السايلة وماتخاطرش بأكتر من 1%")
        script.turns += [{"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=5),
                                    call(2, "reset_portfolio"),
                                    call(3, "start_paper_run", strategy_id="x", capital=1000),
                                    call(4, "propose_real_order", symbol="COMI", side="BUY", qty=10, limit_price=comi, reason=WHY,
                                         stop_price=round(comi * 0.95, 2))]},
                         {"say": "Proposed a buy of 10 COMI; it waits for your approval."}]
        out = review(c)
        assert out["ran"] and out["account"] == "real" and out["changes"] == 1 and out["error"] is None

        brief = brief_of(script)
        assert brief.startswith("AUTOPILOT REVIEW") and "خليك في الأسهم السايلة" in brief
        assert "REAL brokerage account, and on nothing else" in brief and "Your paper tools" in brief
        assert "Real account, the broker's own figures" in brief and "cash EGP 5,000.25" in brief
        assert f"- COMI: 10 shares (6 free to sell), average cost {comi - 1:g}, the broker's price {comi:g}" in brief
        assert "You may write 20 more today, of the 20 the owner allows in one day" in brief
        assert "at most EGP 5,000.00 per order; EGP 8,000.00 and 3 orders in one day" in brief and "no more than 2% above the market" in brief
        assert "Automatic orders are off: a proposal is not sent" in brief and "AUTOMATIC REAL ORDERS ARE ON" not in brief
        assert "size it from the real account's own figures" in brief and "(1) read real_orders" in brief
        # the paper portfolio is no part of it: neither its figures nor the limits on paper trades
        for paper in ("Portfolio: total EGP", "Limits enforced on your trades", "set_protective_order", "only if the mandate asks"):
            assert paper not in brief, paper

        # the paper tools are refused by the app; the proposal is written, and nothing reaches the broker
        *paper_calls, proposed = results_of(script.seen[1]["messages"][2])
        assert len(paper_calls) == 3 and all(r["is_error"] and "real account only" in r["content"] for r in paper_calls)
        assert not proposed.get("is_error") and "Nothing was sent" in proposed["content"]
        assert trades(c) == [] and c.get("/api/v1/portfolio").json()["holdings"] == []
        (one,) = waiting(c)
        assert (one["origin"], one["symbol"], one["side"], one["qty"], one["status"]) == ("assistant", "COMI", "BUY", 10, "proposed")
        assert c.fake.sent == [] and c.fake.cancels == []
        listed = c.get("/api/v1/assistant").json()
        assert listed["chats"][0]["kind"] == "autopilot" and listed["chats"][0]["title"].startswith("Autopilot · real account · ")

        # the fence is the review's own: asked in a conversation, the assistant still trades on paper
        script.turns += [{"calls": [call(5, "place_trade", side="BUY", symbol="COMI", qty=5)]}, {"say": "Bought 5 COMI on paper."}]
        say(c, new_chat(c), "buy 5 COMI on paper")
        assert [(t["symbol"], t["qty"]) for t in trades(c)] == [("COMI", 5)]
        assert "- Autopilot: they set it to work on their REAL brokerage account only" in script.seen[-1]["system"]


def test_a_review_of_the_real_account_is_told_plainly_what_it_cannot_do(tmp_path, monkeypatch):
    with desk(tmp_path, monkeypatch, Script()) as c:
        choose(c, autopilot_account="real")

        def brief(**state):
            core = core_of(c)
            return assistant._brief(core, prefs(core), {**REVIEW, **state})

        # the owner has not switched real orders on: it looks and reports
        told = brief()
        assert "You cannot write a proposal for a real order in this review: Real orders are switched off in Settings → Real trading." in told
        assert "- no holdings" in told and "Change nothing in the paper portfolio" in told
        assert "propose_real_order" not in told and "(1) read real_orders" not in told
        assert "(none written) Look after the real account prudently" in told
        # switched on, but the owner allows it no proposals
        arm(c)
        choose(c, real_proposals_per_day=0)
        told = brief()
        assert "You cannot write a proposal for a real order in this review: the owner allows you none" in told
        assert "On this account you act by writing proposals" not in told
        choose(c, real_proposals_per_day=20)
        assert "On this account you act by writing proposals (propose_real_order)" in brief()
        # with anything less than full access it is told so, instead of being asked for what will be refused
        core = core_of(c)
        looking = assistant._brief(core, prefs(core), REVIEW, may_act=False)
        assert "only with Full access" in looking and "On this account you act by writing proposals" not in looking
        # a review that a watch started is a short one, and still about the real account
        woken = brief(due="event")
        assert woken.startswith("AUTOPILOT WAKE-UP") and "REAL brokerage account, and on nothing else" in woken
        assert "If you propose an order, size it from the real account's own figures" in woken and "Portfolio: total EGP" not in woken
        # the broker does not answer: the review is not lost, it is told to read the account itself first
        broker.reset()
        c.fake.error = YounitError("the broker did not answer")
        told = brief()
        assert "The real account could not be read just now (the broker did not answer)" in told and "Read it with real_account" in told
        assert "On this account you act by writing proposals" in told


def test_with_automatic_orders_on_a_review_of_the_real_account_knows_its_proposals_are_sent(tmp_path, monkeypatch):
    with a_floor(tmp_path, monkeypatch) as c:
        on(c)
        bought(c, qty=10, stop=34.0, limit_price=35.8)
        core = floor_core(c)
        core.store.put("settings", "assistant", {"autopilot": {"mode": "events", "account": "real"}})
        told = assistant._brief(core, prefs(core), REVIEW)
        assert "REAL brokerage account, and on nothing else" in told and "AUTOMATIC REAL ORDERS ARE ON" in told
        assert "The box: stocks COMI, TMGH" in told and "- the automation holds 10 COMI at about 35.8" in told and "stop-loss 34.0" in told
        assert "Automatic orders are off" not in told and "Portfolio: total EGP" not in told
        assert autopilot_account(core) == "real"


def test_set_to_the_real_account_without_one_no_review_runs_and_the_way_back_is_open(tmp_path, monkeypatch):
    script = Script({"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=5)]}, {"say": "x"})
    with desk(tmp_path, monkeypatch, script, owner=False) as c:
        # as if the account had been disconnected after its owner chose it
        Store(c.dir / "t.sqlite3").put("settings", "assistant", {"autopilot": {"mode": "after_close", "account": "real"}})
        out = review(c)
        assert out["ran"] is False and out["skipped"] == "the real account is not available" and out["due"] == "close"
        assert "not connected or not enabled for this sign-in" in out["why"] and "Choose the paper portfolio" in out["why"]
        assert script.seen == [] and trades(c) == []                            # nothing was asked of the model, nothing was traded
        assert c.get("/api/v1/assistant").json()["autopilot"]["blocked"] == out["why"]
        # the page sends back what was saved: that saves; and choosing the paper portfolio lets the reviews run again
        assert c.put(SETTINGS, json={"autopilot_account": "real", "autopilot_max_per_day": 5}).status_code == 200
        assert c.put(SETTINGS, json={"autopilot_account": "paper"}).json()["autopilot"]["blocked"] is None
        out = review(c)
        assert out["ran"] and out["account"] == "paper" and len(trades(c)) == 1


# ---- both, as it always worked -----------------------------------------------------------
def test_left_on_both_a_review_works_as_it_always_did(tmp_path, monkeypatch):
    script = Script()
    with desk(tmp_path, monkeypatch, script) as c:
        comi = round(last_price(c, "COMI"), 3)
        arm(c)
        choose(c, autopilot_mandate="Manage the paper portfolio, and prepare real orders for what you buy.")   # the account is not touched
        script.turns += [{"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=5),
                                    call(2, "propose_real_order", symbol="COMI", side="BUY", qty=10, limit_price=comi, reason=WHY)]},
                         {"say": "Bought on paper and prepared a real order."}]
        out = review(c)
        assert out["ran"] and out["account"] == "both" and out["changes"] == 2
        brief = brief_of(script)
        assert "Portfolio: total EGP" in brief and "Limits enforced on your trades" in brief
        assert "Write a proposal for the real account (propose_real_order) only if the mandate asks for real orders" in brief
        assert "Everything above and every trading tool is the PAPER portfolio" in brief and "and on nothing else" not in brief
        assert not any(r.get("is_error") for r in results_of(script.seen[1]["messages"][2]))
        assert len(trades(c)) == 1 and len(waiting(c)) == 1 and c.fake.sent == []
        assert "- Autopilot:" not in script.seen[0]["system"]                    # nothing was chosen, so nothing is added to say so


def test_the_owner_is_told_which_account_a_review_was_for(tmp_path, monkeypatch):
    said = []
    monkeypatch.setattr(push, "send", lambda core, title, body, **kw: said.append(body) or {"sent": 1, "failed": 0, "removed": 0})
    done = {"ran": True, "changes": 2, "error": None, "notify": True}
    push.review(None, {**done, "account": "real"})
    push.review(None, {**done, "account": "paper"})
    push.review(None, done)
    assert said == ["The assistant reviewed the real account and made 2 change(s). Open the app to read its report.",
                    "The assistant reviewed and made 2 change(s). Open the app to read its report.",
                    "The assistant reviewed and made 2 change(s). Open the app to read its report."]
