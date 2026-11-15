"""Automatic paper trading: a saved strategy trading the paper portfolio by itself.

A "run" follows one strategy over a set of stocks with its own slice of capital.
It works on completed sessions only, exactly like the backtester and with the
same arithmetic: a signal read at one session's close is filled at the next
session's open, with slippage and the fee schedule; stops and targets are
checked against each day's low and high. Every fill is an ordinary entry in the
paper ledger, marked with the run it came from. Nothing here can reach a broker.

Rules that keep runs honest
* A session is handled only once it is complete for every stock the active runs
  follow: a stock whose final bar has not arrived yet holds the session back, so
  its stop or signal is never skipped. A stock whose data stays several sessions
  behind is set aside (with a note) rather than stalling everything.
* Sessions are handled in date order across all runs together, so one run's fill
  never makes another run miss a day.
* The ledger is the record of what is held. Before each pass a run's positions
  are matched against it: shares sold by hand are no longer the run's, and their
  cost goes back to the run's cash.
* A run does not buy a stock the portfolio already holds outside that run, so
  one stock never has two owners with two different costs.
* A run's capital is set aside when it starts: two runs cannot be promised the
  same cash.
"""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pandas as pd

from .domain.fees import compute_fees
from .domain.ledger import LedgerError, build_trade, replay
from .domain.money import ZERO, D, money, px
from .domain.strategies import StrategyConfig, signals

MAX_UNIVERSE = 400
MAX_SESSIONS_PER_CALL = 30  # a run left alone for long catches up over a few calls
MAX_LAG_SESSIONS = 5        # a stock this far behind the others no longer holds a run back
ISO = "%Y-%m-%d"


def _config(doc: dict) -> StrategyConfig:
    return StrategyConfig.model_validate({k: doc[k] for k in StrategyConfig.model_fields})


def _note(run: dict, text: str) -> None:
    if text not in run["notes"]:
        run["notes"] = (run["notes"] + [text])[-10:]


def _own_runs(core) -> list[dict]:
    """Runs of the current portfolio that still manage money, oldest first."""
    pid = core.app_settings()["active_portfolio_id"]
    return sorted((r for r in core.store.list("paper_runs") if r.get("portfolio_id") == pid and r["status"] != "stopped"),
                  key=lambda r: r["created_at"])


def _latest_settled(core, universe: list[str]) -> pd.Timestamp | None:
    return max((df.index[-1] for s in universe if (df := core.market.bars(s, settled=True)) is not None and len(df)),
               default=None)


def _gross_cost(pos: dict) -> Decimal:
    """What the shares cost before fees."""
    return D(pos["gross"]) if "gross" in pos else money(D(pos["entry_price"]) * pos["qty"])


def start_run(core, strategy_id: str, capital: Decimal, symbols: list[str] | None) -> dict:
    from .services import NotFound
    strategy = core.store.get("strategies", strategy_id)
    if strategy is None:
        raise NotFound("strategy not found")
    cfg = _config(strategy)
    universe = core.strategy_universe(cfg, symbols)[:MAX_UNIVERSE]
    if not universe:
        raise LedgerError("the strategy has no stocks to trade")
    capital = money(capital)
    cash = replay(core.store.list(core._ledger_coll())).cash
    # Cash already promised to other runs is not available twice.
    free = cash - sum((D(r["cash"]) for r in _own_runs(core)), ZERO)
    if capital <= 0 or capital > free:
        raise LedgerError("capital must be between EGP 1 and the cash not already set aside for other runs "
                          f"(EGP {money(max(free, ZERO)):,.2f})")
    latest = _latest_settled(core, universe)
    if latest is None:
        raise LedgerError("no price history for the strategy's stocks")
    doc = {
        "id": uuid.uuid4().hex[:12], "strategy_id": strategy_id, "name": strategy["name"],
        "strategy": cfg.model_dump(mode="json"), "universe": universe,
        "capital": str(capital), "cash": str(capital), "positions": {}, "pending_buy": [], "pending_sell": [],
        "status": "active", "created_at": datetime.now(UTC).isoformat(timespec="microseconds"),
        "last_date": latest.strftime(ISO),
        "trades": 0, "realized_net": "0", "fees": "0", "notes": [],
        "portfolio_id": core.app_settings()["active_portfolio_id"],
    }
    with core.store.transaction():
        core.store.put("paper_runs", doc["id"], doc)
        core.audit("start", "paper_run", {"id": doc["id"], "name": doc["name"], "capital": doc["capital"],
                                           "stocks": len(universe)})
    return doc


