"""The in-app assistant, driven by a scripted stand-in for the model: no network, no cost."""
import json
import re
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import assistant, assistant_tools
from app.assistant_tools import MAX_RESULT_CHARS, TOOLS, fold, library, parse, render, tool_specs
from app.config import Settings
from app.llm import (
    BINDING_BETA,
    FALLBACK_BETA,
    UPDATES_BETA,
    AssistantError,
    ClaudeModel,
    cost_usd,
    final_message,
    without_reasoning,
)
from app.main import create_app
from app.services import App
from app.store.sqlite_store import Store

USAGE = {"input": 1000, "output": 200, "cache_read": 0, "cache_write": 0}


def call(n: int, name: str, **args) -> dict:
    return {"id": f"toolu_{n:02d}", "name": name, "input": args}


class Script:
    """Plays back prepared model turns and records what it was sent."""

    name = "claude-opus-5-5"

    def __init__(self, *turns):
        self.turns, self.seen = list(turns), []

    def turn(self, *, system, tools, messages):
        self.seen.append({"system": system, "tools": tools, "messages": json.loads(json.dumps(messages))})
        step = self.turns.pop(0)
        if isinstance(step, Exception):
            raise step
        text = step.get("say", "")
        for word in text.split(" ") if text else []:
            yield {"type": "text", "text": word + " "}
        calls = step.get("calls", [])
        content = [{"type": "thinking", "thinking": "", "signature": f"sig{len(self.seen)}"}]
        content += [{"type": "text", "text": text}] if text else []
        content += [{"type": "tool_use", **c} for c in calls]
        yield {"type": "final", "message": {
            "content": content, "tool_calls": calls, "model": self.name, "refusal_category": None, "usage": dict(USAGE),
            "stop_reason": step.get("stop", "tool_use" if calls else "end_turn")}}


def app_with(tmp_path, script, **settings):
    app = create_app(Settings(data_dir=tmp_path, **settings), Store(tmp_path / "t.sqlite3"), assistant_model=script)
    return TestClient(app)


def events(response) -> list[dict]:
    assert response.status_code == 200, response.text
    return [json.loads(line[5:]) for line in response.text.split("\n") if line.startswith("data:")]


def say(c, chat, text, page="/portfolio"):
    return events(c.post(f"/api/v1/assistant/chats/{chat}/messages", json={"text": text, "page": page}))


def new_chat(c) -> str:
    r = c.post("/api/v1/assistant/chats")
    assert r.status_code == 201, r.text
    return r.json()["id"]


def results_of(message: dict) -> list[dict]:
    return [b for b in message["content"] if b["type"] == "tool_result"]


def trades(c) -> list[dict]:
    return [t for t in c.get("/api/v1/trades").json()["transactions"] if t["type"] != "DEPOSIT"]


# ---- switched off ---------------------------------------------------------------------
def test_without_a_key_the_assistant_is_off(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path), Store(tmp_path / "t.sqlite3"))) as c:
        status = c.get("/api/v1/assistant").json()
        assert status["configured"] is False and status["chats"] == [] and status["model"] is None
        r = c.post("/api/v1/assistant/chats")
        assert r.status_code == 503 and "not connected" in r.json()["detail"]


