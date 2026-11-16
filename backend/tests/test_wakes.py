"""The app watches for the assistant and wakes it: alerts that wake, the queue, the short review (no network, no cost)."""
import json
from datetime import UTC, datetime, timedelta

from app import assistant, wakes
from app.assistant_tools import parse
from app.config import Settings
from app.data import calendar
from app.data.calendar import CAIRO
from app.services import App
from app.store.sqlite_store import Store
from tests.test_assistant import Script, app_with

NOTE = "Breakout over the range high: check the volume, buy only if it holds."


def brief(seen: dict) -> str:
    return " ".join(block["text"] for block in seen["messages"][0]["content"])


def core_at(tmp_path) -> App:
    return App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path)).bootstrap()


def long_ago(tmp_path, minutes=30):
    """The last review was a while ago, so the pause between two reviews is over."""
    store = Store(tmp_path / "t.sqlite3")
    doc = store.get("settings", "assistant")
    doc["autopilot"]["last_run"] = (datetime.now(UTC) - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    store.put("settings", "assistant", doc)


def test_a_watch_is_checked_by_the_app_fires_once_and_waits_for_the_assistant(tmp_path):
    with app_with(tmp_path, Script()) as c:
        watch = c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "COMI", "value": 1, "note": NOTE, "wake": True}).json()
        plain = c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "TMGH", "value": 1}).json()
        assert (watch["wake"], watch["by"], plain["wake"], plain["by"]) == (True, "user", False, "user")
        out = c.post("/api/v1/alerts/check").json()
        assert {e["symbol"]: e["wake"] for e in out["triggered"]} == {"COMI": True, "TMGH": False}
        assert out["wake"] is True and out["pushed"] == 0                       # nobody subscribed a device here
        now = {a["id"]: a for a in c.get("/api/v1/alerts").json()["alerts"]}
        assert now[watch["id"]]["active"] is False and now[plain["id"]]["active"] is True   # a watch fires once; an alert stays
        again = c.post("/api/v1/alerts/check").json()
        assert again["triggered"] == [] and again["wake"] is False
        # what happened waits for the assistant, with the note that was written for that moment
        waiting = wakes.pending(core_at(tmp_path))
        assert len(waiting) == 1 and waiting[0]["symbol"] == "COMI" and waiting[0]["note"] == NOTE
        assert "COMI is at" in waiting[0]["message"] and "at or above 1" in waiting[0]["message"]

        # a watch nobody renewed lapses instead of waking anyone with a stale idea
        old = c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "SWDY", "value": 1, "note": NOTE, "wake": True}).json()
        store = Store(tmp_path / "t.sqlite3")
        store.put("alerts", old["id"], {**store.get("alerts", old["id"]),
                                         "updated_at": (datetime.now(UTC) - timedelta(days=wakes.WATCH_DAYS + 1)).isoformat()})
        assert c.post("/api/v1/alerts/check").json()["triggered"] == []
        lapsed = next(a for a in c.get("/api/v1/alerts").json()["alerts"] if a["id"] == old["id"])
        assert lapsed["active"] is False and lapsed["lapsed"] is True and len(wakes.pending(core_at(tmp_path))) == 1
        # the queue is bounded: the oldest give way
        core = core_at(tmp_path)
        wakes.add(core, [{"ts": "t", "kind": "x", "message": f"m{n}"} for n in range(wakes.MAX_PENDING + 3)])
        kept = wakes.pending(core)
        assert len(kept) == wakes.MAX_PENDING and kept[-1]["message"] == f"m{wakes.MAX_PENDING + 2}"


def test_a_time_can_be_watched_like_a_price(tmp_path, monkeypatch):
    clock = {"now": datetime(2026, 11, 16, 10, 0, tzinfo=CAIRO)}                # a Monday, during the session
    monkeypatch.setattr(calendar, "cairo_now", lambda: clock["now"])
    with app_with(tmp_path, Script()) as c:
        def at(when, **more):
            return c.post("/api/v1/alerts", json={"kind": "time_at", "at": when, "note": NOTE, "wake": True, **more})
        today = at("13:30", symbol="COMI").json()
        assert today["at"] == "2026-11-16T13:30+02:00" and today["value"] is None
        assert at("09:00").json()["at"] == "2026-11-17T09:00+02:00"             # already past today: the next trading day
        assert at("2026-11-20 10:15").json()["at"] == "2026-11-20T10:15+02:00"   # the day they named, as named
        clock["now"] = datetime(2026, 11, 19, 15, 0, tzinfo=CAIRO)              # Thursday afternoon
        assert at("10:00").json()["at"] == "2026-11-22T10:00+02:00"             # not Friday, not Saturday: Sunday
        clock["now"] = datetime(2026, 11, 16, 10, 0, tzinfo=CAIRO)
        for bad, why in (("25:99", "not a time of day"), ("2026-11-15 10:00", "already passed"), ("2027-03-01 10:00", "days ahead")):
            res = at(bad)
            assert res.status_code == 422 and why in res.json()["detail"], bad
        assert at("soon").status_code == 422 and at(None).status_code == 422
        # nothing before the time; at the time it fires once, wakes the assistant and is switched off
        assert c.post("/api/v1/alerts/check").json()["triggered"] == []
        clock["now"] = datetime(2026, 11, 16, 13, 31, tzinfo=CAIRO)
        fired = c.post("/api/v1/alerts/check").json()
        assert [e["message"] for e in fired["triggered"]] == [
            "It is 13:31 Cairo time: the moment set for 2026-11-16 13:30 has come (about COMI)"] and fired["wake"] is True
        assert next(a for a in c.get("/api/v1/alerts").json()["alerts"] if a["id"] == today["id"])["active"] is False
        assert c.post("/api/v1/alerts/check").json()["triggered"] == []