def _valuation(core, run: dict) -> tuple[Decimal, list[dict]]:
    """The run's cash plus its open positions at the latest price."""
    value = D(run["cash"])
    positions = []
    for symbol, pos in run["positions"].items():
        df = core.market.bars(symbol)
        last = float(df["close"].iloc[-1]) if df is not None and len(df) else float(pos["entry_price"])
        worth = money(D(last) * pos["qty"])
        value += worth
        positions.append({"symbol": symbol, "qty": pos["qty"], "entry_price": float(pos["entry_price"]),
                          "entry_date": pos["entry_date"], "last": last, "value": float(worth),
                          "gross_pnl": float(worth - _gross_cost(pos))})  # before fees, like every gross figure
    return value, positions


def set_status(core, id: str, status: str) -> dict:
    from .services import NotFound, retry_conflict

    @retry_conflict
    def change() -> dict:
        with core.store.transaction():
            doc = core.store.get("paper_runs", id)
            if doc is None:
                raise NotFound("run not found")
            if doc["status"] == "stopped":
                raise LedgerError("a stopped run cannot be changed; start a new one")
            if doc["status"] == status:
                return doc  # nothing to change: in particular, an active run does not skip ahead
            doc["status"] = status
            if status != "active":
                doc["pending_buy"], doc["pending_sell"] = [], []  # nothing decided earlier is filled later
            if status == "active":
                # resume from the latest session: the days it was paused are not traded in hindsight
                latest = _latest_settled(core, doc["universe"])
                if latest is not None:
                    doc["last_date"] = max(doc["last_date"], latest.strftime(ISO))
            if status == "stopped":
                # Its shares become ordinary holdings; the run's result is fixed as of now.
                value, positions = _valuation(core, doc)
                doc["final"] = {"value": str(money(value)), "date": doc["last_date"]}
                doc["released"] = [{k: p[k] for k in ("symbol", "qty", "entry_price", "entry_date", "last")} for p in positions]
                doc["positions"] = {}
            core.store.put("paper_runs", id, doc)
            core.audit(status if status != "active" else "resume", "paper_run", {"id": id, "name": doc["name"]})
            return doc
    return change()


def _reconcile(runs: list[dict], state) -> None:
    """A run can only own shares the ledger still holds; anything sold by hand goes back to its cash at cost."""
    available = {symbol: pos.qty for symbol, pos in state.positions.items()}
    for run in runs:
        for symbol, pos in list(run["positions"].items()):
            keep = min(pos["qty"], available.get(symbol, 0))
            available[symbol] = available.get(symbol, 0) - keep
            gone = pos["qty"] - keep
            if not gone:
                continue
            cost_out = D(pos["cost"]) if keep == 0 else money(D(pos["cost"]) * gone / pos["qty"])
            gross_out = _gross_cost(pos) if keep == 0 else money(_gross_cost(pos) * gone / pos["qty"])
            run["cash"] = str(D(run["cash"]) + cost_out)
            _note(run, f"{gone} {symbol} were sold outside this run: they left it at cost (EGP {cost_out:,.2f} back to its cash).")
            if keep == 0:
                del run["positions"][symbol]
                run["pending_sell"] = [s for s in run["pending_sell"] if s != symbol]
            else:
                pos.update(qty=keep, cost=str(D(pos["cost"]) - cost_out), gross=str(_gross_cost(pos) - gross_out))