# ---- looking things up ---------------------------------------------------------------------
def test_it_looks_things_up_and_answers(tmp_path):
    script = Script({"calls": [call(1, "portfolio"), call(2, "find_stocks", query="comm", limit=3)]},
                    {"say": "Your cash is EGP 50,000 and CIB is the match."})
    with app_with(tmp_path, script) as c:
        status = c.get("/api/v1/assistant").json()
        assert status["configured"] and status["allowed"] and status["access"] == "full" and status["tools"] == len(TOOLS)
        chat = new_chat(c)
        out = say(c, chat, "كام الكاش عندي؟")
        kinds = [e["type"] for e in out]
        assert kinds[:4] == ["tool", "tool_done", "tool", "tool_done"] and kinds[-1] == "done" and "text" in kinds
        assert out[0]["label"] == "Reading the portfolio" and out[1] == {"type": "tool_done", "id": "toolu_01", "ok": True, "changed": False}
        assert "".join(e["text"] for e in out if e["type"] == "text").strip() == "Your cash is EGP 50,000 and CIB is the match."

        first, second = script.seen
        # the user's words, then the context note; nothing else
        user = first["messages"][0]["content"]
        assert user[0] == {"type": "text", "text": "كام الكاش عندي؟"}
        assert user[1]["text"].startswith("<context>Cairo time") and "page /portfolio" in user[1]["text"] and "access full" in user[1]["text"]
        # both results go back in one message, in the order the calls were made
        back = second["messages"][2]
        assert back["role"] == "user" and [b["tool_use_id"] for b in results_of(back)] == ["toolu_01", "toolu_02"]
        portfolio = json.loads(results_of(back)[0]["content"])
        assert portfolio["summary"]["cash"] == 50000.0 and portfolio["mode"] == "paper"
        assert json.loads(results_of(back)[1]["content"])["stocks"][0]["symbol"] == "COMI"
        # the conversation only grows: what was sent before is sent again unchanged, with the same instructions and tools
        assert second["messages"][:1] == first["messages"] and second["system"] == first["system"] and second["tools"] == first["tools"]
        assert second["messages"][1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig1"}   # reasoning replayed as given
        assert all(t["eager_input_streaming"] is True and "input_schema" in t for t in first["tools"])
        assert "Trading in the app is on paper" in first["system"] and "<context>" not in first["system"]    # nothing that varies in the instructions

        view = c.get(f"/api/v1/assistant/chats/{chat}").json()
        assert [i["role"] for i in view["items"]] == ["user", "assistant", "assistant"]
        assert view["items"][0]["text"] == "كام الكاش عندي؟"                                  # the context note is not shown
        assert [t["label"] for t in view["items"][1]["tools"]] == ["Reading the portfolio", "Searching stocks for comm"]
        assert all(t["ok"] for t in view["items"][1]["tools"]) and view["title"] == "كام الكاش عندي؟"
        assert view["usage"]["calls"] == 2 and view["usage"]["cost_usd"] == pytest.approx(2 * (1000 * 4 + 200 * 20) / 1e6)
        listed = c.get("/api/v1/assistant").json()
        assert listed["chats"][0]["id"] == chat and listed["spent_today_usd"] == pytest.approx(0.016)
        assert c.delete(f"/api/v1/assistant/chats/{chat}").status_code == 200
        assert c.get(f"/api/v1/assistant/chats/{chat}").status_code == 404


# ---- acting ---------------------------------------------------------------------------------
def test_with_full_access_it_carries_out_what_was_asked(tmp_path):
    script = Script({"say": "Buying now.", "calls": [call(1, "place_trade", side="BUY", symbol="comi", qty=10, note="test")]},
                    {"calls": [call(2, "open_page", page="stock", symbol="comi")]},
                    {"say": "Done: 10 COMI bought."})
    with app_with(tmp_path, script) as c:
        out = say(c, new_chat(c), "buy 10 COMI")
        done = [e for e in out if e["type"] == "tool_done"]
        assert done[0]["ok"] and done[0]["changed"] is True
        assert done[1]["navigate"] == "/stock?symbol=COMI"
        assert [e["label"] for e in out if e["type"] == "tool"] == ["Buy 10 COMI (paper trade)", "Open the stock page for COMI"]
        (trade,) = trades(c)
        assert (trade["type"], trade["symbol"], trade["qty"], trade["note"], trade["origin"]) == ("BUY", "COMI", 10, "test", "assistant")
        result = json.loads(results_of(script.seen[1]["messages"][2])[0]["content"])
        assert result["recorded"]["seq"] == 2 and result["mode"] == "paper" and result["cash_after"] < 50000
        assert any(a["entity"] == "paper_trade" for a in c.get("/api/v1/audit").json())   # recorded like any other trade


def test_when_asked_to_confirm_it_waits_for_the_user(tmp_path):
    script = Script({"calls": [call(1, "portfolio"), call(2, "place_trade", side="BUY", symbol="COMI", qty=10),
                               call(3, "set_watch", symbol="TMGH", watched=True)]},
                    {"say": "Bought."},
                    {"calls": [call(4, "reset_portfolio")]},
                    {"say": "Left as it is."})
    with app_with(tmp_path, script) as c:
        assert c.put("/api/v1/assistant/access", json={"access": "confirm"}).json() == {"access": "confirm"}
        chat = new_chat(c)
        out = say(c, chat, "buy 10 COMI and watch TMGH")
        assert [e["type"] for e in out] == ["tool", "tool_done", "tool", "tool_done", "confirm", "done"]
        assert out[4]["actions"] == [{"id": "toolu_02", "label": "Buy 10 COMI (paper trade)"}]
        assert trades(c) == [] and len(script.seen) == 1                        # nothing bought, the model not called again
        assert c.get("/api/v1/watchlist").json()[0]["symbol"] == "TMGH"         # notes and lists do not need approval
        view = c.get(f"/api/v1/assistant/chats/{chat}").json()
        assert view["pending"][0]["id"] == "toolu_02" and view["items"][-1]["tools"][1]["ok"] is None

        out = events(c.post(f"/api/v1/assistant/chats/{chat}/resolve", json={"decisions": {"toolu_02": "approve"}}))
        assert [e["type"] for e in out][:2] == ["tool", "tool_done"] and out[-1]["type"] == "done"
        assert len(trades(c)) == 1
        back = script.seen[1]["messages"][2]
        assert [b["tool_use_id"] for b in results_of(back)] == ["toolu_01", "toolu_02", "toolu_03"]   # one message, original order
        assert c.get(f"/api/v1/assistant/chats/{chat}").json()["pending"] == []
        assert c.post(f"/api/v1/assistant/chats/{chat}/resolve", json={"decisions": {}}).status_code == 422

        # declining: the action is not taken and the model is told so
        out = say(c, chat, "reset my portfolio")
        assert out[-2]["type"] == "confirm" and out[-2]["actions"][0]["label"] == "Reset the paper portfolio"
        out = events(c.post(f"/api/v1/assistant/chats/{chat}/resolve", json={"decisions": {"toolu_04": "decline"}}))
        assert out[0] == {"type": "tool_done", "id": "toolu_04", "ok": False, "changed": False, "declined": True}
        declined = results_of(script.seen[3]["messages"][-1])[0]
        assert "did not approve" in declined["content"] and len(trades(c)) == 1
        shown = c.get(f"/api/v1/assistant/chats/{chat}").json()["items"]
        reset = next(t for i in shown for t in i.get("tools", []) if t["id"] == "toolu_04")
        assert reset["declined"] is True and reset["ok"] is False                 # shown as declined, not as done


def test_a_new_message_instead_of_an_answer_cancels_what_was_waiting(tmp_path):
    script = Script({"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=10)]}, {"say": "Okay, cancelled."})
    with app_with(tmp_path, script) as c:
        c.put("/api/v1/assistant/access", json={"access": "confirm"})
        chat = new_chat(c)
        say(c, chat, "buy 10 COMI")
        out = say(c, chat, "never mind")
        assert out[-1]["type"] == "done" and trades(c) == []
        last = script.seen[1]["messages"][-1]["content"]
        assert last[0]["type"] == "tool_result" and "did not approve" in last[0]["content"] and last[1]["text"] == "never mind"


def test_look_only_mode_changes_nothing(tmp_path):
    script = Script({"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=10), call(2, "set_watch", symbol="COMI", watched=True),
                               call(3, "market_overview")]}, {"say": "I can only look."})
    with app_with(tmp_path, script) as c:
        c.put("/api/v1/assistant/access", json={"access": "read"})
        say(c, new_chat(c), "buy 10 COMI")
        got = results_of(script.seen[1]["messages"][2])
        assert got[0]["is_error"] and "look only" in got[0]["content"] and got[1]["is_error"] and "is_error" not in got[2]
        assert trades(c) == [] and c.get("/api/v1/watchlist").json() == []


# ---- things going wrong ------------------------------------------------------------------
def test_bad_input_unknown_tools_and_broken_rules_come_back_as_errors_to_explain(tmp_path):
    script = Script({"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=-5),          # fails the schema
                               call(2, "place_trade", side="SELL", symbol="COMI", qty=10),         # nothing held
                               call(3, "launch_rocket"),                                           # no such tool
                               call(4, "stock_report", symbol="NOPE"),                             # unknown stock
                               call(5, "place_trade", side="BUY", symbol="COMI", qty=10, price=1)]},  # an input it may not set
                    {"say": "None of that worked."})
    with app_with(tmp_path, script) as c:
        out = say(c, new_chat(c), "do odd things")
        assert out[-1]["type"] == "done" and trades(c) == []
        got = results_of(script.seen[1]["messages"][2])
        assert all(r["is_error"] for r in got) and len(got) == 5
        assert "INVALID_JSON" in got[0]["content"] and "qty" in got[0]["content"]
        assert "only 0 held" in got[1]["content"] and "no tool called launch_rocket" in got[2]["content"]
        assert "unknown symbol NOPE" in got[3]["content"] and "price" in got[4]["content"]


def test_a_call_cut_off_by_the_length_limit_is_not_run(tmp_path):
    script = Script({"calls": [call(1, "place_trade", side="BUY", symbol="COMI", qty=10)], "stop": "max_tokens"},
                    {"say": "Sorry, let me know if I should try again."})
    with app_with(tmp_path, script) as c:
        say(c, new_chat(c), "buy")
        assert trades(c) == []
        assert "cut off" in results_of(script.seen[1]["messages"][2])[0]["content"]


def test_a_failure_is_reported_and_the_conversation_stays_usable(tmp_path):
    script = Script({"calls": [call(1, "portfolio")]}, AssistantError("Claude is busy.", retry_after=30),
                    {"say": "Back again."}, {"say": "No.", "stop": "refusal"})
    with app_with(tmp_path, script) as c:
        chat = new_chat(c)
        out = say(c, chat, "hello")
        assert out[-1] == {"type": "error", "detail": "Claude is busy.", "retry_after": 30}
        out = say(c, chat, "again")
        assert out[-1]["type"] == "done"
        sent = script.seen[2]["messages"]
        assert [m["role"] for m in sent] == ["user", "assistant", "user", "user"]      # every call has its result before the new message
        out = say(c, chat, "something refused")
        assert any(e["type"] == "notice" and "declined" in e["text"] for e in out)


def test_it_stops_after_a_fixed_number_of_steps_and_leaves_a_valid_conversation(tmp_path):
    script = Script(*[{"calls": [call(n, "market_overview")]} for n in range(1, assistant.MAX_STEPS + 1)], {"say": "ok"})
    with app_with(tmp_path, script) as c:
        chat = new_chat(c)
        out = say(c, chat, "loop")
        assert len(script.seen) == assistant.MAX_STEPS and any(e["type"] == "notice" and "paused" in e["text"] for e in out)
        say(c, chat, "continue")
        roles = [m["role"] for m in script.seen[-1]["messages"]]
        assert roles[-2:] == ["user", "user"] and roles.count("assistant") == assistant.MAX_STEPS


def test_spending_limits_and_message_checks(tmp_path):
    script = Script({"say": "one"}, {"say": "two"})
    with app_with(tmp_path, script, assistant_daily_usd=0.01) as c:
        chat = new_chat(c)
        assert c.post(f"/api/v1/assistant/chats/{chat}/messages", json={"text": "   "}).status_code == 422
        assert c.post("/api/v1/assistant/chats/nope/messages", json={"text": "hi"}).status_code == 404
        say(c, chat, "first")        # costs 0.008
        say(c, chat, "second")       # 0.016 by the end: over the ceiling now
        r = c.post(f"/api/v1/assistant/chats/{chat}/messages", json={"text": "third"})
        assert r.status_code == 422 and "budget" in r.json()["detail"] and len(script.seen) == 2
    assert cost_usd("claude-opus-5-5", {"input": 1_000_000, "output": 100_000, "cache_read": 2_000_000, "cache_write": 0}) == pytest.approx(6.4)
    assert cost_usd("some-other-model", USAGE) is None


# ---- the tools themselves ---------------------------------------------------------------
def test_every_tool_works_on_real_service_calls(tmp_path):
    core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()

    def run(tool_name, /, **args):
        tool, parsed, problem = parse(tool_name, args)
        assert problem is None, problem
        content, failed = assistant._execute(core, tool, parsed)
        assert not failed, f"{tool_name}: {content}"
        assert tool.label(parsed)
        return json.loads(content)

    assert run("market_overview")["breadth"]["covered"] == 53
    assert run("find_stocks", sector="Banks", sort_by="change_pct", descending=True)["total_matching"] >= 2
    report = run("stock_report", symbol="comi", bars=5)
    assert len(report["candles"]["rows"]) == 5 and report["assessment"]["trend"] and report["holding"] is None
    assert report["candle_patterns"]["timeframe"] == "d" and isinstance(report["candle_patterns"]["latest"], list)
    scan = run("candle_scan", sessions=10, limit=5)
    assert scan["total_matching"] >= len(scan["matches"]) >= 1 and scan["matches"][0]["company"]
    assert all(m["direction"] == "bearish" for m in run("candle_scan", direction="bearish", sessions=10)["matches"])
    assert run("preview_trade", side="BUY", symbol="COMI", qty=10)["error"] is None
    run("place_trade", side="BUY", symbol="COMI", qty=10, note="x")
    assert run("portfolio")["holdings"][0]["symbol"] == "COMI" and run("trades", symbol="COMI")["matching"] == 1
    assert run("stock_report", symbol="COMI", bars=0)["holding"]["qty"] == 10
    run("set_watch", symbol="COMI", watched=True)
    lst = run("save_stock_list", name="Mine", symbols=["COMI", "TMGH"])
    assert run("watchlist")["custom_lists"][0]["name"] == "Mine"
    assert "sma_cross" in run("strategies")["types"]
    a = run("save_strategy", name="Trend", type="sma_cross", params={"fast": 5, "slow": 20}, symbols=["COMI", "TMGH"], stop_loss_pct=None)
    b = run("save_strategy", name="Break", type="breakout", sectors=["Banks"])
    assert run("save_strategy", id=a["id"], name="Trend 2", type="sma_cross", symbols=["COMI"])["name"] == "Trend 2"
    bt = run("run_backtest", strategy_id=a["id"], capital=30000)
    assert bt["metrics"]["starting_capital"] == 30000 and "latest_trades" in bt
    assert len(run("compare_strategies", strategy_ids=[a["id"], b["id"]], symbols=["COMI", "TMGH", "SWDY"])["runs"]) == 2
    assert len(run("backtests")["runs"]) == 3 and run("backtests", id=bt["id"])["id"] == bt["id"]
    run("signals")
    started = run("start_paper_run", strategy_id=a["id"], capital=10000)
    assert run("paper_runs")["runs"][0]["id"] == started["id"]
    assert run("set_paper_run_status", id=started["id"], status="paused")["status"] == "paused"
    alert = run("save_alert", kind="price_above", symbol="COMI", value=1)
    assert run("alerts")["alerts"][0]["id"] == alert["id"]
    item = run("save_research", title="Results", symbols=["COMI"], category="financials")
    assert run("research", symbol="COMI")["matching"] == 1
    entry = run("save_journal_entry", symbol="COMI", thesis="Trend follows")
    assert run("journal", status="open")["matching"] == 1
    assert run("settings")["fee_schedule"]["verified"] is False
    assert run("update_settings", starting_capital=60000)["starting_capital"] == "60000.00"
    fees = run("update_fee_schedule", items=[{"code": "brokerage", "name": "Brokerage", "rate_pct": 0.2, "minimum": 5}], verified=True)
    assert fees["verified"] is True and len(fees["items"]) == 1
    for kind, id in (("alert", alert["id"]), ("research", item["id"]), ("journal", entry["id"]), ("list", lst["id"]), ("strategy", b["id"])):
        assert run("delete_item", kind=kind, id=id) == {"deleted": kind, "id": id}
    assert run("reset_portfolio")["new_portfolio"]["starting_capital"] == "60000.00"
    assert run("audit_log", limit=5)["entries"]
    refs = run("knowledge")["references"]
    assert refs[0]["name"] == "app-guide" and "How EGX Intelligence works" in refs[0]["title"] and refs[0]["sections"] >= 6
    # the guide has grown past what one answer carries: its outline comes back, and the sections are read by number
    guide = run("knowledge", name="app-guide")
    titles = [part["title"] for part in guide["outline"]]
    assert "text" not in guide and "Accounting rules" in titles and any(t.startswith("The radar") for t in titles)
    rules = run("knowledge", name="app-guide", sections=[titles.index("Accounting rules") + 1])["sections"][0]
    assert rules["title"] == "Accounting rules" and "Average cost" in rules["text"]
    assert run("knowledge", name="App-Guide.md", sections=[2])["sections"][0]["title"] == "Screens"
    assert run("knowledge", query="fee schedule placeholder")["matches"][0]["title"] == "Accounting rules"
    # the trading references: each has a title and a summary to choose by, and its sections can be read and searched
    names = [r["name"] for r in refs]
    assert {"candlesticks", "chart-patterns", "trend-and-stages", "momentum-indicators", "growth-stock-method",
            "trend-following", "price-action", "risk-and-position-sizing"} <= set(names)
    assert all(r["title"] and len(r["about"]) > 60 and r["sections"] >= 5 for r in refs)
    for r in refs:
        read = run("knowledge", name=r["name"], sections=list(range(1, r["sections"] + 1))[:12])
        text = "\n".join(part["text"] for part in read["sections"])
        for other in re.findall(r"`([a-z]+(?:-[a-z]+)+)`", text):   # a reference named in the text must exist
            assert other in names, f"{r['name']} points to a missing reference {other}"
    hits = run("knowledge", query="hammer lower shadow")["matches"]
    assert hits and hits[0]["name"] == "candlesticks"
    assert run("knowledge", query="risk of ruin expectancy")["matches"][0]["name"] == "risk-and-position-sizing"
    assert run("open_page", page="stock", symbol="comi") == {"opened": "/stock?symbol=COMI"}
    # without the live feed the order book says so instead of failing
    tool, parsed, _ = parse("price_depth", {"symbol": "COMI"})
    content, failed = assistant._execute(core, tool, parsed)
    assert failed and "live market-data feed" in content
    # no tool reaches sign-in accounts, and the only one that reaches the broker looks at the account, for its owner
    names = {t.name for t in TOOLS}
    assert [n for n in names if any(word in n for word in ("account", "password", "broker"))] == ["real_account"]
    assert next(t for t in TOOLS if t.name == "real_account").kind == "read"
    assert run("real_account")["available"] is False   # nothing has said this request is the owner's
    assert run("open_page", page="account") == {"opened": "/account"}
    assert [s["name"] for s in tool_specs()] == [t.name for t in TOOLS]


# ---- the reference library ------------------------------------------------------------------
def ask(**args) -> dict:
    """One call of the `knowledge` tool, the way the agent loop makes it."""
    tool, parsed, problem = parse("knowledge", args)
    assert problem is None, problem
    assert tool.label(parsed)
    return tool.run(None, parsed)


@pytest.fixture
def shelf(tmp_path, monkeypatch):
    """A library of its own in a temporary folder; the shipped one is back afterwards."""
    monkeypatch.setattr(assistant_tools, "KNOWLEDGE_DIR", tmp_path)
    monkeypatch.setattr(assistant_tools, "KNOWLEDGE_PART", 400)
    library.cache_clear()

    def add(name: str, text: str):
        (tmp_path / f"{name}.md").write_text(text, encoding="utf-8")
        library.cache_clear()
    yield add
    library.cache_clear()


def test_a_long_reference_is_read_by_section(shelf):
    filler = "كلام عام عن السوق. " * 12
    shelf("book", "# كتاب التداول\nملخص من سطر واحد.\n\nتمهيد قصير.\n\n"
                  f"## الفصل الأول: السيولة (Liquidity)\n{filler}\n\n## الفصل الثاني: أداة فيبوناتشي\nالمستوى الذهبي 61.8%.\n{filler}\n")
    shelf("note", "# A short note\nWhat it covers.\n\n## Only part\nBrief.\n")
    listed = ask()["references"]
    assert [(r["name"], r["sections"]) for r in listed] == [("book", 3), ("note", 1)]
    assert listed[0]["title"] == "كتاب التداول" and listed[0]["about"] == "ملخص من سطر واحد."
    assert ask(name="note")["text"] == "## Only part\nBrief."                # short: returned whole
    outline = ask(name="book")
    assert "text" not in outline and [s["title"] for s in outline["outline"]] == [
        "Overview", "الفصل الأول: السيولة (Liquidity)", "الفصل الثاني: أداة فيبوناتشي"]
    got = ask(name="book", sections=[3, 1, 3])
    assert [s["section"] for s in got["sections"]] == [3, 1] and "61.8%" in got["sections"][0]["text"]
    assert "not_returned" not in got
    crowded = ask(name="book", sections=[2, 3, 1])                           # more than one answer holds
    assert [s["section"] for s in crowded["sections"]] == [2] and crowded["not_returned"]["sections"] == [3, 1]
    for bad in ({"name": "book", "sections": [4]}, {"name": "missing"}, {"sections": [1]}):
        tool, parsed, _ = parse("knowledge", bad)
        content, failed = assistant._execute(None, tool, parsed)
        assert failed and "error" in content
    assert parse("knowledge", {"name": "book", "sections": [0]})[2]             # refused before it runs


def test_an_oversized_section_is_cut_at_blank_lines(shelf):
    blocks = [f"فقرة رقم {n}. " + "نص " * 40 for n in range(1, 8)]
    shelf("long", "# Long\nOne heading only.\n\n## Big\n" + "\n\n".join(blocks) + "\n\n" + "x" * 900)
    ref = library()[0]
    assert len(ref.sections) > 3 and all(len(text) <= 400 for _, text in ref.sections)
    assert ref.sections[0][0] == "Big" and ref.sections[1][0] == "Big (continued 2)"
    assert "".join(text for _, text in ref.sections).count("فقرة رقم") == 7      # nothing is lost
    assert "".join(text for _, text in ref.sections).count("x") == 900


def test_search_finds_arabic_and_english_however_they_are_typed(shelf):
    shelf("book", "# كتاب\nوصف.\n\n## السيولة (Liquidity)\nالسيولة الشرائية فوق القمم.\n\n"
                  "## أداة فيبوناتشي (Fibonacci)\nالمستوى الذهبي ٦١٫٨٪ منطقة مثالية. وتُذكر السيولة هنا مرة واحدة.\n\n"
                  "## الأوردر بلوك (Order Block)\nآخر شمعة معاكسة قبل الحركة القوية.\n")
    shelf("guide", "# Guide\nAbout the app.\n\n## Fees\nThe fee schedule and its lines.\n")
    top = lambda **a: [(m["name"], m["section"]) for m in ask(**a)["matches"]]  # noqa: E731
    assert top(query="السيولة") == [("book", 1), ("book", 2)]                  # a heading counts for more than a mention
    assert top(query="سيوله")[0] == ("book", 1)                                # no "the", ta marbuta as ha
    assert top(query="الاوردر بلوك") == [("book", 3)] == top(query="ORDER block") == top(query="بالأوردر")
    assert top(query="فِيبُونَاتْشِي") == [("book", 2)] == top(query="61.8")       # vowel marks, Arabic digits
    assert top(query="fee schedule") == [("guide", 1)]
    assert top(query="السيولة", name="guide") == [] and "No section" in ask(query="zzz")["note"]
    assert top(query="ما هو ال what is the") == []                             # filler words alone find nothing
    assert ask(query="الذهبي")["matches"][0]["mentions"].startswith("المستوى الذهبي")
    assert fold("الأَوَّلِيّة ىٰ") == "الاوليه ي" and fold("ﻻ RSI") == "لا rsi"


def test_the_shipped_library_can_all_be_read():
    library.cache_clear()
    refs = library()
    assert refs and refs[0].name == "app-guide"
    for ref in refs:
        assert ref.name == ref.name.lower() and ref.name.replace("-", "").isalnum() and ref.name.isascii()
        assert ref.title and ref.about and ref.sections, ref.name
        assert len({heading for heading, _ in ref.sections}) == len(ref.sections), f"{ref.name}: two sections share a heading"
        for n in range(1, len(ref.sections) + 1):                              # every section fits in one answer
            text = render(ask(name=ref.name, sections=[n]))
            assert "too_large" not in text and len(text) <= MAX_RESULT_CHARS, f"{ref.name} section {n}"
        assert "too_large" not in render(ask(name=ref.name))
    assert "too_large" not in render(ask())


def test_the_instructions_list_the_library(tmp_path):
    prompt = assistant.system_prompt()
    assert prompt == assistant.system_prompt() and "{library}" not in prompt   # fixed, so the cached prefix holds
    for ref in library():
        assert f"`{ref.name}`" in prompt and ref.title in prompt
    script = Script({"say": "ok"})
    with app_with(tmp_path, script) as c:
        say(c, new_chat(c), "hello")
    assert script.seen[0]["system"] == prompt


# ---- the model wrapper ----------------------------------------------------------------------
def block(kind, **fields):
    return SimpleNamespace(type=kind, model_dump=lambda **kw: {"type": kind, **fields}, **fields)


def message(*blocks, stop="end_turn"):
    usage = SimpleNamespace(input_tokens=120, output_tokens=30, cache_read_input_tokens=900, cache_creation_input_tokens=None)
    return SimpleNamespace(content=list(blocks), stop_reason=stop, model="claude-opus-5-5", usage=usage, stop_details=None)


def test_only_the_serving_attempt_of_a_fallback_is_kept_and_run():
    got = final_message(message(
        block("thinking", thinking="", signature="old"), block("text", text="Let me check."),
        block("tool_use", id="t1", name="portfolio", input={}),                  # from the attempt that was declined
        block("fallback", **{"from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-5"}}),
        block("thinking", thinking="", signature="new"), block("text", text="  "),
        block("tool_use", id="t2", name="trades", input={"limit": 5}), stop="tool_use"))
    assert [b["type"] for b in got["content"]] == ["text", "fallback", "thinking", "tool_use"]   # empty text dropped
    assert got["content"][2]["signature"] == "new" and got["content"][1]["from"] == {"model": "claude-opus-5-5"}
    assert got["tool_calls"] == [{"id": "t2", "name": "trades", "input": {"limit": 5}}]
    assert got["usage"] == {"input": 120, "output": 30, "cache_read": 900, "cache_write": 0}
    stripped = without_reasoning([{"role": "user", "content": "hi"}, {"role": "assistant", "content": got["content"]}])
    assert [b["type"] for b in stripped[1]["content"]] == ["text", "tool_use"] and stripped[0]["content"] == "hi"


