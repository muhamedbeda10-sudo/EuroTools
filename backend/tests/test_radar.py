"""The radar: the app watches the live prices for the assistant by itself, a small model sorts what it found,
and only what is worth it wakes the model that trades (no network, no cost)."""
import json
from datetime import UTC, datetime, timedelta

import pytest

from app import assistant, background, broker, radar, real_orders, services, wakes
from app.assistant_tools import parse
from app.data.feed import Feed
from app.llm import AssistantError, cost_usd
from app.store.sqlite_store import Store
from tests.test_assistant import USAGE, Script
from tests.test_real_auto import COMI, NEWCO, TMGH, a_floor, core_of, price

SERVER = {"cron_secret": "the-platforms-secret", "background_key": "local", "background_secret": "only-this-server-knows"}


@pytest.fixture(autouse=True)
def _fresh():
    for module in (Feed, broker, real_orders, background):
        module.reset()
    services._DEPTH_CACHE.clear()
    yield
    for module in (Feed, broker, real_orders, background):
        module.reset()


@pytest.fixture()
def floor(tmp_path, monkeypatch):
    """A running session with live prices, the radar's own clock moved with the floor's."""
    with a_floor(tmp_path, monkeypatch, **SERVER) as c:
        monkeypatch.setattr(radar, "cairo_now", lambda: c.clock["now"])
        monkeypatch.setattr(assistant, "market_open", lambda *a, **k: True)
        yield c


def settings(c, **change):
    """What the person saved in Settings → Assistant, written straight to their data."""
    store = Store(c.dir / "t.sqlite3")
    doc = store.get("settings", "assistant") or {}
    auto = {**(doc.get("autopilot") or {}), **{k[5:]: v for k, v in change.items() if k.startswith("auto_")}}
    spot = {**(doc.get("radar") or {}), **{k[6:]: v for k, v in change.items() if k.startswith("radar_")}}
    store.put("settings", "assistant", {**doc, "autopilot": auto, "radar": spot})


def reviewed(c, minutes=30):
    """The review after the close has been made, a while ago: what waits now is what happened since."""
    core = core_of(c)
    settings(c, auto_last_session=core.market.latest_settled().strftime("%Y-%m-%d"),
             auto_last_run=(datetime.now(UTC) - timedelta(minutes=minutes)).isoformat(timespec="seconds"))


def look(c) -> dict:
    return c.post("/api/v1/alerts/check").json()


def waiting(c) -> list[dict]:
    return wakes.pending(core_of(c))


def hold(c, symbol="COMI", qty=10):
    made = c.post("/api/v1/trades", json={"side": "BUY", "symbol": symbol, "qty": qty})
    assert made.status_code == 201, made.text


def brief(seen: dict) -> str:
    return " ".join(block["text"] for block in seen["messages"][0]["content"])


def sort_says(*numbers, why="Nothing here needs the assistant now."):
    return {"say": json.dumps({"wake": list(numbers), "why": why})}


# ---- what it looks at, and when it says nothing --------------------------------------------
def test_it_says_nothing_without_someone_to_tell_or_a_live_price(floor, tmp_path):
    c = floor
    hold(c)
    price(c, comi=COMI * 0.95)                                                   # a holding down 5%
    out = look(c)
    assert out["radar"] == 0 and out["wake"] is False and waiting(c) == []       # the autopilot is off: nobody to tell
    assert radar.scan(core_of(c))["why"] == "the assistant has no reviews of its own to tell"
    settings(c, auto_mode="events", radar_on=False)
    assert radar.scan(core_of(c))["why"] == "the radar is switched off" and waiting(c) == []
    settings(c, radar_on=True)
    c.clock["now"] += timedelta(hours=6)                                         # after the close
    assert radar.scan(core_of(c))["why"] == "the market is closed"
    # without a live feed (sample or imported data) there is nothing that is "now"
    from tests.test_assistant import app_with
    with app_with(tmp_path / "sample", Script()) as plain:
        plain.put("/api/v1/assistant/settings", json={"autopilot_mode": "events"})
        out = plain.post("/api/v1/alerts/check").json()
        assert out["radar"] == 0 and out["wake"] is False


