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

from .data.calendar import CAIRO, cairo_now
from .domain.ledger import LedgerError, replay
from .llm import DEFAULT_MODEL, EFFORTS, PRICES, SUPPORTED_MODELS
from .services import App

ACCESS_LEVELS = ("full", "confirm", "read")
AUTOPILOT_MODES = ("off", "after_close", "intraday")
DEFAULT_LIMITS = {"max_position_pct": 25.0, "max_trade_pct": 20.0, "max_trades_per_day": 10, "min_cash_pct": 5.0}
DEFAULT_AUTOPILOT = {"mode": "off", "every_minutes": 30, "mandate": "", "last_run": None, "last_session": None, "last_chat": None}
MODEL_NOTES = {
    "claude-opus-5-5": ("Claude Opus 5.5", "The default: strong analysis at a moderate price."),
    "claude-sonnet-5-5": ("Claude Sonnet 5.5", "Faster and half the price; good for everyday questions and routine actions."),
    "claude-haiku-5-5": ("Claude Haiku 5.5", "Fastest and far cheaper; fine for simple lookups, weaker on judgement."),
    "claude-fable-5-2": ("Claude Fable 5.2", "The most capable model, at twice the price of Opus; for the hardest analysis."),
}


class PrefsIn(BaseModel):
    """A change to the settings: only the fields that are given are changed."""
    model_config = ConfigDict(extra="forbid")

    access: Literal["full", "confirm", "read"] | None = None
    model: str | None = Field(default=None, max_length=60)
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    daily_usd: float | None = Field(default=None, ge=0, le=200)
    max_position_pct: float | None = Field(default=None, ge=1, le=100)
    max_trade_pct: float | None = Field(default=None, ge=1, le=100)
    max_trades_per_day: int | None = Field(default=None, ge=0, le=200)
    min_cash_pct: float | None = Field(default=None, ge=0, le=90)
    autopilot_mode: Literal["off", "after_close", "intraday"] | None = None
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
    daily = doc.get("daily_usd")
    return {
        "access": doc.get("access") if doc.get("access") in ACCESS_LEVELS else "full",
        "model": model, "effort": effort,
        "daily_usd": float(daily) if daily is not None else float(cfg.assistant_daily_usd),
        "limits": {**DEFAULT_LIMITS, **{k: v for k, v in (doc.get("limits") or {}).items() if k in DEFAULT_LIMITS}},
        "autopilot": {**DEFAULT_AUTOPILOT, **{k: v for k, v in (doc.get("autopilot") or {}).items() if k in DEFAULT_AUTOPILOT}},
    }


def save_prefs(core: App, change: PrefsIn) -> dict:
    with core.store.transaction():
        current = prefs(core)
        given = change.model_dump(exclude_none=True)
        for key in ("access", "model", "effort", "daily_usd"):
            if key in given:
                current[key] = given[key]
        for key in DEFAULT_LIMITS:
            if key in given:
                current["limits"][key] = given[key]
        for key, field in (("mode", "autopilot_mode"), ("every_minutes", "autopilot_every_minutes"), ("mandate", "autopilot_mandate")):
            if field in given:
                current["autopilot"][key] = given[field].strip() if key == "mandate" else given[field]
        core.store.put("settings", "assistant", current)
        core.audit("update", "assistant_settings", {k: v for k, v in given.items() if k != "autopilot_mandate"})
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