class FakeStream:
    def __init__(self, events, final):
        self.events, self.final = events, final

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(self.events)

    def get_final_message(self):
        return self.final


def test_the_request_to_claude_and_the_retry_without_optional_features():
    import anthropic
    import httpx2

    sent = []

    def refuse(**kwargs):
        sent.append(("beta", kwargs))
        response = httpx2.Response(400, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
        raise anthropic.BadRequestError("Unexpected value(s) for the `anthropic-beta` header", response=response, body=None)

    def plain(**kwargs):
        sent.append(("plain", kwargs))
        events = [SimpleNamespace(type="text", text="Hello", snapshot="Hello"), SimpleNamespace(type="content_block_stop")]
        return FakeStream(events, message(block("text", text="Hello")))

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=refuse)), messages=SimpleNamespace(stream=plain))
    model = ClaudeModel("key", "not-a-model", "silly", client=client)
    assert model.name == "claude-opus-5-5" and model.effort == "medium"            # unknown settings fall back to the defaults
    history = [{"role": "user", "content": [{"type": "text", "text": "hi"}]},
               {"role": "assistant", "content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": "yo"}]},
               {"role": "user", "content": [{"type": "text", "text": "again"}]}]
    out = list(model.turn(system="SYS", tools=tool_specs(), messages=history))
    assert out[0] == {"type": "text", "text": "Hello"} and out[-1]["message"]["content"] == [{"type": "text", "text": "Hello"}]

    (_, first), (kind, second) = sent
    assert first["model"] == "claude-opus-5-5" and first["max_tokens"] == 32000 and first["fallbacks"] == "default"
    assert first["betas"] == [FALLBACK_BETA, BINDING_BETA, UPDATES_BETA]
    assert first["thinking"] == {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}, "display": "updates"}
    assert first["output_config"] == {"effort": "medium"} and first["cache_control"] == {"type": "ephemeral"}
    assert first["system"] == [{"type": "text", "text": "SYS"}] and first["messages"] == history and len(first["tools"]) == len(TOOLS)
    assert "tool_choice" not in first and "temperature" not in first                 # neither is accepted by this model
    # refused as an optional feature: sent again the plain way, with the reasoning blocks left out
    assert kind == "plain" and "betas" not in second and "fallbacks" not in second and second["thinking"] == {"type": "adaptive"}
    assert second["messages"][1]["content"] == [{"type": "text", "text": "yo"}] and model.plain is True

    # a problem that is not about optional features is explained, not retried
    def no_credit(**kwargs):
        response = httpx2.Response(400, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
        raise anthropic.BadRequestError("Your credit balance is too low to access the Anthropic API.", response=response, body=None)

    broke = ClaudeModel("key", "claude-haiku-5-5", "low", client=SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=no_credit))))
    with pytest.raises(AssistantError, match="no credit left"):
        list(broke.turn(system="SYS", tools=[], messages=history))


