"""Trading by itself: the one checklist of what is in place for the assistant to act without being asked.

It reads the switches that already existed and says which are missing. It opens no new way to anything: the
tests here also keep it from ever doing more than read.
"""
import json
import re
from pathlib import Path

import pytest

from app import assistant, background, broker, real_orders, self_trading
from app.assistant_prefs import PrefsIn, save_prefs
from app.assistant_tools import parse
from app.data.feed import Feed
from tests.test_assistant import Script
from tests.test_autopilot_account import arm, choose, desk
from tests.test_autopilot_account import core_of as desk_core
from tests.test_background import SERVER, switch
from tests.test_real_auto import a_floor, core_of, on


@pytest.fixture(autouse=True)
def _fresh():
    for module in (Feed, broker, real_orders, background):
        module.reset()
    yield
    for module in (Feed, broker, real_orders, background):
        module.reset()


def told(c) -> tuple[dict, dict]:
    st = c.get("/api/v1/assistant").json()["self_trading"]
    return st, {r["key"]: r for r in st["rows"]}


def test_it_says_what_is_missing_for_the_paper_portfolio_step_by_step(tmp_path, monkeypatch):
    with desk(tmp_path, monkeypatch, Script([]), owner=False) as c:
        st, rows = told(c)
        assert st["level"] == "off" and rows["schedule"]["state"] == "missing" and st["missing"] == 1
        assert set(rows) == {"schedule", "access", "budget", "closed"}             # nothing about real money for anyone else

        choose(c, autopilot_mode="events", access="confirm")
        st, rows = told(c)
        assert st["level"] == "looks" and rows["schedule"]["state"] == "ok"
        assert rows["access"]["state"] == "missing" and rows["access"]["fix"] == "access" and "Ask me first" in rows["access"]["detail"]

        st = choose(c, access="full")["self_trading"]                             # the answer to a save carries the list too
        assert st["level"] == "paper" and st["missing"] == 0 and "paper portfolio by itself" in st["headline"]
        _, rows = told(c)
        assert rows["closed"]["state"] == "note" and "href" not in rows["closed"]  # the server's own looks are the owner's

        # a ceiling that has been reached holds it back, and the list says so
        choose(c, daily_usd=0.01, monthly_usd=5)
        core = desk_core(c, owner=False)
        usage = core.store.get("assistant_usage", assistant.cairo_now().date().isoformat()) or {}
        core.store.put("assistant_usage", assistant.cairo_now().date().isoformat(), {**usage, "cost_usd": 0.5})
        st, rows = told(c)
        assert st["level"] == "held" and rows["budget"]["state"] == "missing"


def test_for_the_owner_it_names_each_step_towards_real_orders(tmp_path, monkeypatch):
    with desk(tmp_path, monkeypatch, Script([])) as c:
        choose(c, autopilot_mode="after_close", autopilot_account="both")
        st, rows = told(c)
        assert rows["real_orders"]["state"] == "missing" and "Settings → Real trading" in rows["real_orders"]["detail"]
        assert rows["automatic"]["state"] == "missing" and rows["automatic"]["href"] == "/settings?tab=real"
        assert st["level"] == "paper" and "only looks and reports" in st["headline"]

        arm(c)                                                                     # real orders on, each on the owner's approval
        st, rows = told(c)
        assert rows["real_orders"]["state"] == "ok" and rows["proposals"]["state"] == "ok"
        assert rows["automatic"]["state"] == "missing" and "waits for your approval" in rows["automatic"]["detail"]
        assert st["level"] == "proposals" and "each one waits for your approval" in st["headline"]

        choose(c, real_proposals_per_day=0)
        st, rows = told(c)
        assert rows["proposals"]["state"] == "missing" and st["level"] == "paper"

        choose(c, autopilot_account="paper")                                       # the paper portfolio only: real money is no part of it
        st, rows = told(c)
        assert st["level"] == "paper" and not {"real_orders", "proposals", "automatic"} & set(rows)


def test_with_the_box_on_and_the_server_looking_nothing_is_missing(tmp_path, monkeypatch):
    with a_floor(tmp_path, monkeypatch, **SERVER) as c:
        on(c)                                                                      # real orders on, the switch earned, the box on
        core = core_of(c)
        save_prefs(core, PrefsIn(autopilot_mode="events", autopilot_account="real", access="full"))
        st = self_trading.report(core_of(c))
        rows = {r["key"]: r for r in st["rows"]}
        assert st["level"] == "automatic" and "sent to the broker without you" in st["headline"]
        assert rows["automatic"]["state"] == "ok" and rows["closed"]["state"] == "note" and st["missing"] == 0
        assert switch(c).json()["enabled"] is True                                 # running without the app open
        rows = {r["key"]: r for r in self_trading.report(core_of(c))["rows"]}
        assert rows["closed"]["state"] == "ok" and "stop-losses" in rows["closed"]["detail"]

        # the assistant is told the same list by its `settings` tool, and can change none of it
        tool, parsed, problem = parse("settings", {})
        assert problem is None and tool.kind == "read"
        content, failed = assistant._execute(core_of(c), tool, parsed)
        mine = json.loads(content)["assistant"]
        assert not failed and mine["trading_by_itself"]["level"] == "automatic" and mine["autopilot"]["account"] == "real"
        assert mine["access"] == "full"


def test_the_checklist_only_reads():
    """Kept by a test: the module that reports on the switches has no hand on any of them."""
    source = (Path(__file__).resolve().parent.parent / "app" / "self_trading.py").read_text()
    assert set(re.findall(r"real_auto\.(\w+)\(", source)) == {"brief"}
    assert set(re.findall(r"real_orders\.(\w+)\(", source)) == {"readiness"}
    assert set(re.findall(r"background\.(\w+)\(", source)) == {"menu"}
    for write in ("store.put", "store.append", "store.delete", "save_prefs", "send_waiting", "tick(", "propose(", "push."):
        assert write not in source, write