def test_the_assistant_sets_its_own_watches_and_is_told_what_will_happen(tmp_path):
    core = core_at(tmp_path)

    def run(**args):
        tool, parsed, problem = parse("save_alert", args)
        assert problem is None, problem
        content, failed = assistant._execute(core, tool, parsed)
        return json.loads(content), failed, tool.label(parsed)

    out, failed, _ = run(kind="price_above", symbol="COMI", value=500, wake_me=True)
    assert failed and "Say in the note what to check when it fires" in out["error"]
    out, failed, label = run(kind="price_above", symbol="COMI", value=500, wake_me=True, note=NOTE)
    assert not failed and (out["wake"], out["by"], out["active"]) == (True, "assistant", True) and label == "Set a watch on COMI"
    assert "autopilot is off, so nothing wakes you" in out["what_happens_when_it_fires"]
    assert f"lapses by itself after {wakes.WATCH_DAYS} days" in out["what_happens_when_it_fires"]
    # an ordinary alert is still the user's, and says nothing about waking
    plain, failed, label = run(kind="price_below", symbol="COMI", value=1)
    assert not failed and (plain["wake"], plain["by"]) == (False, "user") and "what_happens_when_it_fires" not in plain
    assert label == "Save an alert on COMI"
    # a time, and what happens in each mode of the autopilot
    for mode, words in (("events", "wakes you with a short review of this event alone"), ("intraday", "wakes you with a short review"),
                        ("after_close", "you are told of it at that review")):
        core.store.put("settings", "assistant", {"autopilot": {"mode": mode}})
        out, failed, _ = run(kind="time_at", at="2026-12-01 13:30", wake_me=True, note=NOTE)
        assert not failed and words in out["what_happens_when_it_fires"], mode
    # switching one off needs no note, and there is a most it may have on at once
    off, failed, _ = run(id=out["id"], kind="time_at", at="2026-12-01 13:30", wake_me=True, active=False)
    assert not failed and off["active"] is False
    on_now = sum(1 for a in core.store.list("alerts") if a.get("wake") and a["active"] and a.get("by") == "assistant")
    for n in range(wakes.MAX_WATCHES - on_now):
        assert not run(kind="price_above", symbol="TMGH", value=900 + n, wake_me=True, note=NOTE)[1]
    out, failed, _ = run(kind="price_above", symbol="TMGH", value=999, wake_me=True, note=NOTE)
    assert failed and f"{wakes.MAX_WATCHES} watches of yours are already on" in out["error"]