def test_the_key_is_checked_for_free_and_a_bad_one_is_named(tmp_path):
    import anthropic
    import httpx2

    asked = []

    def rejected(model_id):
        asked.append(model_id)
        response = httpx2.Response(401, request=httpx2.Request("GET", "https://api.anthropic.com/v1/models/x"))
        raise anthropic.AuthenticationError("invalid x-api-key", response=response, body=None)

    bad = ClaudeModel("key", client=SimpleNamespace(models=SimpleNamespace(retrieve=rejected)))
    assert "rejected the API key" in bad.check() and "rejected the API key" in bad.check()
    assert asked == ["claude-opus-5-5"]                      # a failure is remembered for a minute, not asked again each time
    good = ClaudeModel("key", "claude-sonnet-5-5", client=SimpleNamespace(models=SimpleNamespace(retrieve=lambda m: asked.append(m))))
    assert good.check() is None and good.check() is None and asked == ["claude-opus-5-5", "claude-sonnet-5-5"]
    # the panel is told, and the public health check says only whether a key is saved
    with TestClient(create_app(Settings(data_dir=tmp_path), Store(tmp_path / "t.sqlite3"), assistant_model=bad)) as c:
        assert "rejected the API key" in c.get("/api/v1/assistant").json()["problem"]
        assert c.get("/health").json()["assistant"] is True
    with app_with(tmp_path / "b", Script()) as c:
        assert c.get("/api/v1/assistant").json()["problem"] is None
    with TestClient(create_app(Settings(data_dir=tmp_path / "c"), Store(tmp_path / "c" / "t.sqlite3"))) as c:
        assert c.get("/health").json()["assistant"] is False


