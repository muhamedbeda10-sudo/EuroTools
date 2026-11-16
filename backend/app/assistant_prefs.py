"""The assistant's settings for one account, and the limits its own trades must stay inside.

Everything here is chosen by the user in Settings -> Assistant and stored in their own data.
The limits are enforced in code on every trade the assistant places, whatever it was asked
and whatever it decided: they are the difference between "the assistant may trade" and
"the assistant may do anything to the portfolio".
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import broker
from .data.calendar import CAIRO, cairo_now
from .domain.ledger import LedgerError, replay
from .llm import DEFAULT_MODEL, EFFORTS, PRICES, SUPPORTED_MODELS
from .services import App

ACCESS_LEVELS = ("full", "confirm", "read")
AUTOPILOT_MODES = ("off", "after_close", "events", "intraday")
# The account the autopilot's reviews are for. "both" is how it worked before the choice existed: it manages the
# paper portfolio, and writes proposals for the real account only when the owner's mandate asks for them.
AUTOPILOT_ACCOUNTS = ("paper", "real", "both")
DEFAULT_LIMITS = {"max_position_pct": 25.0, "max_trade_pct": 20.0, "max_trades_per_day": 10, "min_cash_pct": 5.0}
DEFAULT_AUTOPILOT = {"mode": "off", "account": "both", "every_minutes": 30, "mandate": "", "last_run": None, "last_session": None,
                     "last_chat": None,
                     # the most reviews in one day, whether to tell the owner's devices after one that changed something,
                     # and how many ran on which day
                     "max_per_day": 12, "notify": True, "day": None, "count": 0}
LANGUAGES = ("auto", "ar", "en")
DEFAULT_REAL_PROPOSALS = 20   # proposals for real orders the assistant may write in a day
MODEL_NOTES = {
    "claude-opus-5-5": ("Claude Opus 5.5", "The default: strong analysis at a moderate price."),
    "claude-sonnet-5-5": ("Claude Sonnet 5.5", "Faster and half the price; good for everyday questions and routine actions."),
    "claude-haiku-5-5": ("Claude Haiku 5.5", "Fastest and far cheaper; fine for simple lookups, weaker on judgement."),
    "claude-fable-5-2": ("Claude Fable 5.2", "The most capable model, at twice the price of Opus; for the hardest analysis."),
}


class PrefsError(ValueError):
    """The settings as asked do not fit together. Shown to the person."""


class PrefsIn(BaseModel):
    """A change to the settings: only the fields that are given are changed."""
    model_config = ConfigDict(extra="forbid")

    access: Literal["full", "confirm", "read"] | None = None
    model: str | None = Field(default=None, max_length=60)
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    daily_usd: float | None = Field(default=None, ge=0, le=200)
    monthly_usd: float | None = Field(default=None, ge=0, le=3000)
    language: Literal["auto", "ar", "en"] | None = None
    instructions: str | None = Field(default=None, max_length=2000)
    real_proposals_per_day: int | None = Field(default=None, ge=0, le=50)
    autopilot_max_per_day: int | None = Field(default=None, ge=1, le=48)
    autopilot_notify: bool | None = None
    max_position_pct: float | None = Field(default=None, ge=1, le=100)
    max_trade_pct: float | None = Field(default=None, ge=1, le=100)
    max_trades_per_day: int | None = Field(default=None, ge=0, le=200)
    min_cash_pct: float | None = Field(default=None, ge=0, le=90)
    autopilot_mode: Literal["off", "after_close", "events", "intraday"] | None = None
    autopilot_account: Literal["paper", "real", "both"] | None = None
    autopilot_every_minutes: int | None = Field(default=None, ge=15, le=240)
    autopilot_mandate: str | None = Field(default=None, max_length=4000)

    @field_validator("model")
    @classmethod
    def known_model(cls, v: str | None) -> str | None:
        if v is not None and v not in SUPPORTED_MODELS:
            raise ValueError(f"choose one of: {', '.join(SUPPORTED_MODELS)}")
        return v


def prefs(core: App) -> dict:
    """The stored settings with every default filled in."""
    doc = core.store.get("settings", "assistant") or {}
    cfg = core.settings
    model = doc.get("model") if doc.get("model") in SUPPORTED_MODELS else (
        cfg.assistant_model if cfg.assistant_model in SUPPORTED_MODELS else DEFAULT_MODEL)
    effort = doc.get("effort") if doc.get("effort") in EFFORTS else (cfg.assistant_effort if cfg.assistant_effort in EFFORTS else "medium")
    daily, monthly, proposals = doc.get("daily_usd"), doc.get("monthly_usd"), doc.get("real_proposals_per_day")
    autopilot = {**DEFAULT_AUTOPILOT, **{k: v for k, v in (doc.get("autopilot") or {}).items() if k in DEFAULT_AUTOPILOT}}
    if autopilot["account"] not in AUTOPILOT_ACCOUNTS:
        autopilot["account"] = DEFAULT_AUTOPILOT["account"]
    return {
        "access": doc.get("access") if doc.get("access") in ACCESS_LEVELS else "full",
        "model": model, "effort": effort,
        "daily_usd": float(daily) if daily is not None else float(cfg.assistant_daily_usd),
        "monthly_usd": float(monthly) if monthly is not None else float(cfg.assistant_monthly_usd),
        "language": doc.get("language") if doc.get("language") in LANGUAGES else "auto",
        "instructions": str(doc.get("instructions") or "")[:2000],
        "real_proposals_per_day": int(proposals) if isinstance(proposals, int) and 0 <= proposals <= 50 else DEFAULT_REAL_PROPOSALS,
        "limits": {**DEFAULT_LIMITS, **{k: v for k, v in (doc.get("limits") or {}).items() if k in DEFAULT_LIMITS}},
        "autopilot": autopilot,
    }


def autopilot_account(core: App, auto: dict | None = None) -> str:
    """The account the autopilot's reviews are for: "paper", "real" or "both" (AUTOPILOT_ACCOUNTS).

    The real account exists for its owner alone, so for anyone else "both" is simply the paper portfolio.
    "real" is left as it was chosen even when the account cannot be reached: such a review is held back
    (`autopilot_blocked`) rather than turned loose on the paper portfolio its owner told it to leave alone.
    """
    chosen = (auto or prefs(core)["autopilot"])["account"]
    return "paper" if chosen == "both" and not broker.access(core)["allowed"] else chosen


def autopilot_blocked(core: App, auto: dict | None = None) -> str | None:
    """Why no review can run at all for the account that was chosen, in words for the person; None when one can."""
    if autopilot_account(core, auto) == "real" and not broker.access(core)["allowed"]:
        return ("The autopilot is set to work on the real account, which is not connected or not enabled for this sign-in, "
                "so no review runs. Choose the paper portfolio in Settings → Assistant, or connect the account again.")
    return None


def save_prefs(core: App, change: PrefsIn) -> dict:
    with core.store.transaction():
        current = prefs(core)
        given = change.model_dump(exclude_none=True)
        for key in ("access", "model", "effort", "daily_usd", "monthly_usd", "language", "real_proposals_per_day"):
            if key in given:
                current[key] = given[key]
        if "instructions" in given:
            current["instructions"] = given["instructions"].strip()
        if current["monthly_usd"] and current["daily_usd"] > current["monthly_usd"]:
            raise PrefsError("The daily ceiling cannot be larger than the monthly one.")
        for key in DEFAULT_LIMITS:
            if key in given:
                current["limits"][key] = given[key]
        # The real account is its owner's alone. Only a change towards it is checked, so a page that sends back what was
        # already saved still saves, and the way back to the paper portfolio is never closed.
        to_real = given.get("autopilot_account") == "real" and current["autopilot"]["account"] != "real"
        if to_real and not broker.access(core)["allowed"]:
            raise PrefsError("Only the brokerage account's owner can set the autopilot to work on the real account.")
        for key, field in (("mode", "autopilot_mode"), ("account", "autopilot_account"), ("every_minutes", "autopilot_every_minutes"),
                           ("mandate", "autopilot_mandate"), ("max_per_day", "autopilot_max_per_day"), ("notify", "autopilot_notify")):
            if field in given:
                current["autopilot"][key] = given[field].strip() if key == "mandate" else given[field]
        core.store.put("settings", "assistant", current)
        core.audit("update", "assistant_settings", {k: v for k, v in given.items() if k not in ("autopilot_mandate", "instructions")})
    return current


def note_autopilot(core: App, **fields) -> dict:
    """Record that the autopilot ran (when, for which session, in which conversation)."""
    current = prefs(core)
    current["autopilot"].update(fields)
    core.store.put("settings", "assistant", current)
    return current


def models() -> list[dict]:
    return [{"id": m, "name": MODEL_NOTES[m][0], "about": MODEL_NOTES[m][1], "input_usd_per_mtok": PRICES[m][0],
             "output_usd_per_mtok": PRICES[m][1]} for m in SUPPORTED_MODELS]


def trades_today(txs: list[dict]) -> int:
    """How many trades the assistant has placed today (Cairo time)."""
    today = cairo_now().date()
    count = 0
    for tx in txs:
        if tx.get("origin") == "assistant" and tx.get("ts"):
            try:
                if datetime.fromisoformat(tx["ts"]).astimezone(CAIRO).date() == today:
                    count += 1
            except ValueError:
                continue
    return count


def check_trade(core: App, side: str, symbol: str, qty: int) -> None:
    """Refuse a trade of the assistant's that would break the user's limits. Raises LedgerError with the reason."""
    limits = prefs(core)["limits"]
    txs = core.store.list(core._ledger_coll())
    if trades_today(txs) >= limits["max_trades_per_day"]:
        raise LedgerError(f"The assistant has reached its limit of {limits['max_trades_per_day']} trades for today "
                          "(Settings -> Assistant).")
    if side != "BUY":
        return  # selling reduces risk: only the daily count applies
    symbol = symbol.upper()
    quote = core.preview_trade("BUY", symbol, qty, None)
    cost = quote["gross"] + quote["fees_total"]
    equity = core.portfolio()["summary"]["total_value"]
    if equity <= 0:
        return
    state = replay(txs)
    held = state.positions[symbol].qty if symbol in state.positions else 0
    trade_pct = cost / equity * 100
    position_pct = (held + qty) * quote["price"] / equity * 100
    cash_pct = (float(state.cash) - cost) / equity * 100
    where = "the limit set for the assistant in Settings -> Assistant"
    if trade_pct > limits["max_trade_pct"]:
        raise LedgerError(f"This trade is {trade_pct:.1f}% of the portfolio; {where} is {limits['max_trade_pct']:g}% per trade.")
    if position_pct > limits["max_position_pct"]:
        raise LedgerError(f"This would put {position_pct:.1f}% of the portfolio in {symbol}; {where} is "
                          f"{limits['max_position_pct']:g}% per stock.")
    if cash_pct < limits["min_cash_pct"]:
        raise LedgerError(f"This would leave {max(cash_pct, 0):.1f}% of the portfolio in cash; {where} keeps at least "
                          f"{limits['min_cash_pct']:g}%.")
