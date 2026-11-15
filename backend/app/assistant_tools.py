"""What the in-app assistant can see and do.

Each tool is a thin, bounded wrapper over the same service methods the screens
use, so the assistant follows exactly the rules a person does: the same fee
schedule, the same ledger checks, the same paper-only limits. There is no tool
for real orders, because no such code exists in this application, and none for
sign-in accounts or passwords, which stay a manual, administrator-only task.

`kind` decides how a call is treated under each access level:
  read    - looks only
  write   - changes the user's own notes, lists, strategies, alerts, backtests
  confirm - moves paper money or deletes something: asks first when the user chose "ask me"
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import paper
from .data.calendar import cairo_now, market_open
from .domain.fees import FeeItem, FeeSchedule
from .domain.ledger import replay
from .domain.strategies import STRATEGY_TYPES, RiskConfig, StrategyConfig
from .extras import ALERT_KINDS, AlertIn, Extras, JournalIn, ResearchIn
from .services import App, NotFound, clean

MAX_RESULT_CHARS = 30_000
KNOWLEDGE_DIR = Path(__file__).resolve().parent / "knowledge"
KNOWLEDGE_PART = 24_000
PAGES = {
    "dashboard": "/", "market": "/market", "stock": "/stock", "watchlist": "/watchlist", "portfolio": "/portfolio",
    "trades": "/trades", "strategies": "/strategies", "simulator": "/simulator", "research": "/research",
    "journal": "/journal", "alerts": "/alerts", "guide": "/guide", "settings": "/settings",
}


class Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoArgs(Args):
    pass


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[Args]
    run: Callable[[App, Any], Any]
    kind: Literal["read", "write", "confirm"] = "read"
    label: Callable[[Any], str] = lambda a: ""


def r4(value):
    """Numbers short enough to read: four decimals at most."""
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {k: r4(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [r4(v) for v in value]
    return value


def pick(row: dict, *keys: str) -> dict:
    return {k: row.get(k) for k in keys}


QUOTE = ("symbol", "name", "sector", "last", "change_pct", "week_pct", "month_pct", "volume", "avg_volume_20",
         "turnover", "as_of", "current", "live", "source")


# ---- market ------------------------------------------------------------------------------
def _market_overview(core: App, a: NoArgs) -> dict:
    ov = core.market_overview()
    status = core.market.status()
    return {
        "as_of": ov.get("as_of"), "market_open_now": market_open(), "cairo_time": cairo_now().strftime("%Y-%m-%d %H:%M"),
        "data": pick(status, "mode", "latest_bar_date", "is_live", "live_as_of", "trading_days_behind", "is_stale"),
        "indices": [pick(i, "name", "last", "change_pct", "as_of") for i in ov.get("indices", [])],
        "breadth": ov.get("breadth"),
        "gainers": ov.get("gainers", []), "losers": ov.get("losers", []), "most_active": ov.get("most_active", []),
        "sectors": [pick(s, "sector", "stocks", "traded", "day_pct", "week_pct", "month_pct", "relative_strength")
                    for s in core.sectors()],
    }


class FindStocks(Args):
    query: str | None = Field(default=None, max_length=60, description="Part of a symbol or company name")
    sector: str | None = Field(default=None, max_length=80)
    sort_by: Literal["symbol", "change_pct", "week_pct", "month_pct", "volume", "turnover", "last"] = "symbol"
    descending: bool = False
    traded_in_latest_session_only: bool = False
    watched_only: bool = False
    limit: int = Field(default=25, ge=1, le=60)


def _find_stocks(core: App, a: FindStocks) -> dict:
    rows = core.stock_rows(a.sector, a.query)
    if a.traded_in_latest_session_only:
        rows = [r for r in rows if r.get("current")]
    if a.watched_only:
        rows = [r for r in rows if r.get("watched")]
    missing = float("-inf") if a.descending else float("inf")
    rows.sort(key=lambda r: (r.get(a.sort_by) if r.get(a.sort_by) is not None else missing) if a.sort_by != "symbol"
              else r["symbol"], reverse=a.descending)
    return {"total_matching": len(rows), "stocks": [{**pick(r, *QUOTE), "watched": r.get("watched")} for r in rows[:a.limit]]}


class StockReport(Args):
    symbol: str = Field(min_length=1, max_length=12)
    timeframe: Literal["d", "w", "m"] = Field(default="d", description="Candle size: day, week or month")
    bars: int = Field(default=30, ge=0, le=120, description="How many of the latest candles to include")


def _stock_report(core: App, a: StockReport) -> dict:
    symbol = a.symbol.upper()
    d = core.stock_detail(symbol, a.timeframe, limit=max(a.bars, 1))
    out: dict = {"instrument": d["instrument"], "has_data": d["has_data"]}
    if not d["has_data"]:
        return out
    held = replay(core.store.list(core._ledger_coll())).positions.get(symbol)
    out.update(
        quote=d["quote"], data_note=d["data_note"], watched=d["watched"],
        assessment={k: v for k, v in d["assessment"].items()},
        candles={"columns": ["date", "open", "high", "low", "close", "volume", "rsi"],
                 "rows": [[b["time"], b["open"], b["high"], b["low"], b["close"], b["volume"], b["rsi"]]
                          for b in d["bars"][-a.bars:]] if a.bars else []},
        holding=({"qty": held.qty, "avg_price": float(held.avg_price), "cost": float(held.cost)}
                 if held is not None and held.qty else None),
        signals=[s for s in core.active_signals() if s["symbol"] == symbol],
        saved_research_items=len(Extras(core).research(symbol=symbol)),
        fundamentals="not available: no verified source of financial statements is connected",
    )
    return out


class SymbolArg(Args):
    symbol: str = Field(min_length=1, max_length=12)


def _price_depth(core: App, a: SymbolArg) -> dict:
    book = core.depth(a.symbol)
    return {**{k: v for k, v in book.items() if k not in ("bids", "asks", "unread")},
            "bids": book["bids"][:10], "asks": book["asks"][:10]}


# ---- portfolio and trades ---------------------------------------------------------------
def _portfolio(core: App, a: NoArgs) -> dict:
    p = core.portfolio()
    return {"mode": "paper", "summary": p["summary"], "holdings": p["holdings"], "sector_allocation": p["sector_allocation"],
            "cash_weight_pct": p["cash_weight_pct"], "warnings": p["warnings"],
            "value_history_recent": p["history"]["curve"][-20:]}


class Trades(Args):
    symbol: str | None = Field(default=None, max_length=12)
    limit: int = Field(default=20, ge=1, le=60)


def _trades(core: App, a: Trades) -> dict:
    t = core.trades()
    rows = [r for r in t["transactions"] if not a.symbol or r.get("symbol") == a.symbol.upper()]
    keys = ("seq", "trade_date", "type", "symbol", "qty", "price", "gross", "fees_total", "cash_delta", "cash_after",
            "avg_cost", "realized_gross", "realized_net", "remaining_qty", "origin", "note", "backdated")
    return {"totals": t["totals"], "matching": len(rows), "transactions": [pick(r, *keys) for r in rows[:a.limit]]}


class TradeArgs(Args):
    side: Literal["BUY", "SELL"]
    symbol: str = Field(min_length=1, max_length=12)
    qty: int = Field(gt=0, le=100_000_000, description="Whole shares")


class PlaceTrade(TradeArgs):
    note: str = Field(default="", max_length=1000, description="Why this trade (kept with it in the ledger)")


def _preview_trade(core: App, a: TradeArgs) -> dict:
    return core.preview_trade(a.side, a.symbol, a.qty, None)


def _place_trade(core: App, a: PlaceTrade) -> dict:
    tx = core.post_trade(a.side, a.symbol, a.qty, None, a.note, None)
    cash = replay(core.store.list(core._ledger_coll())).cash
    recorded = pick(tx, "seq", "type", "symbol", "qty", "trade_date", "price_date")
    recorded.update({k: float(tx[k]) for k in ("price", "gross", "fees_total")})  # numbers, not the ledger's text form
    return {"recorded": recorded, "cash_after": float(cash), "mode": "paper"}


def _reset_portfolio(core: App, a: NoArgs) -> dict:
    return {"new_portfolio": core.reset_portfolio(), "note": "The previous ledger is kept; a fresh paper portfolio is now active."}


# ---- watchlist and lists ----------------------------------------------------------------
class SetWatch(Args):
    symbol: str = Field(min_length=1, max_length=12)
    watched: bool


def _watchlist(core: App, a: NoArgs) -> dict:
    return {"stocks": [pick(r, *QUOTE) for r in core.watchlist()],
            "custom_lists": core.store.list("categories")}


def _set_watch(core: App, a: SetWatch) -> dict:
    core.set_watch(a.symbol, a.watched)
    return {"symbol": a.symbol.upper(), "watched": a.watched}


class SaveList(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it to change an existing list")
    name: str = Field(min_length=1, max_length=60)
    symbols: list[str] = Field(max_length=300)


def _save_list(core: App, a: SaveList) -> dict:
    return core.save_category(a.name, a.symbols, a.id)


# ---- strategies, backtests, automatic runs ----------------------------------------------
def _strategies(core: App, a: NoArgs) -> dict:
    return {"strategies": core.store.list("strategies"),
            "types": {k: pick(v, "label", "description", "available", "params", "unavailable_reason")
                      for k, v in STRATEGY_TYPES.items()},
            "risk_defaults": RiskConfig().model_dump()}


class SaveStrategy(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it to change an existing strategy")
    name: str = Field(min_length=1, max_length=80)
    type: str = Field(description="One of the available strategy types")
    description: str = Field(default="", max_length=500)
    params: dict[str, float] = Field(default_factory=dict, description="Type parameters; omitted ones take their defaults")
    symbols: list[str] = Field(default_factory=list, max_length=300, description="Empty with no sectors means every stock")
    sectors: list[str] = Field(default_factory=list, max_length=50)
    stop_loss_pct: float | None = Field(default=8, description="null for no stop")
    take_profit_pct: float | None = None
    max_alloc_pct: float = 20
    max_open_positions: int = 5
    cash_reserve_pct: float = 10
    slippage_bps: float = 10


def _save_strategy(core: App, a: SaveStrategy) -> dict:
    cfg = StrategyConfig(name=a.name, type=a.type, description=a.description, params=a.params, symbols=a.symbols,
                         sectors=a.sectors, risk=RiskConfig(
                             stop_loss_pct=a.stop_loss_pct, take_profit_pct=a.take_profit_pct, max_alloc_pct=a.max_alloc_pct,
                             max_open_positions=a.max_open_positions, cash_reserve_pct=a.cash_reserve_pct,
                             slippage_bps=a.slippage_bps))
    return core.save_strategy(cfg, a.id)


class RunBacktest(Args):
    strategy_id: str = Field(min_length=1, max_length=40)
    symbols: list[str] | None = Field(default=None, max_length=300, description="Override the strategy's own stocks")
    start: date | None = None
    end: date | None = None
    capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))


def _backtest_summary(doc: dict, trades: int = 10) -> dict:
    return {"id": doc["id"], "strategy": doc["strategy"]["name"], "period": doc["period"], "stocks": len(doc["symbols"]),
            "metrics": doc["metrics"], "warnings": doc["warnings"], "data_sources": doc.get("data_sources"),
            "buy_and_hold_return_pct": (doc.get("buy_and_hold") or {}).get("return_pct"),
            "benchmark_return_pct": (doc.get("benchmark") or {}).get("return_pct"),
            "open_positions": doc["open_positions"][:20],
            "latest_trades": doc["trades"][-trades:], "trades_total": doc.get("trades_total", len(doc["trades"]))}


def _strategy_config(core: App, strategy_id: str) -> StrategyConfig:
    doc = core.store.get("strategies", strategy_id)
    if doc is None:
        raise NotFound("strategy not found")
    return StrategyConfig.model_validate({k: doc[k] for k in StrategyConfig.model_fields})


def _run_backtest(core: App, a: RunBacktest) -> dict:
    doc = core.backtest(_strategy_config(core, a.strategy_id), strategy_id=a.strategy_id, symbols=a.symbols,
                        start=a.start.isoformat() if a.start else None, end=a.end.isoformat() if a.end else None,
                        capital=a.capital)
    return _backtest_summary(doc)


class Compare(Args):
    strategy_ids: list[str] = Field(min_length=2, max_length=4)
    symbols: list[str] | None = Field(default=None, max_length=300)
    start: date | None = None
    end: date | None = None
    capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))


def _compare(core: App, a: Compare) -> dict:
    out = core.compare(a.strategy_ids, symbols=a.symbols, start=a.start.isoformat() if a.start else None,
                       end=a.end.isoformat() if a.end else None, capital=a.capital)
    return {"same": out["same"], "runs": [pick(r, "id", "name", "period", "stocks", "metrics", "warnings") for r in out["runs"]]}


class Backtests(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it for one run's details; leave out for the history")
    limit: int = Field(default=10, ge=1, le=30)


def _backtests(core: App, a: Backtests) -> dict:
    if a.id:
        doc = core.store.get("backtests", a.id)
        if doc is None:
            raise NotFound("backtest not found")
        return _backtest_summary(doc, trades=25)
    return {"runs": core.backtests()[:a.limit]}


def _signals(core: App, a: NoArgs) -> dict:
    return {"signals": core.active_signals(),
            "note": "Signals of the latest completed session, for the saved strategies. Informational only."}


def _paper_runs(core: App, a: NoArgs) -> dict:
    return {"runs": paper.runs_view(core)}


class StartRun(Args):
    strategy_id: str = Field(min_length=1, max_length=40)
    capital: Decimal = Field(gt=0, le=Decimal("1000000000"), description="Paper cash set aside for the run, in EGP")
    symbols: list[str] | None = Field(default=None, max_length=400)


def _start_run(core: App, a: StartRun) -> dict:
    run = paper.start_run(core, a.strategy_id, a.capital, a.symbols)
    return pick(run, "id", "name", "capital", "status", "last_date") | {"stocks": len(run["universe"])}


class RunStatus(Args):
    id: str = Field(min_length=1, max_length=40)
    status: Literal["active", "paused", "stopped"] = Field(description="'stopped' is final")


def _run_status(core: App, a: RunStatus) -> dict:
    return pick(paper.set_status(core, a.id, a.status), "id", "name", "status", "last_date")


# ---- alerts, research, journal -----------------------------------------------------------
def _alerts(core: App, a: NoArgs) -> dict:
    out = Extras(core).alerts()
    return {"alerts": out["alerts"], "recent_events": out["events"][:15], "kinds": ALERT_KINDS}


class SaveAlert(Args):
    id: str | None = Field(default=None, max_length=40, description="Give it to change an existing alert")
    kind: Literal["price_above", "price_below", "change_pct_above", "change_pct_below", "volume_ratio_above",
                  "rsi_above", "rsi_below", "strategy_signal"]
    symbol: str | None = Field(default=None, max_length=12)
    value: float | None = None
    strategy_id: str | None = Field(default=None, max_length=40)
    note: str = Field(default="", max_length=300)
    active: bool = True


def _save_alert(core: App, a: SaveAlert) -> dict:
    return Extras(core).save_alert(AlertIn(**a.model_dump(exclude={"id"})), a.id)


class Research(Args):
    symbol: str | None = Field(default=None, max_length=12)
    query: str | None = Field(default=None, max_length=80)
    category: str | None = Field(default=None, max_length=40)
    limit: int = Field(default=15, ge=1, le=40)


def _research(core: App, a: Research) -> dict:
    items = Extras(core).research(symbol=a.symbol, q=a.query, category=a.category)
    return {"matching": len(items), "items": items[:a.limit]}


class SaveResearch(Args):
    id: str | None = Field(default=None, max_length=40)
    title: str = Field(min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="", max_length=120)
    published: date | None = None
    symbols: list[str] = Field(default_factory=list, max_length=50)
    sectors: list[str] = Field(default_factory=list, max_length=20)
    category: Literal["news", "disclosure", "announcement", "financials", "broker_report", "presentation",
                      "economic", "other"] = "news"
    summary: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=4000)
    sentiment: Literal["positive", "negative", "neutral"] = "neutral"
    importance: int = Field(default=2, ge=1, le=3)


def _save_research(core: App, a: SaveResearch) -> dict:
    return Extras(core).save_research(ResearchIn(**a.model_dump(exclude={"id"})), a.id)


class Journal(Args):
    symbol: str | None = Field(default=None, max_length=12)
    status: Literal["open", "closed"] | None = None
    limit: int = Field(default=15, ge=1, le=40)


def _journal(core: App, a: Journal) -> dict:
    items = Extras(core).journal(symbol=a.symbol, status=a.status)
    return {"matching": len(items), "entries": items[:a.limit]}


class SaveJournal(Args):
    id: str | None = Field(default=None, max_length=40)
    symbol: str | None = Field(default=None, max_length=12)
    strategy_id: str | None = Field(default=None, max_length=40)
    trade_seq: int | None = Field(default=None, ge=1, description="Ledger number of the trade this entry is about")
    entry_date: date | None = None
    thesis: str = Field(min_length=1, max_length=4000, description="Why this stock or trade")
    expected: str = Field(default="", max_length=2000)
    evidence: str = Field(default="", max_length=4000)
    exit_condition: str = Field(default="", max_length=2000)
    outcome: str = Field(default="", max_length=4000)
    lesson: str = Field(default="", max_length=4000)
    status: Literal["open", "closed"] = "open"


def _save_journal(core: App, a: SaveJournal) -> dict:
    return Extras(core).save_journal(JournalIn(**a.model_dump(exclude={"id"})), a.id)


class Delete(Args):
    kind: Literal["strategy", "alert", "research", "journal", "list"]
    id: str = Field(min_length=1, max_length=40)


def _delete(core: App, a: Delete) -> dict:
    extras = Extras(core)
    if a.kind == "strategy":
        core.delete_strategy(a.id)
    elif a.kind == "alert":
        extras.delete_alert(a.id)
    elif a.kind == "research":
        extras.delete_research(a.id)
    elif a.kind == "journal":
        extras.delete_journal(a.id)
    else:
        if not core.store.delete("categories", a.id):
            raise NotFound("list not found")
        core.audit("delete", "category", {"id": a.id})
    return {"deleted": a.kind, "id": a.id}


# ---- settings, records, knowledge, navigation ---------------------------------------------
def _settings(core: App, a: NoArgs) -> dict:
    return {"settings": core.app_settings(), "fee_schedule": core.fee_schedule().model_dump(mode="json"),
            "market_data": core.provider_status(), "data_quality": core.market.status(),
            "trading": "paper only: this application cannot send an order to a broker"}


class UpdateSettings(Args):
    starting_capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"),
                                             description="Used by the next portfolio reset and as the backtest default")
    benchmark: str | None = Field(default=None, max_length=12)


def _update_settings(core: App, a: UpdateSettings) -> dict:
    return core.update_app_settings(starting_capital=a.starting_capital, benchmark=a.benchmark)


class FeeLine(Args):
    code: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    rate_pct: Decimal = Field(default=Decimal("0"), ge=0, le=10, description="Percent of the trade's gross value")
    fixed: Decimal = Field(default=Decimal("0"), ge=0)
    minimum: Decimal = Field(default=Decimal("0"), ge=0)
    maximum: Decimal | None = Field(default=None, ge=0)
    applies_to: Literal["buy", "sell", "both"] = "both"
    enabled: bool = True


class UpdateFees(Args):
    items: list[FeeLine] = Field(min_length=1, max_length=20, description="The complete schedule: it replaces the current one")
    verified: bool = Field(default=False, description="True only if the user says they checked it against the broker's tariff")
    note: str = Field(default="", max_length=500)


def _update_fees(core: App, a: UpdateFees) -> dict:
    schedule = FeeSchedule(items=[FeeItem(**i.model_dump()) for i in a.items], verified=a.verified, note=a.note)
    return core.update_fee_schedule(schedule).model_dump(mode="json")


class Audit(Args):
    limit: int = Field(default=20, ge=1, le=60)


def _audit(core: App, a: Audit) -> dict:
    return {"entries": core.store.recent("audit", a.limit)}


def knowledge_index() -> list[dict]:
    """The reference notes shipped with the app: one Markdown file each, title on the first line."""
    out = []
    for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        out.append({"name": path.stem, "title": lines[0].lstrip("# ") if lines else path.stem,
                    "about": lines[1][:240] if len(lines) > 1 else "", "parts": max(1, -(-len(text) // KNOWLEDGE_PART))})
    return out


class Knowledge(Args):
    name: str | None = Field(default=None, max_length=80, description="Leave out to list what the knowledge base holds")
    part: int = Field(default=1, ge=1, le=200, description="Long references come in parts")


def _knowledge(core: App, a: Knowledge) -> dict:
    index = knowledge_index()
    if not a.name:
        return {"references": index}
    entry = next((e for e in index if e["name"] == a.name), None)
    if entry is None:
        raise NotFound(f"no reference called {a.name}; available: {', '.join(e['name'] for e in index) or 'none'}")
    text = (KNOWLEDGE_DIR / f"{entry['name']}.md").read_text(encoding="utf-8")
    start = (a.part - 1) * KNOWLEDGE_PART
    if start >= len(text):
        raise NotFound(f"{a.name} has {entry['parts']} part(s)")
    return {"name": entry["name"], "title": entry["title"], "part": a.part, "parts": entry["parts"],
            "text": text[start:start + KNOWLEDGE_PART]}


class OpenPage(Args):
    page: Literal["dashboard", "market", "stock", "watchlist", "portfolio", "trades", "strategies", "simulator",
                  "research", "journal", "alerts", "guide", "settings"]
    symbol: str | None = Field(default=None, max_length=12, description="Needed for the stock page")


def page_path(a: OpenPage) -> str:
    path = PAGES[a.page]
    return f"{path}?symbol={a.symbol.upper()}" if a.page == "stock" and a.symbol else path


def _open_page(core: App, a: OpenPage) -> dict:
    if a.page == "stock":
        if not a.symbol or core.market.instrument(a.symbol.upper()) is None:
            raise NotFound("give the symbol of a known stock to open its page")
    return {"opened": page_path(a)}


TOOLS: list[Tool] = [
    Tool("market_overview", "The market right now: indices, breadth, top gainers, losers and most active stocks, "
         "sector performance, whether the market is open and how fresh the prices are.", NoArgs, _market_overview,
         label=lambda a: "Reading the market overview"),
    Tool("find_stocks", "Search and rank the listed stocks by name, symbol or sector, with last price, day, week and "
         "month change and volume. Use it to screen (e.g. biggest movers in a sector).", FindStocks, _find_stocks,
         label=lambda a: f"Searching stocks{f' for {a.query}' if a.query else ''}{f' in {a.sector}' if a.sector else ''}"),
    Tool("stock_report", "Everything known about one stock: quote, technical and momentum read (trend, RSI, moving "
         "averages, support and resistance, returns), recent candles, the user's holding in it, active strategy signals.",
         StockReport, _stock_report, label=lambda a: f"Looking at {a.symbol.upper()}"),
    Tool("price_depth", "The live order book of one stock (best bids and asks with sizes). Needs the live market feed.",
         SymbolArg, _price_depth, label=lambda a: f"Reading the order book of {a.symbol.upper()}"),
    Tool("portfolio", "The paper portfolio: cash, holdings with cost and market value, gross and net profit, fees, "
         "sector allocation, concentration warnings and recent value history.", NoArgs, _portfolio,
         label=lambda a: "Reading the portfolio"),
    Tool("trades", "The paper ledger: the latest transactions with price, fees, cash movement and realized profit, and "
         "the totals.", Trades, _trades, label=lambda a: "Reading the trade ledger"),
    Tool("preview_trade", "What a paper order would cost before placing it: fill price, every fee line, total cash, and "
         "whether it would be accepted.", TradeArgs, _preview_trade,
         label=lambda a: f"Pricing a {a.side.lower()} of {a.qty} {a.symbol.upper()}"),
    Tool("place_trade", "Record a paper trade in the ledger at the stock's latest price, with fees. Paper only: nothing "
         "is sent to a broker.", PlaceTrade, _place_trade, kind="confirm",
         label=lambda a: f"{'Buy' if a.side == 'BUY' else 'Sell'} {a.qty:,} {a.symbol.upper()} (paper trade)"),
    Tool("watchlist", "The stocks on the watchlist with their quotes, and the user's custom stock lists.", NoArgs, _watchlist,
         label=lambda a: "Reading the watchlist"),
    Tool("set_watch", "Add a stock to the watchlist or remove it.", SetWatch, _set_watch, kind="write",
         label=lambda a: f"{'Add' if a.watched else 'Remove'} {a.symbol.upper()} {'to' if a.watched else 'from'} the watchlist"),
    Tool("save_stock_list", "Create or change a custom list of stocks.", SaveList, _save_list, kind="write",
         label=lambda a: f"Save the stock list “{a.name}”"),
    Tool("strategies", "The saved strategies, the available strategy types with their parameters and ranges, and the "
         "default risk settings.", NoArgs, _strategies, label=lambda a: "Reading the strategies"),
    Tool("save_strategy", "Create or change a strategy: its type, parameters, stocks or sectors, and risk settings "
         "(stop-loss, take-profit, position size, cash reserve, slippage).", SaveStrategy, _save_strategy, kind="write",
         label=lambda a: f"Save the strategy “{a.name}”"),
    Tool("run_backtest", "Test a saved strategy on price history with fees and slippage. Returns the metrics, warnings "
         "and latest trades; the run is kept in the simulator's history.", RunBacktest, _run_backtest, kind="write",
         label=lambda a: "Run a backtest"),
    Tool("compare_strategies", "Backtest two to four saved strategies on the same stocks, period, capital and fees.",
         Compare, _compare, kind="write", label=lambda a: f"Compare {len(a.strategy_ids)} strategies"),
    Tool("backtests", "Earlier backtest runs: the history, or one run's metrics and trades by id.", Backtests, _backtests,
         label=lambda a: "Reading backtest results"),
    Tool("signals", "Entry and exit signals the saved strategies give on the latest completed session.", NoArgs, _signals,
         label=lambda a: "Reading today's strategy signals"),
    Tool("paper_runs", "Automatic paper-trading runs: status, capital, cash, open positions, profit, pending orders and notes.",
         NoArgs, _paper_runs, label=lambda a: "Reading the automatic runs"),
    Tool("start_paper_run", "Start an automatic paper-trading run: a saved strategy trades the paper portfolio by itself "
         "with the capital set aside for it.", StartRun, _start_run, kind="confirm",
         label=lambda a: f"Start an automatic run with EGP {a.capital:,.0f}"),
    Tool("set_paper_run_status", "Pause, resume or stop an automatic run. Stopping is final.", RunStatus, _run_status,
         kind="confirm", label=lambda a: {"active": "Resume", "paused": "Pause", "stopped": "Stop"}[a.status] + " an automatic run"),
    Tool("alerts", "The alerts, what kinds exist, and the alerts that fired recently.", NoArgs, _alerts,
         label=lambda a: "Reading the alerts"),
    Tool("save_alert", "Create or change an alert on a price, day change, volume, RSI level or strategy signal.",
         SaveAlert, _save_alert, kind="write",
         label=lambda a: f"Save an alert{f' on {a.symbol.upper()}' if a.symbol else ''}"),
    Tool("research", "The research and news items the user saved, filtered by stock, text or category.", Research, _research,
         label=lambda a: "Reading saved research"),
    Tool("save_research", "Save or change a research or news item, linked to stocks and sectors.", SaveResearch,
         _save_research, kind="write", label=lambda a: f"Save the research item “{a.title[:50]}”"),
    Tool("journal", "The investment journal: why trades were made, what was expected and what was learned.", Journal,
         _journal, label=lambda a: "Reading the journal"),
    Tool("save_journal_entry", "Write or update a journal entry.", SaveJournal, _save_journal, kind="write",
         label=lambda a: f"Save a journal entry{f' on {a.symbol.upper()}' if a.symbol else ''}"),
    Tool("delete_item", "Delete a strategy, alert, research item, journal entry or custom stock list for good.", Delete,
         _delete, kind="confirm", label=lambda a: f"Delete a {a.kind}"),
    Tool("settings", "The app's settings: starting capital, the fee schedule and whether it was verified, the state of "
         "the market-data feed and data quality.", NoArgs, _settings, label=lambda a: "Reading the settings"),
    Tool("update_settings", "Change the starting capital or the benchmark.", UpdateSettings, _update_settings,
         kind="confirm", label=lambda a: "Change the settings"),
    Tool("update_fee_schedule", "Replace the fee schedule used for every later trade and backtest. Read the current one "
         "first and send the complete list.", UpdateFees, _update_fees, kind="confirm",
         label=lambda a: f"Replace the fee schedule ({len(a.items)} lines)"),
    Tool("reset_portfolio", "Start a fresh paper portfolio with the starting capital. The old ledger is kept but no "
         "longer active.", NoArgs, _reset_portfolio, kind="confirm", label=lambda a: "Reset the paper portfolio"),
    Tool("audit_log", "The record of what was changed in this account and when.", Audit, _audit,
         label=lambda a: "Reading the activity log"),
    Tool("knowledge", "The app's reference library: how the app works, and trading references added to it. Call it "
         "with no name to see what it holds, then read what is relevant.", Knowledge, _knowledge,
         label=lambda a: f"Consulting the reference “{a.name}”" if a.name else "Checking the reference library"),
    Tool("open_page", "Open one of the app's screens for the user.", OpenPage, _open_page, kind="write",
         label=lambda a: f"Open the {a.page} page{f' for {a.symbol.upper()}' if a.symbol else ''}"),
]
BY_NAME = {t.name: t for t in TOOLS}


def _inline(schema: dict) -> dict:
    """A pydantic JSON schema with its references resolved in place and the noise removed."""
    defs = schema.get("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].rsplit("/", 1)[1]])
            return {k: walk(v) for k, v in node.items() if k not in ("title", "$defs")}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node
    return walk(schema)


def tool_specs() -> list[dict]:
    """The tool definitions sent to the model. Their order and content are fixed, which keeps the prompt cacheable."""
    return [{"name": t.name, "description": t.description, "input_schema": _inline(t.args.model_json_schema()),
             "eager_input_streaming": True} for t in TOOLS]


def parse(name: str, raw) -> tuple[Tool | None, Any, str | None]:
    """Find the tool and check its input. The model's input is never trusted as it arrives:
    it is validated against the tool's own schema before anything runs."""
    tool = BY_NAME.get(name)
    if tool is None:
        return None, None, f"There is no tool called {name}."
    try:
        return tool, tool.args.model_validate(raw if isinstance(raw, dict) else {}), None
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'input'}: {e['msg']}" for e in exc.errors()[:6])
        return tool, None, json.dumps({"INVALID_JSON": json.dumps(raw, default=str)[:2000], "problems": problems})


def render(result) -> str:
    """A tool result as compact JSON, bounded so one answer cannot flood the conversation."""
    text = json.dumps(r4(clean(result)), separators=(",", ":"), default=str, ensure_ascii=False)
    if len(text) > MAX_RESULT_CHARS:
        return json.dumps({"too_large": True, "characters": len(text),
                           "note": "The result was too large to return. Ask for less: a smaller limit, a filter, fewer candles."})
    return text