# ---- the owner's settings for the assistant ---------------------------------------------
def test_the_owner_sets_what_it_may_cost_how_it_answers_and_how_often_it_reviews(tmp_path, monkeypatch):
    script = Script({"say": "تمام"}, {"say": "Again"}, {"say": "Third"})
    with app_with(tmp_path, script, assistant_daily_usd=0) as c:
        s = c.get("/api/v1/assistant").json()
        assert s["settings"]["monthly_usd"] == 60 and s["settings"]["language"] == "auto" and s["settings"]["instructions"] == ""
        assert s["settings"]["real_proposals_per_day"] == 20 and s["settings"]["autopilot"]["max_per_day"] == 12
        assert s["settings"]["autopilot"]["notify"] is True and s["languages"] == ["auto", "ar", "en"]
        assert s["spending"]["today_usd"] == 0 and len(s["spending"]["days"]) == 7

        # what was chosen is at the very end of the instructions; the text everyone shares comes first, unchanged
        chat = new_chat(c)
        say(c, chat, "hello")
        shared = script.seen[0]["system"]
        assert shared == assistant.system_prompt() and "What this person chose" not in shared
        saved = c.put("/api/v1/assistant/settings", json={
            "language": "ar", "instructions": "  Keep answers short.\nAlways give the stop-loss.  ", "monthly_usd": 30, "daily_usd": 2,
            "real_proposals_per_day": 3, "autopilot_max_per_day": 2, "autopilot_notify": False}).json()["settings"]
        assert saved["language"] == "ar" and saved["instructions"] == "Keep answers short.\nAlways give the stop-loss."
        assert (saved["monthly_usd"], saved["real_proposals_per_day"], saved["autopilot"]["max_per_day"], saved["autopilot"]["notify"]) == (30, 3, 2, False)
        say(c, chat, "again")
        mine = script.seen[1]["system"]
        assert mine.startswith(shared) and mine != shared
        tail = mine[len(shared):]
        assert "always answer in natural Egyptian Arabic" in tail and "<standing_instructions>\nKeep answers short.\nAlways give the stop-loss.\n</standing_instructions>" in tail
        assert "do not widen what your tools may do" in tail
        c.put("/api/v1/assistant/settings", json={"language": "en", "instructions": ""})
        say(c, chat, "third")
        assert script.seen[2]["system"].endswith("- Language: always answer in English, whatever language the message is written in.\n")
        # the standing instructions are the owner's words: they are not copied into the activity log
        logged = [a for a in c.get("/api/v1/audit").json() if a["entity"] == "assistant_settings"]
        assert logged and all("instructions" not in a["detail"] and "autopilot_mandate" not in a["detail"] for a in logged)
        # a ceiling for a day cannot be above the one for the month
        res = c.put("/api/v1/assistant/settings", json={"daily_usd": 50, "monthly_usd": 20})
        assert res.status_code == 422 and "cannot be larger than the monthly" in res.json()["detail"]
        assert c.put("/api/v1/assistant/settings", json={"language": "fr"}).status_code == 422
        assert c.put("/api/v1/assistant/settings", json={"instructions": "x" * 2001}).status_code == 422


