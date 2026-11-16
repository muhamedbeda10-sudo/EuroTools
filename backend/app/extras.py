"""Research library, investment journal and alerts: each account's own notes and watches."""
from __future__ import annotations

import re
import uuid
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .domain import indicators as ind


class ResearchIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="", max_length=120)
    published: date | None = None
    symbols: list[str] = Field(default_factory=list, max_length=50)
    sectors: list[str] = Field(default_factory=list, max_length=20)
    strategy_ids: list[str] = Field(default_factory=list, max_length=20)
    category: Literal["news", "disclosure", "announcement", "financials", "broker_report", "presentation",
                      "economic", "other"] = "news"
    summary: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=4000)
    sentiment: Literal["positive", "negative", "neutral"] = "neutral"
    importance: int = Field(default=2, ge=1, le=3)
    reliability: Literal["official", "reputable", "unverified"] = "unverified"
    verified: bool = False

    @field_validator("url")
    @classmethod
    def web_link_only(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        if not v:
            return None
        if not v.lower().startswith(("http://", "https://")) or any(c in v for c in ' "<>\n\r\t'):
            raise ValueError("the link must be a web address starting with http:// or https://")
        return v

    @field_validator("symbols")
    @classmethod
    def upper(cls, v: list[str]) -> list[str]:
        return sorted({s.strip().upper() for s in v if s.strip()})


class JournalIn(BaseModel):
    symbol: str | None = Field(default=None, max_length=12)
    strategy_id: str | None = Field(default=None, max_length=40)
    trade_seq: int | None = Field(default=None, ge=1)
    entry_date: date | None = None
    thesis: str = Field(min_length=1, max_length=4000)          # why was this stock selected?
    expected: str = Field(default="", max_length=2000)          # the expected price movement
    evidence: str = Field(default="", max_length=4000)          # what supported the decision
    exit_condition: str = Field(default="", max_length=2000)
    outcome: str = Field(default="", max_length=4000)           # what actually happened
    lesson: str = Field(default="", max_length=4000)            # what did we learn
    status: Literal["open", "closed"] = "open"

    @field_validator("symbol")
    @classmethod
    def upper(cls, v: str | None) -> str | None:
        return v.strip().upper() or None if v else None


ALERT_KINDS = {
    "price_above": "Price rises to or above",
    "price_below": "Price falls to or below",
    "change_pct_above": "Day change is at or above (%)",
    "change_pct_below": "Day change is at or below (%)",
    "volume_ratio_above": "Volume is at least this many times the average of the 20 sessions before",
    "rsi_above": "RSI (14) is at or above",
    "rsi_below": "RSI (14) is at or below",
    "strategy_signal": "A saved strategy gives a signal",
    "time_at": "The time is (Cairo)",
}
AT = re.compile(r"^(?:(\d{4}-\d{2}-\d{2})[T ])?(\d{1,2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})?$")
AT_DAYS_AHEAD = 30
TIME_LATE_MINUTES = 30   # a time seen later than this was missed: the person is told so, and nobody is woken for it


def alert_words(alert: dict) -> str:
    """An alert's condition in a few words, for a list the assistant reads."""
    kind, symbol = alert["kind"], alert.get("symbol")
    if kind == "time_at":
        return f"at {str(alert.get('at'))[:16].replace('T', ' ')} Cairo time" + (f" (about {symbol})" if symbol else "")
    if kind == "strategy_signal":
        return f"a signal from saved strategy {alert.get('strategy_id')}" + (f" on {symbol}" if symbol else "")
    return f"{symbol}: {ALERT_KINDS.get(kind, kind).lower()} {float(alert['value']):g}"


class AlertError(ValueError):
    """An alert that cannot be saved as asked, in words for the person (or the assistant) who asked."""


class AlertIn(BaseModel):
    kind: Literal["price_above", "price_below", "change_pct_above", "change_pct_below", "volume_ratio_above",
                  "rsi_above", "rsi_below", "strategy_signal", "time_at"]
    symbol: str | None = Field(default=None, max_length=12)
    value: float | None = Field(default=None, ge=-100, le=10_000_000)
    strategy_id: str | None = Field(default=None, max_length=40)
    at: str | None = Field(default=None, max_length=32, description="For time_at: HH:MM Cairo time, or YYYY-MM-DD HH:MM")
    note: str = Field(default="", max_length=300)
    active: bool = True
    # Also wake the assistant when it fires (see wakes.py). Such an alert fires once and is then switched off.
    wake: bool = False

    @model_validator(mode="after")
    def complete(self) -> AlertIn:
        self.symbol = self.symbol.strip().upper() or None if self.symbol else None
        if self.kind != "time_at":
            self.at = None
        if self.kind == "time_at":
            if not self.at or not AT.match(self.at.strip()):
                raise ValueError("give the time as HH:MM (Cairo), or as YYYY-MM-DD HH:MM")
            self.value = self.strategy_id = None
        elif self.kind == "strategy_signal":
            if not self.strategy_id:
                raise ValueError("choose the strategy to watch")
            self.value = None
        else:
            if not self.symbol:
                raise ValueError("choose the stock to watch")
            if self.value is None:
                raise ValueError("enter the level that triggers the alert")
            if self.kind.startswith(("price", "volume", "rsi")) and self.value <= 0:
                raise ValueError("the level must be greater than zero")
            self.strategy_id = None
        return self


def _days_old(doc: dict) -> float:
    """Days since the document was last saved; 0 when that cannot be told."""
    try:
        return (datetime.now(UTC) - datetime.fromisoformat(doc["updated_at"])).total_seconds() / 86400
    except (KeyError, TypeError, ValueError):
        return 0.0


class Extras:
    """CRUD over the account's own collections, plus alert evaluation. `core` is services.App."""

    def __init__(self, core):
        self.core = core
        self.store = core.store

    # ---- shared helpers --------------------------------------------------
    def _check_symbols(self, symbols: list[str]) -> None:
        from .services import NotFound
        unknown = [s for s in symbols if self.core.market.instrument(s) is None]
        if unknown:
            raise NotFound(f"unknown symbol(s): {', '.join(unknown)}")

    def _save(self, coll: str, entity: str, body: dict, id: str | None) -> dict:
        from .services import retry_conflict
        return retry_conflict(self._save_once)(coll, entity, body, id)

    def _save_once(self, coll: str, entity: str, body: dict, id: str | None) -> dict:
        from .services import NotFound, now_iso
        with self.store.transaction():
            before = self.store.get(coll, id) if id else None
            if id and before is None:
                raise NotFound(f"{entity} not found")
            doc = {**(before or {}), **body, "id": id or uuid.uuid4().hex[:12],
                   "created_at": before["created_at"] if before else now_iso(), "updated_at": now_iso()}
            self.store.put(coll, doc["id"], doc)
            self.core.audit("update" if before else "create", entity,
                            {"id": doc["id"], "name": doc.get("title") or doc.get("symbol") or doc.get("kind")})
            return doc

    def _delete(self, coll: str, entity: str, id: str) -> None:
        from .services import NotFound
        with self.store.transaction():
            if not self.store.delete(coll, id):
                raise NotFound(f"{entity} not found")
            self.core.audit("delete", entity, {"id": id})

    # ---- research --------------------------------------------------------
    def save_research(self, body: ResearchIn, id: str | None = None) -> dict:
        self._check_symbols(body.symbols)
        return self._save("research", "research", body.model_dump(mode="json"), id)

    def research(self, *, symbol: str | None = None, sector: str | None = None, category: str | None = None,
                 strategy_id: str | None = None, q: str | None = None) -> list[dict]:
        items = self.store.list("research")
        if symbol:
            symbol = symbol.upper()
            ins = self.core.market.instrument(symbol)
            own_sector = ins["sector"] if ins else None
            items = [i for i in items if symbol in i["symbols"] or (own_sector and own_sector in i["sectors"])]
        if sector:
            items = [i for i in items if sector in i["sectors"]]
        if category:
            items = [i for i in items if i["category"] == category]
        if strategy_id:
            items = [i for i in items if strategy_id in i["strategy_ids"]]
        if q:
            ql = q.lower()
            items = [i for i in items if ql in f"{i['title']} {i['summary']} {i['notes']} {i['source']}".lower()]
        return sorted(items, key=lambda i: (i.get("published") or i["created_at"][:10], i["created_at"]), reverse=True)

    def delete_research(self, id: str) -> None:
        self._delete("research", "research", id)

    # ---- journal ---------------------------------------------------------
    def save_journal(self, body: JournalIn, id: str | None = None) -> dict:
        if body.symbol:
            self._check_symbols([body.symbol])
        return self._save("journal", "journal_entry", body.model_dump(mode="json"), id)

    def journal(self, *, symbol: str | None = None, status: str | None = None) -> list[dict]:
        items = self.store.list("journal")
        if symbol:
            items = [i for i in items if i.get("symbol") == symbol.upper()]
        if status:
            items = [i for i in items if i["status"] == status]
        return sorted(items, key=lambda i: (i.get("entry_date") or i["created_at"][:10], i["created_at"]), reverse=True)

    def delete_journal(self, id: str) -> None:
        self._delete("journal", "journal_entry", id)

    # ---- alerts ----------------------------------------------------------
    def save_alert(self, body: AlertIn, id: str | None = None, by: str | None = None) -> dict:
        from .services import NotFound
        if body.symbol:
            self._check_symbols([body.symbol])
        if body.strategy_id and self.store.get("strategies", body.strategy_id) is None:
            raise NotFound("strategy not found")
        doc = body.model_dump(mode="json")
        doc["last_triggered_on"] = None  # a new or edited alert is armed again straight away
        doc["lapsed"] = doc["missed"] = False
        before = self.store.get("alerts", id) if id else None
        if body.kind == "time_at":
            if not body.active and before and before.get("kind") == "time_at" and before.get("at"):
                doc["at"] = before["at"]   # switching one off never needs its time to be still ahead
            else:
                doc["at"] = self._when(body.at).isoformat(timespec="minutes")
        doc["by"] = by or (before or {}).get("by") or "user"   # who asked for it: the person, or the assistant for itself
        return self._save("alerts", "alert", doc, id)

    def holds_now(self, body: AlertIn) -> str | None:
        """The sentence for a condition that is already true as things stand, else None. A watch on such a
        condition would fire at once, so the assistant is told instead of being woken by its own watch."""
        if body.kind == "time_at":
            return None
        table = self.core.quotes()
        quotes = {} if table.empty else {r["symbol"]: r for r in table.to_dict("records")}
        signals = self.core.active_signals() if body.kind == "strategy_signal" else []
        hit, _, text = self._observe(body.model_dump(mode="json"), quotes, signals)
        return text if hit else None

    def _when(self, text: str) -> datetime:
        """A time the person or the assistant wrote, as a moment in Cairo: today if it is still ahead on a
        trading day, otherwise the next trading day; or the day they named."""
        from .data.calendar import CAIRO, cairo_now, is_trading_day
        day, hour, minute, offset = AT.match(text.strip()).groups()
        if int(hour) > 23 or int(minute) > 59:
            raise AlertError("That is not a time of day.")
        now = cairo_now()
        if day:
            try:
                on = date.fromisoformat(day)
            except ValueError:
                raise AlertError("That is not a date.") from None
            # Cairo time unless a zone was written with it: then that moment, told in Cairo time
            zone = CAIRO if offset is None else UTC if offset == "Z" else timezone(
                (1 if offset[0] == "+" else -1) * timedelta(hours=int(offset[1:3]), minutes=int(offset[4:6])))
            at = datetime(on.year, on.month, on.day, int(hour), int(minute), tzinfo=zone).astimezone(CAIRO)
        elif offset:
            raise AlertError("Give the time of day in Cairo time, as HH:MM, or write the date with it.")
        else:
            at = now.replace(hour=int(hour), minute=int(minute), second=0, microsecond=0)
            while at <= now or not is_trading_day(at.date()):
                at += timedelta(days=1)
        if at <= now:
            raise AlertError("That time has already passed.")
        if at - now > timedelta(days=AT_DAYS_AHEAD):
            raise AlertError(f"That is more than {AT_DAYS_AHEAD} days ahead.")
        return at

    def delete_alert(self, id: str) -> None:
        self._delete("alerts", "alert", id)

    def alerts(self) -> dict:
        return {"alerts": sorted(self.store.list("alerts"), key=lambda a: a["created_at"], reverse=True),
                "events": self.store.recent("alert_events", 50), "kinds": ALERT_KINDS}

    def _observe(self, alert: dict, quotes: dict[str, dict], signals: list[dict]) -> tuple[bool, float | None, str]:
        """Is the alert's condition true right now? Returns (hit, observed value, sentence)."""
        kind, value, symbol = alert["kind"], alert["value"], alert["symbol"]
        if kind == "time_at":
            from .data.calendar import cairo_now
            at, now = datetime.fromisoformat(alert["at"]), cairo_now()
            if now < at:
                return False, None, ""
            about, late = f" (about {symbol})" if symbol else "", round((now - at).total_seconds() / 60, 1)
            if late > TIME_LATE_MINUTES:   # nothing was looking then: said as it is, with both moments
                return True, late, (f"The moment set for {at:%Y-%m-%d %H:%M} Cairo time{about} passed while the app was not "
                                    f"looking: it is now {now:%Y-%m-%d %H:%M}")
            return True, late, f"It is {now:%Y-%m-%d %H:%M} Cairo time: the moment set for {at:%Y-%m-%d %H:%M} has come{about}"
        if kind == "strategy_signal":
            hits = [s for s in signals if s["strategy_id"] == alert["strategy_id"] and (not symbol or s["symbol"] == symbol)]
            if not hits:
                return False, None, ""
            names = ", ".join(f"{h['symbol']} ({h['signal']})" for h in hits[:6])
            return True, float(len(hits)), f"{hits[0]['strategy']}: {names}" + (" and more" if len(hits) > 6 else "")
        q = quotes.get(symbol)
        if q is None:
            return False, None, ""
        if kind in ("price_above", "price_below"):
            seen = q["last"]
            hit = seen >= value if kind == "price_above" else seen <= value
            return hit, seen, f"{symbol} is at {seen:g}, {'at or above' if kind == 'price_above' else 'at or below'} {value:g}"
        if kind in ("change_pct_above", "change_pct_below", "volume_ratio_above") and not q.get("current"):
            return False, None, ""  # it did not trade in the latest session: an old bar is not "today"
        if kind in ("change_pct_above", "change_pct_below"):
            seen = q.get("change_pct")
            if seen is None or seen != seen:
                return False, None, ""
            hit = seen >= value if kind == "change_pct_above" else seen <= value
            return hit, seen, f"{symbol} is {seen:+.2f}% today (level {value:+g}%)"
        if kind == "volume_ratio_above":
            avg = q.get("avg_volume_20")
            seen = q["volume"] / avg if avg and avg == avg else None
            return ((seen is not None and seen >= value), seen,
                    f"{symbol} volume is {seen or 0:.1f}x the average of the 20 sessions before (level {value:g}x)")
        df = self.core.market.bars(symbol)
        if df is None or len(df) < 20:
            return False, None, ""
        seen = float(ind.rsi(df["close"]).iloc[-1])
        if seen != seen:  # NaN: not enough history
            return False, None, ""
        hit = seen >= value if kind == "rsi_above" else seen <= value
        return hit, seen, f"{symbol} RSI is {seen:.0f} ({'at or above' if kind == 'rsi_above' else 'at or below'} {value:g})"

    def check_alerts(self, only_wake: bool = False) -> dict:
        """Evaluate every active alert. An alert fires at most once per trading session.

        "Once" is counted by the session the observed price belongs to, not by the
        calendar: Thursday's move does not fire again on Friday, Saturday and Sunday morning.

        `only_wake` leaves the alerts that only tell the person alone, for a look that has nobody to tell:
        an alert is used up when it fires, so it must fire where someone hears it.
        """
        from . import wakes
        from .services import now_iso
        alerts = [a for a in self.store.list("alerts") if a["active"] and (a.get("wake") or not only_wake)]
        if not alerts:
            return {"triggered": [], "active": 0, "wake": False}
        listening = wakes.listening(self.core)   # with the autopilot off nothing is kept for it: the person is told, as ever
        quotes: dict[str, dict] = {}
        if any(a["kind"] not in ("time_at", "strategy_signal") for a in alerts):   # a time needs no prices
            table = self.core.quotes()
            quotes = {} if table.empty else {r["symbol"]: r for r in table.to_dict("records")}
        signals = self.core.active_signals() if any(a["kind"] == "strategy_signal" for a in alerts) else []
        settled = self.core.market.latest_settled()
        fired, woke = [], []
        with self.store.transaction():
            for alert in alerts:
                if alert.get("wake") and alert["kind"] != "time_at" and _days_old(alert) > wakes.WATCH_DAYS:
                    # A watch nobody renewed: what it was waiting for is stale by now, so it stops instead of waking anyone.
                    self.store.put("alerts", alert["id"], {**alert, "active": False, "lapsed": True})
                    continue
                if alert["kind"] == "time_at":
                    session = alert["at"]
                elif alert["kind"] == "strategy_signal":
                    session = settled.strftime("%Y-%m-%d") if settled is not None else None
                else:
                    session = (quotes.get(alert["symbol"]) or {}).get("as_of")
                if session is None or alert.get("last_triggered_on") == session:
                    continue
                hit, seen, text = self._observe(alert, quotes, signals)
                if not hit:
                    continue
                alert["last_triggered_on"] = session
                missed = alert["kind"] == "time_at" and seen is not None and seen > TIME_LATE_MINUTES
                if alert.get("wake") or alert["kind"] == "time_at":
                    alert["active"] = False   # these fire once: a new one is set when it is wanted again
                    alert["missed"] = missed
                self.store.put("alerts", alert["id"], alert)
                wakes_it = bool(alert.get("wake")) and listening and not missed
                event = self.store.append("alert_events", {
                    "ts": now_iso(), "alert_id": alert["id"], "kind": alert["kind"], "symbol": alert["symbol"],
                    "level": alert["value"], "observed": seen, "message": text, "note": alert.get("note", ""),
                    "by": alert.get("by") or "user", "wake": wakes_it})
                fired.append(event)
                if wakes_it:
                    woke.append({k: event.get(k) for k in ("ts", "alert_id", "kind", "symbol", "level", "observed", "message", "note")})
            wakes.add(self.core, woke)   # with the alerts themselves: an event is never queued twice, nor lost
        return {"triggered": fired, "active": len(alerts), "wake": bool(woke)}