def test_a_holding_that_moves_is_told_once_and_again_when_the_move_grows(floor):
    c = floor
    settings(c, auto_mode="events")
    hold(c)
    assert look(c)["radar"] == 0 and waiting(c) == []                           # nothing stands out yet
    price(c, comi=34.6)                                                         # about 3.4% under the last close
    out = look(c)
    assert out["radar"] == 1 and out["wake"] is True
    told = waiting(c)
    assert [(e["kind"], e["symbol"], e["scope"]) for e in told] == [("radar", "COMI", "mine")]
    assert told[0]["message"].startswith("COMI (the paper portfolio holds 10 at an average of 35.9) is at 34.6: down 3.")
    assert look(c)["radar"] == 0 and len(waiting(c)) == 1                       # said once, not at every look
    price(c, comi=34.5)
    assert look(c)["radar"] == 0                                                # a little further is not news
    price(c, comi=33.4)                                                         # twice the step, and under the 20-session low
    out = look(c)
    assert out["radar"] == 1
    again = waiting(c)[-1]["message"]
    assert "down 6." in again and "below its 20-session low of 33.7" in again
    # the same on the way up, with the high it broke
    price(c, tmgh=47.4)
    c.post("/api/v1/trades", json={"side": "BUY", "symbol": "TMGH", "qty": 5})
    assert look(c)["radar"] == 1
    up = waiting(c)[-1]["message"]
    assert up.startswith("TMGH (the paper portfolio holds 5") and "up 3." in up and "above its 20-session high of 46" in up
    # what was found is kept for the person to read, and a new session starts with a clean slate
    seen = c.get("/api/v1/assistant/radar")
    assert seen.status_code == 503                                              # the page is the assistant's: off without a key
    shown = radar.view(core_of(c))
    assert [e["symbol"] for e in shown["events"]] == ["TMGH", "COMI", "COMI"] and shown["own"] == ["COMI", "TMGH"]
    assert shown["wakes"] is True and "wakes the assistant for what stands out" in shown["standing"]
    state = Store(c.dir / "t.sqlite3").get(*radar.STATE)
    assert state["session"] == c.clock["now"].date().isoformat() and state["seen"]["COMI|down"] == 2


def test_a_holding_close_to_its_stop_or_its_target_is_told(floor):
    c = floor
    settings(c, auto_mode="events")
    hold(c)
    for kind, level in (("stop", 35.5), ("target", 36.3)):
        assert c.post("/api/v1/orders", json={"symbol": "COMI", "kind": kind, "price": level}).status_code == 201
    assert look(c)["radar"] == 1                                                # 35.9 is within 1.5% of both
    told = waiting(c)[-1]["message"]
    assert "above the paper portfolio's stop-loss at 35.5" in told and "under the paper portfolio's take-profit at 36.3" in told
    price(c, comi=35.8)
    assert look(c)["radar"] == 0                                                # each level is said once
    # a level that moves is a new level
    assert c.post("/api/v1/orders", json={"symbol": "COMI", "kind": "stop", "price": 35.6}).status_code == 201
    assert look(c)["radar"] == 1 and "stop-loss at 35.6" in waiting(c)[-1]["message"]
    # with reviews after the close only, a find waits for that review and wakes nobody
    settings(c, auto_mode="after_close")
    price(c, comi=34.0)
    out = look(c)
    assert out["radar"] == 1 and out["wake"] is False
    assert "With reviews after the close only" in radar.view(core_of(c))["standing"]


