"""What's new: the app's release notes, shown to its users after an update and read by the assistant.

One file is the source of both: `knowledge/whats-new.md`. It sits in the assistant's reference library,
so the assistant reads it like any other reference; this module reads the same file for the screen.
A change that a user can notice is written there once, and reaches the person and the assistant together.

How a release is written (newest first):

    ## 0.3.0 · 2026-11-16 · The title, in English
    For: everyone            (or: owner, for what only the brokerage account's owner can use)
    Open: /settings?tab=real (optional: the page where it is)
    عربي: العنوان بالعربي

    - One thing that changed, in English.
      عربي: نفس النقطة بالعربي.

Every release has both languages; a test reads the whole file and fails on anything that does not fit, and
on a version at the top that is not the app's own version (package.json).

Who has seen what is kept per person (`settings/whats_new`): the release that was at the top when they
last closed the list. Everything above it is new to them.
"""
from __future__ import annotations

import re
from datetime import date
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from .services import App
from .store.errors import ConflictError

SOURCE = Path(__file__).resolve().parent / "knowledge" / "whats-new.md"
SEEN = ("settings", "whats_new")
HEADING = re.compile(r"^## (\d+\.\d+\.\d+) · (\d{4}-\d{2}-\d{2}) · (.+)$")
ARABIC = "عربي:"
SHOWN = 12        # the most releases listed at once
FIRST_TIME = 3    # what someone who has never closed the list is shown as new


class ReleaseNotesError(ValueError):
    """The release notes do not follow their own form. Raised when they are read, so a test catches it."""


class SeenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=3, max_length=80)


def parse(text: str) -> list[dict]:
    """The releases in the file, in its order. Anything that does not fit the form is an error, with the line."""
    releases: list[dict] = []
    current: dict | None = None
    point: dict | None = None

    def fail(n: int, why: str):
        raise ReleaseNotesError(f"whats-new.md, line {n}: {why}")
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if raw.startswith("## "):
            match = HEADING.match(raw.rstrip())
            if not match:
                fail(n, "a release is headed '## 0.0.0 · YYYY-MM-DD · Title'")
            try:
                date.fromisoformat(match[2])
            except ValueError:
                fail(n, f"{match[2]} is not a date")
            slug = re.sub(r"[^a-z0-9]+", "-", match[3].lower()).strip("-")[:40]
            current = {"id": f"{match[1]}-{slug}", "version": match[1], "date": match[2], "title": {"en": match[3].strip(), "ar": ""},
                       "for": None, "where": None, "points": []}
            point = None
            releases.append(current)
        elif current is None or not line:
            continue   # the file's own title and description, and blank lines
        elif line.startswith("For:"):
            current["for"] = line[4:].strip().lower()
            if current["for"] not in ("everyone", "owner"):
                fail(n, "'For:' is everyone or owner")
        elif line.startswith("Open:"):
            current["where"] = line[5:].strip()
            if not re.fullmatch(r"/[a-z]*(\?[a-z=&]+)?", current["where"]):
                fail(n, "'Open:' is a page of the app, such as /account")
        elif line.startswith(ARABIC):
            words = line[len(ARABIC):].strip()
            if not words:
                fail(n, "the Arabic is missing")
            if point is not None:
                if point["ar"]:
                    fail(n, "this point already has its Arabic")
                point["ar"] = words
            elif current["title"]["ar"]:
                fail(n, "this release already has its Arabic title")
            else:
                current["title"]["ar"] = words
        elif line.startswith("- "):
            point = {"en": line[2:].strip(), "ar": ""}
            current["points"].append(point)
        else:
            fail(n, "not a line the release notes know")
    for r in releases:
        if r["for"] is None or not r["title"]["ar"] or not r["points"] or any(not p["ar"] or not p["en"] for p in r["points"]):
            raise ReleaseNotesError(f"whats-new.md, release '{r['title']['en']}': it needs 'For:', an Arabic title, and both "
                                    "languages for every point")
    if len({r["id"] for r in releases}) != len(releases):
        raise ReleaseNotesError("whats-new.md: two releases have the same version and title")
    if [(r["date"], _number(r["version"])) for r in releases] != sorted(((r["date"], _number(r["version"])) for r in releases), reverse=True):
        raise ReleaseNotesError("whats-new.md: releases are written newest first")
    return releases


def _number(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


@lru_cache(maxsize=1)
def releases() -> tuple[dict, ...]:
    return tuple(parse(SOURCE.read_text(encoding="utf-8")))


def version() -> str:
    """The app's version: that of the newest release."""
    return releases()[0]["version"] if releases() else "0.0.0"


def view(core: App) -> dict:
    """The releases this person can use, newest first, with the ones they have not seen marked."""
    everything = releases()
    mine = [r for r in everything if r["for"] == "everyone" or core.real_account_allowed]
    seen = (core.store.get(*SEEN) or {}).get("id")
    order = [r["id"] for r in everything]
    if seen in order:
        fresh = set(order[:order.index(seen)])
    else:   # never closed the list, or the release they last saw is no longer in it: the latest few are new to them
        fresh = {r["id"] for r in mine[:FIRST_TIME]}
    shown = [{"id": r["id"], "version": r["version"], "date": r["date"], "title": r["title"], "points": r["points"],
              "where": r["where"], "new": r["id"] in fresh} for r in mine[:SHOWN]]
    return {"version": version(), "latest": order[0] if order else None, "unseen": sum(1 for r in shown if r["new"]), "releases": shown}


def mark_seen(core: App, body: SeenIn) -> dict:
    """This person closed the list: what was at the top then is what they have seen."""
    if body.id not in {r["id"] for r in releases()}:
        raise ReleaseNotesError("no such release")
    try:
        core.store.put(*SEEN, {"id": body.id})
    except ConflictError:
        pass   # another window of theirs closed it at the same moment
    return view(core)