def test_the_month_has_a_ceiling_too_and_what_was_spent_is_shown_by_day_and_by_kind(tmp_path, monkeypatch):
    from datetime import datetime

    from app.data.calendar import CAIRO
    clock = {"now": datetime(2026, 11, 10, 12, 0, tzinfo=CAIRO)}
    monkeypatch.setattr(assistant, "cairo_now", lambda: clock["now"])
    turn_cost = cost_usd("claude-opus-5-5", USAGE)
    script = Script(*({"say": f"answer {n}"} for n in range(6)))
    with app_with(tmp_path, script, assistant_daily_usd=0) as c:
        c.put("/api/v1/assistant/settings", json={"monthly_usd": round(turn_cost * 2.5, 4)})
        chat = new_chat(c)
        say(c, chat, "one")
        clock["now"] = clock["now"].replace(day=11)
        say(c, chat, "two")
        spend = c.get("/api/v1/assistant").json()["spending"]
        assert spend["today_usd"] == pytest.approx(turn_cost, abs=1e-4) and spend["month_usd"] == pytest.approx(turn_cost * 2, abs=1e-4)
        assert spend["today_by"] == {"chat": pytest.approx(turn_cost, abs=1e-4), "autopilot": 0}
        assert [d["date"] for d in spend["days"][:2]] == ["2026-11-11", "2026-11-10"] and spend["days"][1]["calls"] == 1
        say(c, chat, "three")                                                   # this one takes the month over its ceiling
        res = c.post(f"/api/v1/assistant/chats/{chat}/messages", json={"text": "four", "page": "/"})
        assert res.status_code == 429 or "This month's assistant budget" in res.text
        assert len(script.seen) == 3                                            # nothing more was sent to the model
        clock["now"] = clock["now"].replace(month=12, day=1)                    # a new month starts from nothing
        say(c, chat, "five")
        assert c.get("/api/v1/assistant").json()["spending"]["month_usd"] == pytest.approx(turn_cost, abs=1e-4)