def test_the_rest_of_the_market_is_watched_loosely_and_many_at_once_are_one_find(floor, monkeypatch):
    c = floor
    settings(c, auto_mode="events")
    price(c, newco=NEWCO * 0.96)                                                # 4%: a move for a holding, not for a stranger
    assert look(c)["radar"] == 0
    price(c, newco=NEWCO * 1.08)
    assert look(c)["radar"] == 1
    told = waiting(c)[-1]
    assert told["scope"] == "market" and told["message"].startswith("NEWCO (a stock you neither hold nor follow) is at ")
    assert "up 8." in told["message"] and "above its 60-session high" in told["message"]
    # the watchlist makes a stock one of the person's own: the closer thresholds apply
    assert c.put("/api/v1/watchlist/TMGH").status_code == 200
    price(c, tmgh=TMGH * 0.96)
    assert look(c)["radar"] == 1 and waiting(c)[-1]["message"].startswith("TMGH (on the watchlist) is at ")
    # switched to the person's own stocks only, a stranger is not looked at
    settings(c, radar_market=False)
    price(c, comi=COMI * 0.9)
    assert look(c)["radar"] == 0
    # many strangers moving in the same minute are one piece of news
    settings(c, radar_market=True)
    monkeypatch.setattr(radar, "MARKET_BURST", 1)
    Store(c.dir / "t.sqlite3").put(*radar.STATE, {})
    price(c, comi=COMI * 0.9, newco=NEWCO * 1.09)
    out = look(c)
    assert out["radar"] == 2                                                    # TMGH, the person's own, and the strangers as one
    burst = next(e for e in waiting(c)[-2:] if e["symbol"] is None)
    assert burst["message"].startswith("2 stocks you neither hold nor follow stood out in the same minute")
    assert "The largest: COMI is at" in burst["message"] and "NEWCO" not in burst["message"]   # the largest are named, not all


def test_unusual_volume_is_told_for_a_holding_and_for_a_stranger_only_when_it_rises(floor, monkeypatch):
    c = floor
    settings(c, auto_mode="events")
    hold(c)
    quotes = c.fake.live

    def busy(stocks, timeout=8.0):
        got = quotes(stocks, timeout)
        for symbol in ("COMI", "NEWCO"):
            got["quotes"][symbol][4] = 13000.0                                  # 13 and about 4.3 times their usual day
        return got
    monkeypatch.setattr(c.fake, "live", busy)
    price(c)
    assert look(c)["radar"] == 1                                                # the holding; the stranger is not rising
    assert "COMI" in waiting(c)[-1]["message"] and "volume already 13.0 times its 20-session average" in waiting(c)[-1]["message"]
    price(c, newco=NEWCO * 1.03)
    assert look(c)["radar"] == 1 and "NEWCO" in waiting(c)[-1]["message"] and "times its 20-session average" in waiting(c)[-1]["message"]


