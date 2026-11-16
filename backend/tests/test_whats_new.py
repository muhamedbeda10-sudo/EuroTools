"""What's new: one file of release notes for the people who use the app and for the assistant inside it (no network)."""
import json
import re
from datetime import date
from pathlib import Path

import pytest

from app import assistant, whats_new
from app.assistant_tools import library, parse, trading_references
from app.data.feed import Feed
from tests.test_broker import FakeBroker, client

ROOT = Path(__file__).resolve().parent.parent.parent
NOTES = """# What's new
The notes.

## 0.2.0 · 2026-02-02 · Second thing
For: owner
Open: /account
عربي: الحاجة التانية

- It does this.
  عربي: بيعمل كده.

## 0.1.0 · 2026-01-01 · First thing
For: everyone
عربي: أول حاجة

- It does that.
  عربي: بيعمل كده كمان.
"""


@pytest.fixture(autouse=True)
def _fresh():
    Feed.reset()
    yield
    Feed.reset()


def test_the_release_notes_are_whole_and_the_newest_is_the_apps_own_version():
    """Read the real file. A release without its Arabic, out of order, or ahead of the app's version fails here."""
    releases = whats_new.releases()
    assert releases, "the release notes are empty"
    package = json.loads((ROOT / "package.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    assert whats_new.version() == releases[0]["version"] == package["version"] == lock["version"] == lock["packages"][""]["version"], \
        "the newest release in whats-new.md, package.json and package-lock.json must carry the same version"
    pages = {p.parent.name for p in (ROOT / "app").glob("*/page.tsx")} | {""}
    for r in releases:
        assert re.search(r"[؀-ۿ]", r["title"]["ar"]) and not re.search(r"[؀-ۿ]", r["title"]["en"]), r["id"]
        assert date.fromisoformat(r["date"]) <= date.today(), f"{r['id']} is dated in the future"
        assert all(re.search(r"[؀-ۿ]", p["ar"]) and len(p["en"]) > 15 for p in r["points"]), r["id"]
        if r["where"]:
            assert r["where"].split("?")[0].strip("/") in pages, f"{r['id']} opens a page the app does not have"
    # nothing that belongs in the server's environment has found its way into what users read
    text = whats_new.SOURCE.read_text(encoding="utf-8")
    assert not re.search(r"(?i)secret=|api[_ ]key\s*[:=]|bearer |bk1\.", text)


def test_the_form_of_the_notes_is_kept_strictly():
    two = whats_new.parse(NOTES)
    assert [(r["version"], r["for"], r["where"], r["title"]["ar"]) for r in two] == \
        [("0.2.0", "owner", "/account", "الحاجة التانية"), ("0.1.0", "everyone", None, "أول حاجة")]
    assert two[0]["points"] == [{"en": "It does this.", "ar": "بيعمل كده."}] and two[0]["id"] == "0.2.0-second-thing"
    for broken, words in (
            (NOTES.replace("عربي: الحاجة التانية\n", ""), "needs 'For:', an Arabic title"),
            (NOTES.replace("  عربي: بيعمل كده.\n", ""), "both languages for every point"),
            (NOTES.replace("For: owner", "For: admins"), "everyone or owner"),
            (NOTES.replace("For: owner\n", ""), "needs 'For:'"),
            (NOTES.replace("Open: /account", "Open: https://example.com"), "a page of the app"),
            (NOTES.replace("## 0.2.0 · 2026-02-02", "## v2 · February"), "a release is headed"),
            (NOTES.replace("2026-02-02", "2026-02-31"), "is not a date"),
            (NOTES.replace("2026-02-02", "2025-12-01"), "newest first"),
            (NOTES.replace("- It does this.", "It does this."), "not a line the release notes know"),
            (NOTES + NOTES.split("## 0.1.0")[1].join(["## 0.1.0", ""]), "same version and title")):
        with pytest.raises(whats_new.ReleaseNotesError, match=words):
            whats_new.parse(broken)


def test_each_person_is_shown_what_is_new_to_them_once(tmp_path, monkeypatch):
    monkeypatch.setattr(whats_new, "releases", lambda: tuple(whats_new.parse(NOTES)))
    with client(tmp_path / "owner", FakeBroker()) as c:                         # the brokerage account's owner
        first = c.get("/api/v1/whats-new").json()
        assert (first["version"], first["unseen"], first["latest"]) == ("0.2.0", 2, "0.2.0-second-thing")
        assert [(r["id"], r["new"], r["where"]) for r in first["releases"]] == \
            [("0.2.0-second-thing", True, "/account"), ("0.1.0-first-thing", True, None)]
        assert first["releases"][0]["title"] == {"en": "Second thing", "ar": "الحاجة التانية"}
        assert c.post("/api/v1/whats-new/seen", json={"id": "no-such-release"}).status_code == 422
        closed = c.post("/api/v1/whats-new/seen", json={"id": first["latest"]}).json()
        assert closed["unseen"] == 0 and not any(r["new"] for r in closed["releases"])
        assert c.get("/api/v1/whats-new").json()["unseen"] == 0                  # and it stays seen

        # an update arrives: only what is above what they saw is new
        later = NOTES.replace("## 0.2.0", "## 0.3.0 · 2026-03-03 · Third thing\nFor: everyone\nعربي: الحاجة التالتة\n\n- It is new.\n"
                              "  عربي: حاجة جديدة فعلًا.\n\n## 0.2.0", 1)
        monkeypatch.setattr(whats_new, "releases", lambda: tuple(whats_new.parse(later)))
        after = c.get("/api/v1/whats-new").json()
        assert (after["version"], after["unseen"]) == ("0.3.0", 1) and [r["new"] for r in after["releases"]] == [True, False, False]
    with client(tmp_path / "friend", FakeBroker(), broker_account_uids="") as c:   # someone who is not the account's owner
        theirs = c.get("/api/v1/whats-new").json()
        assert [r["id"] for r in theirs["releases"]] == ["0.3.0-third-thing", "0.1.0-first-thing"]   # nothing they cannot use
        assert theirs["unseen"] == 2
        c.post("/api/v1/whats-new/seen", json={"id": theirs["latest"]})
        assert c.get("/api/v1/whats-new").json()["unseen"] == 0


def test_the_assistant_reads_the_very_same_notes():
    refs = {r.name: r for r in library()}
    newest = whats_new.releases()[0]
    assert "whats-new" in refs and "whats-new" not in trading_references() and "app-guide" not in trading_references()
    headings = [heading for heading, _ in refs["whats-new"].sections]
    assert any(newest["title"]["en"] in h and newest["version"] in h for h in headings)   # every release is a section it can read
    text = "\n".join(t for _, t in refs["whats-new"].sections)
    assert all(p["en"] in text and p["ar"] in text for r in whats_new.releases() for p in r["points"])
    prompt = assistant.system_prompt() if hasattr(assistant, "system_prompt") else assistant.SYSTEM_PROMPT
    assert "`whats-new`" in prompt and "what is new" in prompt
    # it finds a release by asking in Arabic, as a user would
    tool, parsed, problem = parse("knowledge", {"query": "إيه الجديد في الإشعارات", "name": "whats-new"})
    assert problem is None
    found = tool.run(None, parsed)
    assert found["matches"] and all(m["name"] == "whats-new" for m in found["matches"])
    # and the app's own guide tells it where users see the list
    assert "What's new" in "\n".join(t for _, t in refs["app-guide"].sections)