def test_what_the_app_saw_wakes_the_assistant_for_a_short_review_of_that_alone(tmp_path, monkeypatch):
    open_now = {"is": True}
    monkeypatch.setattr(assistant, "market_open", lambda *a, **k: open_now["is"])
    script = Script(*({"say": f"review {n}"} for n in range(6)))
    with app_with(tmp_path, script) as c:
        def review():
            return c.post("/api/v1/assistant/autopilot").json()

        def fire(symbol="COMI"):
            c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": symbol, "value": 1, "note": NOTE, "wake": True})
            assert c.post("/api/v1/alerts/check").json()["wake"] is True

        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "events"})
        first = review()                                                        # the review after the close comes first
        assert first["ran"] and first["reason"] == "close" and first["events"] == 0
        told = brief(script.seen[0])
        assert "No watch is on now." in told and "save_alert with wake_me" in told and "(5) leave watches" in told
        assert "wakes you with a short review of that event alone" in told
        long_ago(tmp_path)
        assert review()["ran"] is False and len(script.seen) == 1               # nothing is watched for, so nothing is spent

        fire()
        assert c.get("/api/v1/assistant").json()["autopilot"] == {
            **c.get("/api/v1/assistant").json()["autopilot"], "due": "event", "waiting": 1}
        woke = review()
        assert woke["ran"] and woke["reason"] == "event" and woke["events"] == 1 and len(script.seen) == 2
        told = brief(script.seen[1])
        assert told.startswith("AUTOPILOT WAKE-UP.") and "This is not a full review" in told
        assert "COMI is at" in told and f"Your note when you set it: “{NOTE}”" in told
        assert "Work through it in this order" not in told and "End with two or three sentences" in told
        assert wakes.pending(core_at(tmp_path)) == []                           # told to that review and to no other

        # a burst is one review: straight after a review an event waits out the pause
        fire("TMGH")
        fire("SWDY")
        held = review()
        assert held["ran"] is False and held["due"] is None and held["waiting"] == 2
        long_ago(tmp_path, minutes=6)
        both = review()
        assert both["ran"] and both["events"] == 2 and "TMGH is at" in brief(script.seen[2]) and "SWDY is at" in brief(script.seen[2])

        # outside the session it waits; the day's limit holds it back like a timed review, and the close review is told instead
        fire("ORAS")
        long_ago(tmp_path)
        open_now["is"] = False
        assert review()["ran"] is False
        open_now["is"] = True
        c.put("/api/v1/assistant/settings", json={"autopilot_max_per_day": 2})
        held = review()
        assert held["ran"] is False and held["skipped"] == "today's reviews are used up"
        assert "is told what the app saw meanwhile" in held["why"] and len(wakes.pending(core_at(tmp_path))) == 1
        store = Store(tmp_path / "t.sqlite3")
        doc = store.get("settings", "assistant")
        doc["autopilot"]["last_session"] = None                                 # a new session has completed
        store.put("settings", "assistant", doc)
        close = review()
        assert close["ran"] and close["reason"] == "close" and close["events"] == 1
        told = brief(script.seen[3])
        assert told.startswith("AUTOPILOT REVIEW.") and "Since your last review the app saw what it was watching for you:" in told
        assert "ORAS is at" in told and wakes.pending(core_at(tmp_path)) == []

        # with reviews after the close only, an event never starts one: it waits for that review
        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "after_close", "autopilot_max_per_day": 12})
        fire("EAST")
        long_ago(tmp_path)
        assert review()["ran"] is False and len(wakes.pending(core_at(tmp_path))) == 1
        # and with the autopilot off nothing is asked of the queue at all
        c.put("/api/v1/assistant/settings", json={"autopilot_mode": "off"})
        assert c.get("/api/v1/assistant").json()["autopilot"]["waiting"] == 0 and len(script.seen) == 4


def test_what_a_day_can_cost_when_watches_wake_it(tmp_path):
    with app_with(tmp_path, Script()) as c:
        def cost(**settings):
            return c.put("/api/v1/assistant/settings", json=settings).json()["spending"]["autopilot"]
        events = cost(autopilot_mode="events", autopilot_max_per_day=8)
        assert (events["mode"], events["reviews_asked"], events["reviews_a_day"], events["reviews_at_most"]) == ("events", 1, 1, 8)
        timed = cost(autopilot_mode="intraday", autopilot_every_minutes=60)
        assert (timed["reviews_asked"], timed["reviews_a_day"], timed["reviews_at_most"]) == (6, 6, 8)
        close = cost(autopilot_mode="after_close")
        assert (close["reviews_asked"], close["reviews_a_day"], close["reviews_at_most"]) == (1, 1, 1)
        assert close["usual_day_usd"] is None and close["review_usd"] is None   # nothing has run yet


def test_the_automations_own_way_out_of_a_position_is_told_to_the_assistant(tmp_path):
    core = core_at(tmp_path)
    look = {"exits": [{"status": "sent", "symbol": "COMI", "qty": 10, "price": "34.5", "reason": "Stop-loss 34.60 reached (last 34.55)."},
                      {"status": "failed", "symbol": "TMGH", "qty": 5, "price": 44.0, "reason": "x"}]}
    assert wakes.note_exits(core, look) == 0 and wakes.pending(core) == []     # the autopilot is off: nobody to tell
    core.store.put("settings", "assistant", {"autopilot": {"mode": "after_close"}})
    assert wakes.note_exits(core, look) == 0                                    # that review reads the account itself
    core.store.put("settings", "assistant", {"autopilot": {"mode": "events"}})
    assert wakes.note_exits(core, look) == 1
    told = wakes.pending(core)
    assert [e["kind"] for e in told] == ["real_exit"] and told[0]["symbol"] == "COMI"
    assert "sale of 10 COMI at 34.5 on the real account" in told[0]["message"] and "Stop-loss 34.60 reached" in told[0]["message"]
    assert wakes.lines(told)[0].startswith("- ") and "The app sent a sale of 10 COMI" in wakes.lines(told)[0]
    # word of a look never breaks the look
    assert wakes.note_exits(core, {"exits": [{"status": "sent"}]}) == 0 and wakes.note_exits(core, {}) == 0


def test_the_assistant_is_told_to_hand_work_to_the_app():
    prompt = assistant.system_prompt()
    assert "Hand to the app what the app can do by itself" in prompt and "save_alert with wake_me" in prompt
    tool = next(t for t in assistant.tool_specs() if t["name"] == "save_alert")
    assert "wake_me" in tool["input_schema"]["properties"] and "time_at" in tool["input_schema"]["properties"]["kind"]["enum"]
    assert "wakes YOU" in tool["description"]