def _plan(core, run: dict) -> dict | None:
    """What a run needs for one pass: its bars and the last session that is complete for its stocks."""
    cfg = _config(run["strategy"])
    frames = {s: df for s in run["universe"] if (df := core.market.bars(s, settled=True)) is not None and len(df) > 1}
    if not frames:
        return None
    marks = {s: core.market.settled_until(s) for s in frames}
    top = max(marks.values())
    recent = sorted({d for df in frames.values() for d in df.index[-(MAX_LAG_SESSIONS * 3):]})
    ready = top
    for symbol, mark in marks.items():
        if mark >= top:
            continue
        if sum(1 for d in recent if mark < d <= top) > MAX_LAG_SESSIONS:
            _note(run, f"{symbol} has no data after {mark.strftime(ISO)}: the run carries on without it.")
        else:
            ready = min(ready, mark)  # its bar for the next session has not arrived yet: wait for it
    return {"run": run, "cfg": cfg, "frames": frames, "ready": ready, "last": pd.Timestamp(run["last_date"]), "signals": None}


def process_runs(core) -> dict:
    """Bring every active run up to the latest completed session. Safe to call any number of times."""
    from .services import now_iso
    own = _own_runs(core)
    active = [r for r in own if r["status"] == "active"]
    if not active:
        return {"runs": 0, "fills": 0}
    schedule = core.fee_schedule()
    coll = core._ledger_coll()
    fills = 0
    with core.store.transaction():
        txs = core.store.list(coll)
        ledger = {"state": replay(txs)}
        before = {r["id"]: json.dumps(r, sort_keys=True) for r in own}
        _reconcile(own, ledger["state"])
        plans = [p for r in active if (p := _plan(core, r))]

        def fill(run: dict, iso: str, side: str, symbol: str, qty: int, price: Decimal, why: str) -> dict | None:
            nonlocal fills
            try:
                tx = build_trade(ledger["state"], schedule, side=side, symbol=symbol, qty=qty, price=price)
            except LedgerError as exc:
                _note(run, f"{iso} {side} {symbol}: {exc}")
                return None
            tx.update(ts=now_iso(), trade_date=iso, price_date=iso, price_source=core.market.source(symbol), mode="paper",
                      note=f"{run['name']}: {why}", origin=f"strategy:{run['id']}", client_order_id=None)
            saved = core.store.append(coll, tx)
            txs.append(saved)
            ledger["state"] = replay(txs)
            fills += 1
            run["trades"] += 1
            run["fees"] = str(D(run["fees"]) + D(tx["fees_total"]))
            return saved

        def step(plan: dict, day: pd.Timestamp) -> None:
            """One session of one run. Mirrors `domain.backtest.run_backtest` step for step."""
            run, risk, frames = plan["run"], plan["cfg"].risk, plan["frames"]
            if plan["signals"] is None:
                plan["signals"] = {s: signals(plan["cfg"], df) for s, df in frames.items()}
            slip = D(risk.slippage_bps) / Decimal(10000)
            iso = day.strftime(ISO)
            bars = {s: df.loc[day] for s, df in frames.items() if day in df.index}

            def sell(symbol: str, raw_price: Decimal, why: str) -> None:
                pos = run["positions"].get(symbol)
                if not pos:
                    return
                tx = fill(run, iso, "SELL", symbol, pos["qty"], px(raw_price * (1 - slip)), why)
                if tx:
                    proceeds = D(tx["gross"]) - D(tx["fees_total"])
                    run["cash"] = str(D(run["cash"]) + proceeds)
                    run["realized_net"] = str(D(run["realized_net"]) + proceeds - D(pos["cost"]))
                    del run["positions"][symbol]

            # 1) orders decided at the previous close, at this session's open
            for symbol in sorted(run["pending_sell"]):
                if symbol in bars:
                    sell(symbol, D(float(bars[symbol]["open"])), "exit signal")
            run["pending_sell"] = [s for s in run["pending_sell"] if s in run["positions"]]  # no bar today: next session
            equity = D(run["cash"])
            for symbol, pos in run["positions"].items():
                df = frames.get(symbol)
                at = df.index.searchsorted(day) if df is not None else 0
                equity += (D(float(df["close"].iloc[at - 1])) if at else D(pos["entry_price"])) * pos["qty"]
            reserve = equity * D(risk.cash_reserve_pct) / 100
            waiting = []
            for symbol in run["pending_buy"]:
                if symbol in run["positions"]:
                    continue
                if symbol not in bars:
                    waiting.append(symbol)
                    continue
                if len(run["positions"]) >= risk.max_open_positions:
                    continue
                held = ledger["state"].positions.get(symbol)
                if held is not None and held.qty:
                    _note(run, f"{iso} BUY {symbol} skipped: the portfolio already holds it outside this run.")
                    continue
                price = px(D(float(bars[symbol]["open"])) * (1 + slip))
                budget = min(equity * D(risk.max_alloc_pct) / 100, D(run["cash"]) - reserve)
                qty = int(budget // price) if price > 0 else 0
                while qty > 0 and money(price * qty) + compute_fees(schedule, "buy", money(price * qty))["total"] > budget:
                    qty -= 1
                if qty <= 0:
                    continue
                tx = fill(run, iso, "BUY", symbol, qty, price, "entry signal")
                if tx:
                    cost = D(tx["gross"]) + D(tx["fees_total"])
                    run["cash"] = str(D(run["cash"]) - cost)
                    run["positions"][symbol] = {"qty": qty, "entry_price": str(price), "entry_date": iso,
                                                "cost": str(cost), "gross": tx["gross"]}
            run["pending_buy"] = waiting
            # 2) protective exits inside the session (the stop is assumed to come first)
            for symbol, pos in list(run["positions"].items()):
                if symbol not in bars:
                    continue
                bar, entry = bars[symbol], D(pos["entry_price"])
                opened, high, low = D(float(bar["open"])), D(float(bar["high"])), D(float(bar["low"]))
                if risk.stop_loss_pct is not None:
                    stop = entry * (1 - D(risk.stop_loss_pct) / 100)
                    if low <= stop:
                        sell(symbol, min(opened, stop), "stop-loss")
                        continue
                if risk.take_profit_pct is not None:
                    target = entry * (1 + D(risk.take_profit_pct) / 100)
                    if high >= target:
                        sell(symbol, max(opened, target), "take-profit")
            # 3) read the signals at this session's close, for the next open
            for symbol in bars:
                mark = plan["signals"][symbol].loc[day]
                if symbol in run["positions"]:
                    if mark["exit"] and symbol not in run["pending_sell"]:
                        run["pending_sell"].append(symbol)
                elif mark["entry"] and symbol not in run["pending_buy"]:
                    run["pending_buy"].append(symbol)
            run["last_date"] = iso
            plan["last"] = day

        if plans:
            # All runs move together: a session is taken only when it is complete for every one of them.
            ready = min(p["ready"] for p in plans)
            days = sorted({d for p in plans for df in p["frames"].values()
                           for d in df.index[(df.index > p["last"]) & (df.index <= ready)]})
            for day in days[:MAX_SESSIONS_PER_CALL]:
                for plan in plans:
                    if day > plan["last"]:
                        step(plan, day)
        for run in own:
            if json.dumps(run, sort_keys=True) != before[run["id"]]:
                core.store.put("paper_runs", run["id"], run)
        if fills:
            core.audit("process", "paper_runs", {"runs": len(active), "fills": fills})
    return {"runs": len(active), "fills": fills}


def runs_view(core) -> list[dict]:
    """Runs with their open positions valued at the latest price. A stopped run shows the result it ended with."""
    out = []
    for run in sorted(core.store.list("paper_runs"), key=lambda r: r["created_at"], reverse=True):
        value, positions = _valuation(core, run)
        if run.get("final"):
            value = D(run["final"]["value"])
        capital = D(run["capital"])
        out.append({**{k: run[k] for k in ("id", "name", "strategy_id", "status", "created_at", "last_date", "trades",
                                           "pending_buy", "pending_sell", "notes")},
                    "stocks": len(run["universe"]), "capital": float(capital), "cash": float(D(run["cash"])),
                    "value": float(value), "fees": float(D(run["fees"])), "realized_net": float(D(run["realized_net"])),
                    "pnl": float(value - capital), "pnl_pct": float((value - capital) / capital * 100) if capital else None,
                    "positions": positions, "released": run.get("released", []),
                    "current": run.get("portfolio_id") == core.app_settings()["active_portfolio_id"]})
    return out