def test_the_autopilot_keeps_to_the_reviews_and_the_money_it_was_given(tmp_path, monkeypatch):
    monkeypatch.setattr(assistant, "market_open", lambda *a, **k: True)
    script = Script(*({"say": f"review {n}"} for n in range(6)))
    with app_with(tmp_path, script, assistant_daily_usd=0) as c:
        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "intraday", "autopilot_max_per_day": 3, "autopilot_every_minutes": 15})
        store = Store(tmp_path / "t.sqlite3")

        def due(close: bool):
            doc = store.get("settings", "assistant")
            doc["autopilot"].update(last_run=None, **({"last_session": None} if close else {}))
            store.put("settings", "assistant", doc)
            return c.post("/api/v1/assistant/autopilot").json()
        first = due(close=True)
        assert first["ran"] and first["reason"] == "close" and first["notify"] is True
        assert due(close=False)["reason"] == "intraday"                       # the second of the three
        held = due(close=False)                                               # the third place is kept for the close
        assert held["ran"] is False and held["skipped"] == "today's reviews are used up" and len(script.seen) == 2
        assert "the review after the close still runs" in held["why"]
        after = due(close=True)                                               # and the review after the close is never held back for it
        assert after["ran"] and after["reason"] == "close" and len(script.seen) == 3
        # the report is written in the language chosen in Settings, and in the mandate's when none was chosen
        briefs = [" ".join(b["text"] for b in seen["messages"][0]["content"]) for seen in script.seen]
        assert "Write the report in the language of the mandate" in briefs[0]
        c.put("/api/v1/assistant/settings", json={"language": "en", "autopilot_max_per_day": 12})
        assert due(close=False)["ran"] and len(script.seen) == 4
        assert "Write the report in English." in " ".join(b["text"] for b in script.seen[3]["messages"][0]["content"])
        # a ceiling in money holds a review back, the one after the close too, and says which ceiling
        c.put("/api/v1/assistant/settings", json={"monthly_usd": 0.0001})
        held = due(close=True)
        assert held["ran"] is False and held["skipped"] == "the budget is used up" and held["ceiling"] == "month"
        assert "This month's assistant budget" in held["why"] and len(script.seen) == 4
        # what a day of reviews can come to: what the schedule asks for, what the day's limit lets through, and
        # what a review did cost on average
        c.put("/api/v1/assistant/settings", json={"monthly_usd": 0})
        cost = c.get("/api/v1/assistant").json()["spending"]["autopilot"]
        each = cost_usd("claude-opus-5-5", USAGE)
        assert (cost["reviews_asked"], cost["reviews_a_day"], cost["reviews_counted"]) == (20, 12, 4)   # every 15 minutes asks for more than 12
        assert cost["review_usd"] == pytest.approx(each, abs=1e-4) and cost["day_usd"] == pytest.approx(12 * each, abs=1e-3)
        c.put("/api/v1/assistant/settings", json={"autopilot_every_minutes": 60, "daily_usd": 0.01})
        cost = c.get("/api/v1/assistant").json()["spending"]["autopilot"]
        assert (cost["reviews_asked"], cost["reviews_a_day"]) == (6, 6) and cost["day_usd"] == 0.01     # never more than the day's ceiling
        c.put("/api/v1/assistant/settings", json={"autopilot_max_per_day": 1})                         # one a day is the one after the close
        assert c.get("/api/v1/assistant").json()["spending"]["autopilot"]["reviews_a_day"] == 1
        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "after_close"})
        assert c.get("/api/v1/assistant").json()["spending"]["autopilot"]["reviews_a_day"] == 1
        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "off"})
        assert c.get("/api/v1/assistant").json()["spending"]["autopilot"]["reviews_a_day"] == 0