# ---- the quick sort, and the wake-up ---------------------------------------------------------
def test_a_small_model_sorts_the_finds_and_the_assistant_is_woken_only_for_what_is_worth_it(floor):
    c = floor
    settings(c, auto_mode="events")
    hold(c)
    reviewed(c)
    price(c, newco=NEWCO * 1.08)
    assert look(c)["wake"] is True
    script = Script(sort_says(), sort_says(1, why="A holding is falling towards its low."), {"say": "Sold half."},
                    {"say": "the review after the close"})
    core = core_of(c)
    assert assistant.autopilot_state(core)["due"] == "event"
    held = assistant.run_autopilot(core, script)
    assert held["ran"] is False and held["skipped"] == "the radar's finds were sorted as minor" and held["sorted"] == 1
    assert held["why"] == "Nothing here needs the assistant now." and held["waiting"] == 0 and held["due"] is None
    # what the small model was told: the mandate, the person's stocks and the finds, and no tools
    seen = script.seen[0]
    assert seen["tools"] == [] and seen["system"] == assistant.SORT_PROMPT
    told = brief(seen)
    assert "The owner's mandate:" in told and "- COMI: the paper portfolio holds 10" in told
    assert "1. NEWCO (a stock you neither hold nor follow) is at" in told and "Write `why`" in told
    # the find stays, marked, and starts no review of its own; no conversation was opened and no review counted
    kept = waiting(c)
    assert [wakes.minor(e) for e in kept] == [True] and kept[0]["sorted_why"] == "Nothing here needs the assistant now."
    assert assistant.autopilot_state(core_of(c))["due"] is None and assistant.chats(core_of(c)) == []
    use = assistant.spending(core_of(c))["use"]["today"]
    assert use["sort"] == {"n": 1, "usd": pytest.approx(cost_usd("claude-opus-5-5", USAGE), abs=1e-4)}
    assert use["watch"]["n"] == use["review"]["n"] == 0
    assert assistant.run_autopilot(core_of(c), script)["ran"] is False and len(script.seen) == 1   # nothing new: nothing spent

    # a find worth it wakes the model that trades, which is handed that find and not the minor one
    price(c, comi=34.6)
    assert look(c)["wake"] is True
    woke = assistant.run_autopilot(core_of(c), script)
    assert woke["ran"] and woke["reason"] == "event" and woke["events"] == 1 and len(script.seen) == 3
    told = brief(script.seen[2])
    assert told.startswith("AUTOPILOT WAKE-UP.") and "the radar saw: COMI (the paper portfolio holds 10" in told
    assert "NEWCO" not in told and "A line that begins “the radar saw” is something the app noticed by itself" in told
    assert "The app's radar is on as well" in told and "It wakes you for what stands out, after a small model" in told
    assert [e["symbol"] for e in waiting(c)] == ["NEWCO"]                       # the minor one still waits
    use = assistant.spending(core_of(c))["use"]["today"]
    assert (use["sort"]["n"], use["watch"]["n"]) == (2, 1)
    # the next full review is told what was sorted away meanwhile, and the queue is empty after it
    settings(c, auto_last_session=None)
    close = assistant.run_autopilot(core_of(c), script)
    assert close["ran"] and close["reason"] == "close" and close["events"] == 1
    told = brief(script.seen[3])
    assert "the radar saw: NEWCO (a stock you neither hold nor follow)" in told
    assert "(a quick sort judged this minor: Nothing here needs the assistant now)" in told and waiting(c) == []
    # the person can read what was found and how it was sorted
    log = radar.view(core_of(c))["events"]
    assert [(e["type"], e.get("woke")) for e in log if e["type"] == "sort"] == [("sort", 1), ("sort", 0)]
    tool, args, problem = parse("radar", {})
    assert problem is None and tool.run(core_of(c), args)["settings"]["triage"] is True


def test_a_sort_that_fails_or_cannot_be_read_wakes_the_assistant_and_a_watch_is_never_sorted(floor):
    c = floor
    settings(c, auto_mode="events")
    hold(c)
    reviewed(c)
    price(c, comi=34.6)
    look(c)
    # an answer that is not what was asked for: the find is not dropped, the assistant is woken
    script = Script({"say": "I think it is fine."}, {"say": "Looked: nothing to do."})
    woke = assistant.run_autopilot(core_of(c), script)
    assert woke["ran"] and woke["events"] == 1 and len(script.seen) == 2 and waiting(c) == []
    assert radar.view(core_of(c))["events"][0]["why"] == "The sort's answer could not be read, so the assistant was woken."
    # the small model cannot be reached: the same
    reviewed(c)
    price(c, comi=33.4)
    look(c)
    script = Script(AssistantError("The service is busy."), {"say": "Looked again."})
    assert assistant.run_autopilot(core_of(c), script)["ran"] and len(script.seen) == 2
    # numbers that name no find are not an answer either
    for bad in ('{"wake": [7], "why": "x"}', '{"wake": "all"}', '{"why": "x"}', "{not json"):
        assert assistant._sort_answer(bad, 2) is None, bad
    assert assistant._sort_answer('Here: {"wake": [2, 1, 2], "why": " two  words "} done', 2) == ([1, 2], "two words")
    # a watch the assistant or the person set was asked for: with one waiting nothing is sorted, and it is told everything
    reviewed(c)
    price(c, newco=NEWCO * 1.08)
    c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "TMGH", "value": 1, "note": "check it", "wake": True})
    assert look(c)["wake"] is True
    script = Script({"say": "Handled both."})
    both = assistant.run_autopilot(core_of(c), script)
    assert both["ran"] and both["events"] == 2 and len(script.seen) == 1
    assert "TMGH is at" in brief(script.seen[0]) and "the radar saw: NEWCO" in brief(script.seen[0])
    # with the sort switched off every find wakes it directly
    settings(c, radar_triage=False)
    reviewed(c)
    price(c, tmgh=TMGH * 1.08)
    look(c)
    script = Script({"say": "Looked."})
    assert assistant.run_autopilot(core_of(c), script)["reason"] == "event" and len(script.seen) == 1
    assert "after a small model" not in brief(script.seen[0])


