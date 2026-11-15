"""Automatic paper trading: a saved strategy trading the paper portfolio by itself.

A "run" follows one strategy over a set of stocks with its own slice of capital.
It works on completed sessions only, exactly like the backtester: a signal read
at one session's close is filled at the next session's open, with slippage and
the fee schedule; stops and targets are checked against each day's low and high.
Every fill is an ordinary entry in the paper ledger, marked with the run it came
from. Nothing here can reach a broker.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from .domain.fees import compute_fees
from .domain.ledger import LedgerError, build_trade, replay
from .domain.money import D, money
from .domain.strategies import StrategyConfig, signals

MAX_UNIVERSE = 400
MAX_SESSIONS_PER_CALL = 30  # a run left alone for long catches up over a few calls


def _config(doc: dict) -> StrategyConfig:
    return StrategyConfig.model_validate({k: doc[k] for k in StrategyConfig.model_fields})


def start_run(core, strategy_id: str, capital: Decimal, symbols: list[str] | None) -> dict:
    from .services import NotFound, now_iso
    strategy = core.store.get("strategies", strategy_id)
    if strategy is None:
        raise NotFound("strategy not found")
    cfg = _config(strategy)
    universe = core.strategy_universe(cfg, symbols)[:MAX_UNIVERSE]
    if not universe:
        raise LedgerError("the strategy has no stocks to trade")
    capital = money(capital)
    cash = replay(core.store.list(core._ledger_coll())).cash
    if capital <= 0 or capital > cash:
        raise LedgerError(f"capital must be between EGP 1 and the available cash (EGP {money(cash):,.2f})")
    latest = max((df.index[-1] for s in universe if (df := core.market.bars(s, settled=True)) is not None and len(df)),
                 default=None)
    if latest is None:
        raise LedgerError("no price history for the strategy's stocks")
    doc = {
        "id": uuid.uuid4().hex[:12], "strategy_id": strategy_id, "name": strategy["name"],
        "strategy": cfg.model_dump(mode="json"), "universe": universe,
        "capital": str(capital), "cash": str(capital), "positions": {}, "pending_buy": [], "pending_sell": [],
        "status": "active", "created_at": now_iso(), "last_date": latest.strftime("%Y-%m-%d"),
        "trades": 0, "realized_net": "0", "fees": "0", "notes": [],
        "portfolio_id": core.app_settings()["active_portfolio_id"],
    }
    with core.store.transaction():
        core.store.put("paper_runs", doc["id"], doc)
        core.audit("start", "paper_run", {"id": doc["id"], "name": doc["name"], "capital": doc["capital"],
                                           "stocks": len(universe)})
    return doc


def set_status(core, id: str, status: str) -> dict:
    from .services import NotFound
    with core.store.transaction():
        doc = core.store.get("paper_runs", id)
        if doc is None:
            raise NotFound("run not found")
        if doc["status"] == "stopped":
            raise LedgerError("a stopped run cannot be changed; start a new one")
        doc["status"] = status
        if status != "active":
            doc["pending_buy"], doc["pending_sell"] = [], []  # nothing decided earlier is filled later
        if status == "active":
            # resume from the latest session: the days it was paused are not traded in hindsight
            latest = max((df.index[-1] for s in doc["universe"]
                          if (df := core.market.bars(s, settled=True)) is not None and len(df)), default=None)
            if latest is not None:
                doc["last_date"] = max(doc["last_date"], latest.strftime("%Y-%m-%d"))
        core.store.put("paper_runs", id, doc)
        core.audit(status if status != "active" else "resume", "paper_run", {"id": id, "name": doc["name"]})
        return doc


def process_runs(core) -> dict:
    """Bring every active run up to the latest completed session. Safe to call any number of times."""
    from .services import now_iso
    runs = [r for r in core.store.list("paper_runs")
            if r["status"] == "active" and r.get("portfolio_id") == core.app_settings()["active_portfolio_id"]]
    if not runs:
        return {"runs": 0, "fills": 0}
    schedule = core.fee_schedule()
    coll = core._ledger_coll()
    fills = 0
    with core.store.transaction():
        txs = core.store.list(coll)
        ledger_floor = max((t["trade_date"] for t in txs if t.get("trade_date")), default="")
        for run in runs:
            cfg = _config(run["strategy"])
            risk = cfg.risk
            slip = D(risk.slippage_bps) / Decimal(10000)
            frames = {s: df for s in run["universe"] if (df := core.market.bars(s, settled=True)) is not None and len(df) > 1}
            if not frames:
                continue
            marks = {s: signals(cfg, df) for s, df in frames.items()}
            days = sorted({d for df in frames.values() for d in df.index if d.strftime("%Y-%m-%d") > run["last_date"]})
            for day in days[:MAX_SESSIONS_PER_CALL]:
                iso = day.strftime("%Y-%m-%d")
                if iso < ledger_floor:  # the ledger is chronological: a session before its last entry is skipped
                    run["last_date"], run["pending_buy"], run["pending_sell"] = iso, [], []
                    continue

                def fill(side: str, symbol: str, qty: int, price: Decimal, why: str, iso=iso, run=run) -> dict | None:
                    nonlocal fills, ledger_floor
                    try:
                        tx = build_trade(replay(txs), schedule, side=side, symbol=symbol, qty=qty, price=price)
                    except LedgerError as exc:
                        run["notes"] = (run["notes"] + [f"{iso} {side} {symbol}: {exc}"])[-10:]
                        return None
                    tx.update(ts=now_iso(), trade_date=iso, price_source=core.market.source(symbol), mode="paper",
                              note=f"{run['name']}: {why}", origin=f"strategy:{run['id']}", client_order_id=None)
                    saved = core.store.append(coll, tx)
                    txs.append(saved)
                    ledger_floor = max(ledger_floor, iso)
                    fills += 1
                    run["trades"] += 1
                    run["fees"] = str(D(run["fees"]) + D(tx["fees_total"]))
                    return saved

                def sell(symbol: str, raw_price: float, why: str, run=run, slip=slip, fill=fill) -> None:
                    pos = run["positions"].get(symbol)
                    if not pos:
                        return
                    price = D(round(raw_price * float(1 - slip), 4))
                    tx = fill("SELL", symbol, pos["qty"], price, why)
                    if tx:
                        proceeds = D(tx["gross"]) - D(tx["fees_total"])
                        run["cash"] = str(D(run["cash"]) + proceeds)
                        run["realized_net"] = str(D(run["realized_net"]) + proceeds - D(pos["cost"]))
                        del run["positions"][symbol]

                bars = {s: df.loc[day] for s, df in frames.items() if day in df.index}
                # 1) orders decided at the previous close, at this session's open
                for symbol in list(run["pending_sell"]):
                    if symbol in bars:
                        sell(symbol, float(bars[symbol]["open"]), "exit signal")
                run["pending_sell"] = [s for s in run["pending_sell"] if s in run["positions"]]
                waiting = []
                for symbol in run["pending_buy"]:
                    if symbol in run["positions"]:
                        continue
                    if symbol not in bars:
                        waiting.append(symbol)
                        continue
                    if len(run["positions"]) >= risk.max_open_positions:
                        continue
                    price = D(round(float(bars[symbol]["open"]) * float(1 + slip), 4))
                    reserve = D(run["capital"]) * D(risk.cash_reserve_pct) / 100
                    budget = min(D(run["capital"]) * D(risk.max_alloc_pct) / 100, D(run["cash"]) - reserve)
                    qty = int(budget // price) if price > 0 else 0
                    while qty > 0 and money(price * qty) + compute_fees(schedule, "buy", money(price * qty))["total"] > budget:
                        qty -= 1
                    if qty <= 0:
                        continue
                    tx = fill("BUY", symbol, qty, price, "entry signal")
                    if tx:
                        cost = D(tx["gross"]) + D(tx["fees_total"])
                        run["cash"] = str(D(run["cash"]) - cost)
                        run["positions"][symbol] = {"qty": qty, "entry_price": str(price), "entry_date": iso, "cost": str(cost)}
                run["pending_buy"] = waiting
                # 2) protective exits inside the session
                for symbol, pos in list(run["positions"].items()):
                    if symbol not in bars or pos["entry_date"] > iso:
                        continue
                    bar, entry = bars[symbol], float(pos["entry_price"])
                    if risk.stop_loss_pct is not None and float(bar["low"]) <= entry * (1 - risk.stop_loss_pct / 100):
                        sell(symbol, min(float(bar["open"]), entry * (1 - risk.stop_loss_pct / 100)), "stop-loss")
                    elif risk.take_profit_pct is not None and float(bar["high"]) >= entry * (1 + risk.take_profit_pct / 100):
                        sell(symbol, max(float(bar["open"]), entry * (1 + risk.take_profit_pct / 100)), "take-profit")
                # 3) read the signals at this session's close, for the next open
                for symbol in bars:
                    mark = marks[symbol].loc[day]
                    if symbol in run["positions"]:
                        if mark["exit"] and symbol not in run["pending_sell"]:
                            run["pending_sell"].append(symbol)
                    elif mark["entry"] and symbol not in run["pending_buy"]:
                        run["pending_buy"].append(symbol)
                run["last_date"] = iso
            core.store.put("paper_runs", run["id"], run)
        if fills:
            core.audit("process", "paper_runs", {"runs": len(runs), "fills": fills})
    return {"runs": len(runs), "fills": fills}


def runs_view(core) -> list[dict]:
    """Runs with their open positions valued at the latest price."""
    out = []
    for run in sorted(core.store.list("paper_runs"), key=lambda r: r["created_at"], reverse=True):
        value = D(run["cash"])
        positions = []
        for symbol, pos in run["positions"].items():
            df = core.market.bars(symbol)
            last = float(df["close"].iloc[-1]) if df is not None and len(df) else float(pos["entry_price"])
            worth = D(round(last * pos["qty"], 2))
            value += worth
            positions.append({"symbol": symbol, "qty": pos["qty"], "entry_price": float(pos["entry_price"]),
                              "entry_date": pos["entry_date"], "last": last, "value": float(worth),
                              "gross_pnl": float(worth - D(pos["cost"]))})
        capital = D(run["capital"])
        out.append({**{k: run[k] for k in ("id", "name", "strategy_id", "status", "created_at", "last_date", "trades",
                                           "pending_buy", "pending_sell", "notes")},
                    "stocks": len(run["universe"]), "capital": float(capital), "cash": float(D(run["cash"])),
                    "value": float(value), "fees": float(D(run["fees"])), "realized_net": float(D(run["realized_net"])),
                    "pnl": float(value - capital), "pnl_pct": float((value - capital) / capital * 100) if capital else None,
                    "positions": positions, "current": run.get("portfolio_id") == core.app_settings()["active_portfolio_id"]})
    return out