def test_a_ceiling_reached_in_the_middle_of_the_work_stops_it_before_the_next_call(tmp_path):
    turn = cost_usd("claude-opus-5-5", USAGE)
    script = Script({"calls": [call(1, "portfolio")]}, {"calls": [call(2, "portfolio")]}, {"say": "never reached"})
    with app_with(tmp_path, script, assistant_daily_usd=0) as c:
        c.put("/api/v1/assistant/settings", json={"daily_usd": round(turn * 1.5, 6)})
        chat = new_chat(c)
        got = say(c, chat, "look at my portfolio twice")
        # two calls were paid for: after the second the day's ceiling is passed, and the third is never made
        assert len(script.seen) == 2
        assert [e["text"] for e in got if e["type"] == "notice"] == [
            f"Today's assistant budget (about USD {turn * 1.5:.2f}) is used up. It resets at midnight Cairo time. The assistant stopped here."]
        assert got[-1]["type"] == "done"
        # the conversation is whole: what was looked up is kept, and it can be picked up once there is room
        c.put("/api/v1/assistant/settings", json={"daily_usd": 0})
        script.turns.append({"say": "Here it is."})
        assert any(e["type"] == "text" for e in say(c, chat, "continue")) and len(script.seen) == 3



def test_the_ceilings_are_five_dollars_a_day_and_sixty_a_month_until_the_person_chooses_others(tmp_path):
    with app_with(tmp_path, Script()) as c:
        s = c.get("/api/v1/assistant").json()
        assert s["settings"]["daily_usd"] == 5.0 and s["spending"]["daily_limit_usd"] == 5.0
        assert s["settings"]["monthly_usd"] == 60.0 and s["spending"]["monthly_limit_usd"] == 60.0
        # no ceiling at all is still theirs to choose, and it is kept
        assert c.put("/api/v1/assistant/settings", json={"daily_usd": 0, "monthly_usd": 0}).json()["settings"]["monthly_usd"] == 0