def test_the_days_limit_and_the_ceilings_hold_the_sort_back_too(floor):
    c = floor
    settings(c, auto_mode="events", auto_max_per_day=1)
    hold(c)
    reviewed(c)
    price(c, comi=34.6)
    look(c)
    script = Script()
    held = assistant.run_autopilot(core_of(c), script)                          # the day's reviews are used up: nothing is asked
    assert held["ran"] is False and held["skipped"] == "today's reviews are used up" and script.seen == []
    assert len(wakes.fresh(waiting(c))) == 1                                    # it waits for the review after the close


def test_what_gives_way_first_in_the_queue_is_what_matters_least(floor):
    core = core_of(floor)
    watch = {"ts": "t0", "kind": "price_above", "symbol": "COMI", "message": "a watch"}
    finds = [{"ts": f"t{n}", "kind": "radar", "symbol": f"S{n}", "message": f"find {n}"} for n in range(wakes.MAX_PENDING)]
    wakes.add(core, [watch, *finds[:3]])
    assert wakes.mark_minor(core, finds[:2], "noise") == 2
    wakes.add(core, finds[3:])
    kept = wakes.pending(core)
    assert len(kept) == wakes.MAX_PENDING and kept[0] == watch                  # the watch stays: it was asked for
    assert [e["symbol"] for e in kept if wakes.minor(e)] == ["S1"]              # the oldest minor find went first
    # a short review is handed what woke it; the minor ones stay for the next full review
    handed = wakes.take(core, only_fresh=True)
    assert len(handed) == wakes.MAX_PENDING - 1 and [e["symbol"] for e in wakes.pending(core)] == ["S1"]
    assert wakes.take(core) == wakes.pending(core) or wakes.pending(core) == []


# ---- the rest of the app that it touches ------------------------------------------------------
def test_a_stop_the_app_carried_out_on_the_paper_portfolio_is_told_to_the_assistant(floor):
    c = floor
    hold(c)
    assert c.post("/api/v1/orders", json={"symbol": "COMI", "kind": "stop", "price": 35.0}).status_code == 201
    price(c, comi=34.9)
    settings(c, auto_mode="events", auto_account="real", radar_on=False)
    assert c.post("/api/v1/paper-runs/process").json()["orders"] != [] and waiting(c) == []   # the real account only: not its business
    hold(c)
    assert c.post("/api/v1/orders", json={"symbol": "COMI", "kind": "stop", "price": 34.5}).status_code == 201
    settings(c, auto_account="paper")
    price(c, comi=34.4)
    done = c.post("/api/v1/paper-runs/process").json()["orders"]
    assert [o["symbol"] for o in done] == ["COMI"]
    told = waiting(c)
    assert [e["kind"] for e in told] == ["paper_exit"]
    assert told[0]["message"].startswith("The app carried out an order of the paper portfolio's by itself: Stop-loss on COMI: sold 10 at")
    # a sale the app made cannot wait for a sort: the assistant is woken and told
    reviewed(c)
    script = Script({"say": "Noted."})
    woke = assistant.run_autopilot(core_of(c), script)
    assert woke["ran"] and woke["reason"] == "event" and len(script.seen) == 1 and "Stop-loss on COMI" in brief(script.seen[0])


def test_the_servers_own_look_runs_the_radar_and_the_checklist_names_it(floor):
    c = floor
    settings(c, auto_mode="events")
    hold(c)
    price(c, comi=34.6)
    core = core_of(c)
    out: dict = {}
    background._alerts(core, out, {"sent": 0, "failed": 0, "removed": 0})
    assert out["radar"] == {"events": 1} and [e["symbol"] for e in waiting(c)] == ["COMI"]
    settings(c, radar_on=False)
    background._alerts(core_of(c), out, {"sent": 0, "failed": 0, "removed": 0})
    assert out["radar"] == {"events": 0, "why": "the radar is switched off"}
    # the checklist of trading by itself says where the radar stands
    from app import self_trading
    rows = {r["key"]: r for r in self_trading.report(core_of(c))["rows"]}
    assert rows["radar"]["state"] == "note" and rows["radar"]["fix"] == "radar"
    settings(c, radar_on=True)
    rows = {r["key"]: r for r in self_trading.report(core_of(c))["rows"]}
    assert rows["radar"]["state"] == "ok" and "wakes it for what stands out" in rows["radar"]["detail"]
    # a look that fails says so and breaks nothing
    broken = core_of(c)
    broken.quotes = lambda: (_ for _ in ()).throw(RuntimeError("no table"))
    assert radar.scan(broken) == {"ran": False, "why": "the radar's look failed (RuntimeError)", "events": 0, "wake": False}


def test_the_radars_settings_are_the_persons_and_must_fit_together(tmp_path):
    from tests.test_assistant import app_with
    with app_with(tmp_path, Script()) as c:
        first = c.get("/api/v1/assistant").json()["settings"]["radar"]
        assert first == {"on": True, "market": True, "triage": True, "move_pct": 3.0, "market_move_pct": 7.0,
                         "volume_x": 2.0, "market_volume_x": 4.0, "near_pct": 1.5}
        saved = c.put("/api/v1/assistant/settings", json={"radar_move_pct": 2, "radar_market": False, "radar_triage": False,
                                                           "radar_near_pct": 1}).json()["settings"]["radar"]
        assert (saved["move_pct"], saved["market"], saved["triage"], saved["near_pct"], saved["on"]) == (2.0, False, False, 1.0, True)
        for bad in ({"radar_move_pct": 0.5}, {"radar_market_move_pct": 25}, {"radar_volume_x": 1}, {"radar_near_pct": 9}):
            assert c.put("/api/v1/assistant/settings", json=bad).status_code == 422, bad
        res = c.put("/api/v1/assistant/settings", json={"radar_move_pct": 9})
        assert res.status_code == 422 and "cannot be smaller than the one for your own stocks" in res.json()["detail"]
        # the page reads what it is set to and what it found; the assistant is told about it in its instructions
        seen = c.get("/api/v1/assistant/radar").json()
        assert seen["settings"] == saved and seen["events"] == [] and seen["wakes"] is False
        assert "It does nothing yet" in seen["standing"]
        assert "The app also has a radar" in assistant.system_prompt() and "`radar` shows its settings" in assistant.system_prompt()
        # a figure saved by an older version that no longer fits is read as the default, never as a broken setting
        store = Store(tmp_path / "t.sqlite3")
        doc = store.get("settings", "assistant")
        store.put("settings", "assistant", {**doc, "radar": {"move_pct": 400, "on": "yes", "near_pct": 2}})
        now = c.get("/api/v1/assistant").json()["settings"]["radar"]
        assert (now["move_pct"], now["on"], now["near_pct"]) == (3.0, True, 2.0)
