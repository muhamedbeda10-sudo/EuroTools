"""Regression tests for the correctness review: each test pins one mistake that was found and fixed.

Grouped as: automatic paper runs, market data and time, manual trades and money, everything else.
"""
import copy
import json
from datetime import date, datetime, timedelta
from decimal import Decimal

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app.data.calendar as cal
from app.config import Settings
from app.data.calendar import CAIRO, is_trading_day, last_settle
from app.data.feed import Feed, StoreDocs, chunk_of
from app.domain import indicators as ind
from app.domain.backtest import run_backtest
from app.domain.fees import DEFAULT_FEE_SCHEDULE
from app.domain.ledger import replay
from app.domain.money import D, money
from app.domain.strategies import StrategyConfig
from app.main import create_app
from app.services import App
from app.store.errors import ConflictError
from app.store.sqlite_store import Store

DAYS = [f"{d:%Y-%m-%d}" for d in pd.bdate_range("2025-01-01", periods=60)]
FLAT = [10.0] * 30


@pytest.fixture(autouse=True)
def _fresh_feed():
    Feed.reset()
    yield
    Feed.reset()


@pytest.fixture()
def clock(monkeypatch):
    """One adjustable Cairo clock for every module that asks the time."""
    import app.data.feed as feedmod
    import app.data.market as marketmod
    import app.main as mainmod
    import app.services as services
    state = {"now": datetime(2026, 11, 12, 18, 0, tzinfo=CAIRO)}
    for mod in (feedmod, marketmod, services):
        monkeypatch.setattr(mod, "cairo_now", lambda: state["now"])
    for mod in (feedmod, services, mainmod):
        monkeypatch.setattr(mod, "market_open", lambda now=None: cal.market_open(now or state["now"]))

    def at(y, m, d, hh, mm=0):
        state["now"] = datetime(y, m, d, hh, mm, tzinfo=CAIRO)
    return at


def client(tmp_path, *, sample=False, younit=None):
    app = create_app(Settings(data_dir=tmp_path, seed_sample_data=sample, younit_trading_id="", younit_api_key=""),
                     Store(tmp_path / "t.sqlite3"), younit=younit)
    return TestClient(app)


def bars(closes, days=None):
    """Each day opens at the previous close; high/low sit 1% outside the open/close range."""
    days = days or DAYS[:len(closes)]
    rows, prev = [], closes[0]
    for d, close in zip(days, closes, strict=True):
        rows.append((d, prev, round(max(prev, close) * 1.01, 4), round(min(prev, close) * 0.99, 4), close, 1000))
        prev = close
    return rows


def load(c, symbol, rows, name=None):
    text = "date,open,high,low,close,volume\n" + "".join(",".join(str(v) for v in r) + "\n" for r in rows)
    data = {"symbol": symbol, **({"name": name, "sector": "Test"} if name else {})}
    r = c.post("/api/v1/data/bars/import", data=data, files={"file": ("x.csv", text, "text/csv")})
    assert r.status_code == 200, r.text


def strategy(c, symbols, name="Fast", **risk):
    return c.post("/api/v1/strategies", json={
        "name": name, "type": "sma_cross", "symbols": symbols, "params": {"fast": 2, "slow": 5},
        "risk": {"stop_loss_pct": None, "max_alloc_pct": 40, "cash_reserve_pct": 0, "slippage_bps": 0, **risk}}).json()


def start(c, st, capital=20000):
    r = c.post("/api/v1/paper-runs", json={"strategy_id": st["id"], "capital": capital})
    assert r.status_code == 201, r.text
    return r.json()


def fills(c):
    """Trades oldest first, without the opening deposit."""
    return [t for t in reversed(c.get("/api/v1/trades").json()["transactions"]) if t["type"] != "DEPOSIT"]


def process(c):
    return c.post("/api/v1/paper-runs/process").json()


# =============================================================================
# automatic paper runs
# =============================================================================
def test_a_session_waits_until_every_stock_of_the_run_has_its_bar(tmp_path):
    """A session arrives in two batches and the background job runs in between: the late stock's
    stop-loss on that session must still be executed, not skipped for good."""
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    load(c, "TMGH", bars(FLAT))
    run = start(c, strategy(c, ["COMI", "TMGH"], stop_loss_pct=10))
    up = FLAT + [11, 12, 13]
    load(c, "COMI", bars(up))
    load(c, "TMGH", bars(up))
    assert process(c)["fills"] == 2                       # both bought at the open of the 2nd rising day
    # Session D: COMI keeps rising; TMGH crashes far through its stop (entry 11 -> stop 9.90), then bounces on D+1.
    tmgh = bars(up) + [(DAYS[33], 13, 13.1, 8.0, 8.5, 1000)]
    load(c, "COMI", bars(up + [14]))                      # batch 1 lands ...
    assert process(c)["fills"] == 0                       # ... the job runs: session D is not complete yet
    assert c.get("/api/v1/paper-runs").json()[0]["last_date"] == DAYS[32]
    load(c, "TMGH", tmgh)                                 # ... batch 2 lands
    assert process(c)["fills"] == 1
    load(c, "COMI", bars(up + [14, 15]))
    load(c, "TMGH", tmgh + [(DAYS[34], 10.6, 11.5, 10.5, 11.2, 1000)])
    process(c)
    sells = [t for t in fills(c) if t["type"] == "SELL"]
    assert [(t["symbol"], t["trade_date"], t["price"], "stop-loss" in t["note"]) for t in sells] == [("TMGH", DAYS[33], 9.9, True)]
    view = c.get("/api/v1/paper-runs").json()[0]
    assert [p["symbol"] for p in view["positions"]] == ["COMI"] and view["last_date"] == DAYS[34]
    assert view["id"] == run["id"]


def test_a_stock_whose_data_stays_behind_does_not_stall_the_run_for_ever(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    load(c, "TMGH", bars(FLAT))
    start(c, strategy(c, ["COMI", "TMGH"]))
    load(c, "COMI", bars(FLAT + [11, 12, 13]))            # TMGH is 3 sessions behind: the run waits for it
    assert process(c)["fills"] == 0
    load(c, "COMI", bars(FLAT + [11, 12, 13, 14, 15, 16, 17]))   # 7 behind: set aside, with a note
    assert process(c)["fills"] == 1
    view = c.get("/api/v1/paper-runs").json()[0]
    assert [p["symbol"] for p in view["positions"]] == ["COMI"]
    assert any("TMGH has no data after" in n for n in view["notes"])


def test_runs_move_through_the_sessions_together(tmp_path):
    """Two runs, both four sessions behind: neither may make the other skip a day, whichever is handled first."""
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    load(c, "TMGH", bars(FLAT))
    for sym in ("TMGH", "COMI"):                           # the run that trades later is created first
        start(c, strategy(c, [sym], name=f"S-{sym}"))
    load(c, "COMI", bars(FLAT + [11, 12, 13, 14]))         # rises from session 1: bought at the open of session 2
    load(c, "TMGH", bars(FLAT + [10, 10, 11, 12]))         # rises from session 3: bought at the open of session 4
    assert process(c)["fills"] == 2
    assert [(t["trade_date"], t["type"], t["symbol"]) for t in fills(c)] == [(DAYS[31], "BUY", "COMI"), (DAYS[33], "BUY", "TMGH")]
    assert process(c) == {"runs": 2, "fills": 0, "orders": []}           # idempotent


def test_a_manual_trade_lets_the_runs_catch_up_first(tmp_path):
    """A manual order dated the latest session, placed before the job has handled earlier sessions,
    must not make a run skip them (and with them a stop-loss)."""
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    load(c, "TMGH", bars(FLAT))
    start(c, strategy(c, ["COMI"], stop_loss_pct=10, max_alloc_pct=50))
    load(c, "COMI", bars(FLAT + [11, 12]))
    assert process(c)["fills"] == 1
    # two more sessions: COMI collapses through the stop on the first, then recovers
    load(c, "COMI", bars(FLAT + [11, 12]) + [(DAYS[32], 12, 12.1, 8.0, 9.0, 1000), (DAYS[33], 10.5, 11.5, 10.4, 11.0, 1000)])
    load(c, "TMGH", bars(FLAT + [10, 10, 10, 10]))
    manual = c.post("/api/v1/trades", json={"side": "BUY", "symbol": "TMGH", "qty": 10})
    assert manual.status_code == 201 and manual.json()["trade_date"] == DAYS[33]
    got = [(t["trade_date"], t["type"], t["symbol"], t["origin"].split(":")[0]) for t in fills(c)]
    assert got == [(DAYS[31], "BUY", "COMI", "strategy"), (DAYS[32], "SELL", "COMI", "strategy"), (DAYS[33], "BUY", "TMGH", "manual")]
    assert process(c)["fills"] == 0


def test_shares_sold_by_hand_leave_the_run_at_cost(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    start(c, strategy(c, ["COMI"], max_alloc_pct=50))
    load(c, "COMI", bars(FLAT + [11, 12]))
    assert process(c)["fills"] == 1
    buy = fills(c)[0]
    assert c.post("/api/v1/trades", json={"side": "SELL", "symbol": "COMI", "qty": buy["qty"]}).status_code == 201
    load(c, "COMI", bars(FLAT + [11, 12, 9, 8, 7]))       # an exit signal the run can no longer act on
    assert process(c)["fills"] == 0
    view = c.get("/api/v1/paper-runs").json()[0]
    assert view["positions"] == [] and view["pending_sell"] == []
    assert view["cash"] == pytest.approx(20000) and view["pnl"] == pytest.approx(0)      # back at cost: no phantom gain or loss
    assert any("sold outside this run" in n for n in view["notes"])
    assert not any("cannot sell" in n for n in view["notes"])                             # and no failing sell retried each session


def test_a_partial_manual_sale_reduces_the_run_position(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    start(c, strategy(c, ["COMI"], max_alloc_pct=50))
    load(c, "COMI", bars(FLAT + [11, 12]))
    process(c)
    qty = fills(c)[0]["qty"]
    c.post("/api/v1/trades", json={"side": "SELL", "symbol": "COMI", "qty": qty - 100})
    load(c, "COMI", bars(FLAT + [11, 12, 9, 8, 7]))       # the averages cross down at the 8 close; filled at the next open
    assert process(c)["fills"] == 1
    sell = fills(c)[-1]
    assert sell["type"] == "SELL" and sell["qty"] == 100 and sell["remaining_qty"] == 0
    assert c.get("/api/v1/portfolio").json()["holdings"] == []


def test_run_capital_is_set_aside_and_one_stock_has_one_owner(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    load(c, "TMGH", bars(FLAT))
    st = strategy(c, ["COMI", "TMGH"], max_alloc_pct=40)
    start(c, st, capital=30000)
    # 50,000 in cash, 30,000 already promised: a second run cannot be given 30,000 as well
    again = c.post("/api/v1/paper-runs", json={"strategy_id": st["id"], "capital": 30000})
    assert again.status_code == 422 and "20,000.00" in again.json()["detail"]
    start(c, st, capital=20000)
    # the user holds TMGH by hand: neither run buys it; COMI goes to the older run only
    c.post("/api/v1/trades", json={"side": "BUY", "symbol": "TMGH", "qty": 50})
    load(c, "COMI", bars(FLAT + [11, 12]))
    load(c, "TMGH", bars(FLAT + [11, 12]))
    assert process(c)["fills"] == 1
    newer, older = c.get("/api/v1/paper-runs").json()
    assert [p["symbol"] for p in older["positions"]] == ["COMI"] and newer["positions"] == []
    assert any("already holds it outside this run" in n for n in older["notes"] + newer["notes"])
    held = {h["symbol"]: h["qty"] for h in c.get("/api/v1/portfolio").json()["holdings"]}
    assert held == {"COMI": older["positions"][0]["qty"], "TMGH": 50}


def test_paper_run_and_backtest_agree_on_a_tenth_of_a_piastre_stock(tmp_path):
    """Same fills from both engines, at four-decimal prices, when a run catches up many sessions at once."""
    closes = [0.25] * 30 + [0.254, 0.258, 0.262, 0.27, 0.28, 0.275, 0.262, 0.25, 0.24, 0.245, 0.26, 0.275, 0.29, 0.30, 0.28, 0.26]
    rows, prev = [], closes[0]
    for d, close in zip(DAYS, closes, strict=False):                                        # open = previous close
        rows.append((d, prev, round(max(prev, close) * 1.02, 4), round(min(prev, close) * 0.985, 4), close, 5000))
        prev = close
    c = client(tmp_path)
    load(c, "LOWP", rows[:30], name="Low priced")
    st = strategy(c, ["LOWP"], stop_loss_pct=6, max_alloc_pct=50, slippage_bps=10)
    start(c, st, capital=20000)
    load(c, "LOWP", rows)                                   # sixteen sessions arrive together
    process(c)
    bt = c.post("/api/v1/backtests", json={"strategy_id": st["id"], "start": DAYS[29], "capital": 20000}).json()
    run_fills = fills(c)
    assert run_fills, "the scenario must trade"
    expected = []
    for t in bt["trades"]:
        expected += [("BUY", t["entry_date"], t["entry_price"], t["qty"]), ("SELL", t["exit_date"], t["exit_price"], t["qty"])]
    expected += [("BUY", p["entry_date"], p["entry_price"], p["qty"]) for p in bt["open_positions"]]
    assert sorted((t["type"], t["trade_date"], t["price"], t["qty"]) for t in run_fills) == sorted(expected)
    assert any(round(t["price"] * 100) != t["price"] * 100 for t in run_fills)             # not rounded to whole piastres
    view = c.get("/api/v1/paper-runs").json()[0]
    ledger = c.get("/api/v1/trades").json()["totals"]
    assert view["realized_net"] == pytest.approx(ledger["realized_net"]) and view["fees"] == pytest.approx(ledger["fees_paid"])
    for p in view["positions"]:                             # gross P/L of an open position is before fees
        assert p["gross_pnl"] == pytest.approx(p["value"] - round(p["entry_price"] * p["qty"], 2))


def test_resuming_an_active_run_changes_nothing_and_a_stopped_run_keeps_its_result(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT))
    run = start(c, strategy(c, ["COMI"], max_alloc_pct=50))
    load(c, "COMI", bars(FLAT + [11, 12, 13]))
    # "active" on an active run is not a resume: it must not jump past sessions waiting to be handled
    same = c.put(f"/api/v1/paper-runs/{run['id']}", json={"status": "active"}).json()
    assert same["last_date"] == DAYS[29]
    assert process(c)["fills"] == 1
    before = c.get("/api/v1/paper-runs").json()[0]
    stopped = c.put(f"/api/v1/paper-runs/{run['id']}", json={"status": "stopped"}).json()
    assert stopped["positions"] == {} and stopped["released"][0]["symbol"] == "COMI"
    load(c, "COMI", bars(FLAT + [11, 12, 13, 20, 30]))    # later prices do not rewrite a finished run
    after = c.get("/api/v1/paper-runs").json()[0]
    assert after["value"] == before["value"] and after["pnl"] == before["pnl"] and after["positions"] == []
    assert c.get("/api/v1/portfolio").json()["holdings"][0]["symbol"] == "COMI"           # the shares stay, as ordinary holdings


# =============================================================================
# market data and time
# =============================================================================
def sessions(n, end):
    out, d = [], end
    while len(out) < n:
        if is_trading_day(d):
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out[::-1]


class FakeFeed:
    """Stands in for the Younit client: explicit bars per stock, changeable between calls."""

    def __init__(self, listing=("COMI",)):
        self.listing = [{"symbol": s, "name": s, "stock_id": i + 1} for i, s in enumerate(listing)]
        self.bars: dict[int, list] = {}
        self.quotes: dict[str, list] = {}
        self.history_calls: list = []

    def snapshot(self):
        return {"fields": [], "stocks": [{**s, "last": None, "open": None, "high": None, "low": None, "volume": None}
                                         for s in self.listing]}

    def daily_history(self, stock_id, date_from, date_to):
        self.history_calls.append((stock_id, date_from, date_to))
        return [r for r in self.bars.get(stock_id, []) if date_from.isoformat() <= r[0] <= date_to.isoformat()]

    def live(self, stocks, timeout=8.0):
        return {"quotes": {s["symbol"]: self.quotes[s["symbol"]] for s in stocks if s["symbol"] in self.quotes},
                "sectors": {}, "indices": [], "errors": [], "answered": len(stocks)}


def rising(upto="2026-11-12"):
    """37 flat sessions at 100, then 102, 104, 106 on Tue 10, Wed 11, Thu 12 Nov 2026."""
    days = sessions(40, date(2026, 11, 12))
    rows, prev = [], 100.0
    for d, close in zip(days, [100.0] * 37 + [102.0, 104.0, 106.0], strict=True):
        rows.append([d, prev, max(prev, close) + 0.5, min(prev, close) - 0.5, close, 1000.0])
        prev = close
    return [r for r in rows if r[0] <= upto]


def test_todays_candle_is_not_a_completed_session_and_an_old_snapshot_does_not_outlive_the_close(tmp_path, clock):
    """Sunday 15 Nov 2026. The history feed already has a candle for the running session at 11:00.
    The run must not treat it as final: the stock later falls through the stop, and the stop must fire."""
    fake = FakeFeed()
    c = client(tmp_path, younit=fake)
    clock(2026, 11, 9, 18)
    fake.bars[1] = rising("2026-11-09")
    c.post("/api/v1/data/refresh")
    start(c, strategy(c, ["COMI"], stop_loss_pct=5, max_alloc_pct=50))
    clock(2026, 11, 12, 18)
    fake.bars[1] = rising()
    assert c.get("/api/v1/status").json()["provider"]["refresh_due"] is True       # sessions closed since the last read
    c.post("/api/v1/data/refresh")
    assert process(c)["fills"] == 1 and fills(c)[0]["price"] == 102.0             # bought Wed at the open

    clock(2026, 11, 15, 11)                                                        # Sunday, mid-session
    fake.bars[1] = rising() + [["2026-11-15", 106.0, 106.5, 105.5, 106.2, 500.0]]  # a candle dated today, still forming
    fake.quotes = {"COMI": [106.2, 106.0, 106.5, 105.5, 500.0]}
    assert c.post("/api/v1/data/refresh").json()["updated"] == 0                   # history is read once per close, not mid-session
    assert c.post("/api/v1/data/live").json()["updated"] is True
    assert process(c)["fills"] == 0
    assert c.get("/api/v1/paper-runs").json()[0]["last_date"] == "2026-11-12"      # Sunday is not done yet
    quote = c.get("/api/v1/stocks/COMI").json()
    assert quote["quote"]["last"] == 106.2 and quote["quote"]["live"] is True and quote["quote"]["as_of"] == "2026-11-15"
    assert c.get("/api/v1/signals").json() == [] or all(s["date"] <= "2026-11-12" for s in c.get("/api/v1/signals").json())

    clock(2026, 11, 15, 16)                                                        # after the close: it fell to 80, closed at 82
    fake.bars[1] = rising() + [["2026-11-15", 106.0, 106.5, 80.0, 82.0, 9000.0]]
    stale = c.get("/api/v1/stocks/COMI").json()                                    # final bar not read yet: the snapshot shows,
    assert stale["quote"]["live"] is False and "Last price seen today" in stale["data_note"]   # but it is not called live
    assert c.get("/api/v1/status").json()["provider"]["refresh_due"] is True       # an after-close visit fetches the final bars
    assert c.post("/api/v1/data/refresh").json()["updated"] == 1
    final = c.get("/api/v1/stocks/COMI").json()
    assert final["quote"]["last"] == 82.0 and final["quote"]["live"] is False      # the 11:00 snapshot no longer overrides the close
    assert process(c)["fills"] == 1
    sell = fills(c)[-1]
    assert (sell["type"], sell["trade_date"], sell["price"], "stop-loss" in sell["note"]) == ("SELL", "2026-11-15", 96.9, True)
    assert c.get("/api/v1/status").json()["provider"]["refresh_due"] is False


def test_a_partial_live_poll_keeps_the_prices_seen_earlier_today(tmp_path, clock):
    fake = FakeFeed(("COMI", "TMGH"))
    fake.bars = {1: rising(), 2: [[r[0], *[v * 2 for v in r[1:5]], r[5]] for r in rising()]}
    c = client(tmp_path, younit=fake)
    clock(2026, 11, 12, 18)
    c.post("/api/v1/data/refresh")
    c.post("/api/v1/trades", json={"side": "BUY", "symbol": "TMGH", "qty": 100})
    c.post("/api/v1/alerts", json={"kind": "price_below", "symbol": "TMGH", "value": 213})
    clock(2026, 11, 15, 11)
    fake.quotes = {"COMI": [107.0, 106.0, 107.5, 105.5, 500.0], "TMGH": [215.0, 212.0, 216.0, 211.0, 800.0]}
    c.post("/api/v1/data/live")
    value = c.get("/api/v1/portfolio").json()["summary"]["total_value"]
    clock(2026, 11, 15, 11, 1)
    fake.quotes = {"COMI": [107.5, 106.0, 107.5, 105.5, 600.0]}                    # TMGH's answer is late this time
    assert c.post("/api/v1/data/live").json()["updated"] is True
    rows = {r["symbol"]: r for r in c.get("/api/v1/stocks").json()}
    assert rows["TMGH"]["last"] == 215.0 and rows["COMI"]["last"] == 107.5         # not thrown back to Thursday's 212
    assert c.get("/api/v1/portfolio").json()["summary"]["total_value"] == value
    assert c.post("/api/v1/alerts/check").json()["triggered"] == []               # and no false alert


def test_a_held_stock_that_leaves_the_feed_is_still_valued_and_can_be_sold(tmp_path, clock):
    fake = FakeFeed(("COMI", "TMGH"))
    fake.bars = {1: rising(), 2: rising()}
    c = client(tmp_path, younit=fake)
    clock(2026, 11, 12, 18)
    c.post("/api/v1/data/refresh")
    assert c.post("/api/v1/trades", json={"side": "BUY", "symbol": "TMGH", "qty": 100}).status_code == 201
    clock(2026, 11, 15, 18)
    fake.listing = fake.listing[:1]                                                # TMGH is no longer listed by the feed
    fake.bars[1] = rising() + [["2026-11-15", 106.0, 108.0, 105.0, 107.0, 900.0]]
    out = c.post("/api/v1/data/refresh").json()
    assert (out["updated"], out["remaining"], out["total"], out["stalled"]) == (1, 0, 1, False)
    pf = c.get("/api/v1/portfolio")
    assert pf.status_code == 200
    holding = pf.json()["holdings"][0]
    assert holding["symbol"] == "TMGH" and holding["last"] == 106.0 and holding["as_of"] == "2026-11-12"
    assert any("no longer in the market feed" in w for w in pf.json()["warnings"])
    sold = c.post("/api/v1/trades", json={"side": "SELL", "symbol": "TMGH", "qty": 100})
    assert sold.status_code == 201 and sold.json()["price"] == "106.0000"
    assert sold.json()["trade_date"] == "2026-11-15" and sold.json()["price_date"] == "2026-11-12"
    assert c.get("/api/v1/stocks/TMGH/depth").status_code == 404                   # nothing live is asked of the feed for it
    assert c.get("/api/v1/status").json()["provider"]["symbols"] == 1


def test_a_holding_without_any_price_does_not_break_the_portfolio(tmp_path):
    c = client(tmp_path, sample=True)
    c.post("/api/v1/trades", json={"side": "BUY", "symbol": "COMI", "qty": 10})
    core = App(Store(tmp_path / "t.sqlite3"), Settings(data_dir=tmp_path, seed_sample_data=False)).bootstrap()
    pf = core.portfolio()                                                          # sample prices switched off: COMI has no price
    assert pf["holdings"][0]["priced"] is False and pf["holdings"][0]["market_value"] == pf["holdings"][0]["cost"]
    assert any("no price data" in w for w in pf["warnings"])


def test_refresh_is_due_once_after_every_close(tmp_path):
    store, fake = Store(tmp_path / "f.sqlite3"), FakeFeed()
    fake.bars[1] = rising()
    feed = Feed(StoreDocs(store))
    thu = datetime(2026, 11, 12, 9, 0, tzinfo=CAIRO)
    assert feed.summary(thu.date(), now=thu)["refresh_due"] is True                 # nothing loaded yet
    feed.refresh(fake, today=thu.date(), now=thu)
    assert feed.summary(thu.date(), now=thu.replace(hour=14))["refresh_due"] is False   # same session: nothing new to read
    after_close = thu.replace(hour=15, minute=5)
    assert feed.summary(thu.date(), now=after_close)["refresh_due"] is True         # the old "once per day" rule missed this
    fake.history_calls.clear()
    assert feed.refresh(fake, today=thu.date(), now=after_close)["updated"] == 1
    assert fake.history_calls[0][1] == date(2026, 11, 5)                            # only the recent tail is asked for
    for when in (after_close, datetime(2026, 11, 14, 12, 0, tzinfo=CAIRO)):         # Thursday night to Saturday: quiet
        assert feed.summary(when.date(), now=when)["refresh_due"] is False
        assert feed.refresh(fake, today=when.date(), now=when)["updated"] == 0
    assert len(fake.history_calls) == 1
    assert last_settle(datetime(2026, 11, 15, 14, 59, tzinfo=CAIRO)).date() == date(2026, 11, 12)
    assert last_settle(datetime(2026, 11, 15, 15, 0, tzinfo=CAIRO)).date() == date(2026, 11, 15)


def test_a_rate_limit_pauses_the_update_instead_of_failing_it(tmp_path, clock):
    """The feed says "slow down" part-way through: keep what arrived, stop asking, carry on after the pause."""
    import httpx

    from app.data.younit import YounitClient, YounitRateLimit
    names = [f"S{i:02d}" for i in range(12)]

    class Busy(FakeFeed):
        limit_after = 5
        snapshots = 0

        def snapshot(self):
            self.snapshots += 1
            return super().snapshot()

        def daily_history(self, stock_id, date_from, date_to):
            if len(self.history_calls) >= self.limit_after:
                raise YounitRateLimit(30)
            return super().daily_history(stock_id, date_from, date_to)

    fake = Busy(names)
    fake.bars = {i + 1: rising() for i in range(12)}
    c = client(tmp_path, younit=fake)
    clock(2026, 11, 12, 18)
    first = c.post("/api/v1/data/refresh").json()
    assert first["rate_limited"] is True and first["retry_after"] == 30 and first["stalled"] is False
    assert first["updated"] == 5 and first["remaining"] == 7 and first["errors"] == []     # nothing lost, nothing alarming
    assert len(c.get("/api/v1/stocks").json()) == 5
    fake.limit_after = 10**6
    second = c.post("/api/v1/data/refresh").json()
    assert second["updated"] == 7 and second["remaining"] == 0 and second["rate_limited"] is False
    assert fake.snapshots == 1                           # the stock list is read once per session, not once per batch
    assert len(fake.history_calls) == 12                 # and no stock was asked for twice
    # a rate limit on the very first call is answered as "wait", with how long
    fake.snapshot = lambda: (_ for _ in ()).throw(YounitRateLimit(45))
    clock(2026, 11, 15, 18)
    busy = c.post("/api/v1/data/refresh")
    assert busy.status_code == 429 and busy.json()["retry_after"] == 45 and busy.headers["retry-after"] == "45"

    def handler(req):
        if "token" in req.url.path:
            return httpx.Response(200, json={"accessToken": "t", "expiresIn": 3600, "tokenType": "Bearer"})
        return httpx.Response(429, headers={"Retry-After": "20"})
    YounitClient._tokens.clear()
    with pytest.raises(YounitRateLimit) as info:
        YounitClient("tid", "key", transport=httpx.MockTransport(handler)).stocks()
    assert info.value.retry_after == 20 and "rate limit" in str(info.value)


class GuardedDocs:
    """Shared documents with versions, like the deployed store: a guarded write of a stale version is refused."""

    def __init__(self, shared: dict):
        self.shared, self.seen = shared, {}

    def get(self, id):
        version, doc = self.shared.get(id, (0, None))
        self.seen[id] = version
        return copy.deepcopy(doc)

    def put(self, id, doc, *, guard=False):
        version = self.shared.get(id, (0, None))[0]
        if guard and id in self.seen and self.seen[id] != version:
            raise ConflictError("changed meanwhile")
        self.shared[id] = (version + 1, copy.deepcopy(doc))
        self.seen[id] = version + 1


def test_two_refreshes_at_once_keep_each_others_history():
    """Two stocks that live in the same chunk document, loaded for the first time by two requests at once."""
    names = [f"S{i:03d}" for i in range(200)]
    x = names[0]
    y = next(n for n in names[1:] if chunk_of(n) == chunk_of(x))
    now = datetime(2026, 11, 12, 18, 0, tzinfo=CAIRO)
    shared: dict = {}

    class Slow(FakeFeed):
        def daily_history(self, stock_id, date_from, date_to):
            rows = super().daily_history(stock_id, date_from, date_to)
            if stock_id == 1 and not self.raced:   # while this request waits for the feed, another one saves the chunk
                self.raced = True
                other = FakeFeed((x, y))
                other.bars = self.bars
                Feed(GuardedDocs(shared)).refresh(other, today=now.date(), now=now)
            return rows

    fake = Slow((x, y))
    fake.raced = False
    fake.bars = {1: rising(), 2: rising()}
    out = Feed(GuardedDocs(shared)).refresh(fake, today=now.date(), now=now)
    assert out["updated"] == 2 and out["remaining"] == 0
    chunk, index = shared[chunk_of(x)][1], shared["index"][1]
    assert len(chunk["bars"][x]) == 40 and len(chunk["bars"][y]) == 40
    assert index["last_dates"] == {x: "2026-11-12", y: "2026-11-12"} and index["version"] == 2
    # Even if a chunk did lose a stock's bars, the next read asks for the whole history again,
    # because the starting point comes from the bars actually held, not from a date noted in the index.
    version, doc = shared[chunk_of(x)]
    doc["bars"][x] = []
    shared[chunk_of(x)] = (version + 1, doc)
    later = datetime(2026, 11, 15, 16, 0, tzinfo=CAIRO)
    again = FakeFeed((x, y))
    again.bars = {1: rising(), 2: rising()}
    Feed.reset()
    Feed(GuardedDocs(shared)).refresh(again, today=later.date(), now=later)
    asked = {stock_id: date_from for stock_id, date_from, _ in again.history_calls}
    assert asked[1] < date(2024, 1, 1) and asked[2] == date(2026, 11, 5)
    assert len(shared[chunk_of(x)][1]["bars"][x]) == 40


def test_feed_readings_that_must_not_be_taken_at_face_value(monkeypatch):
    import httpx

    from app.data import stream
    from app.data.younit import YounitClient, candle_date, tick_quote
    # a candle stamped with Cairo midnight written in UTC belongs to the Cairo day, not the day before
    assert candle_date("2026-11-14T22:00:00Z") == "2026-11-15"
    assert candle_date("2026-07-14T21:00:00+00:00") == "2026-07-15"            # summer time: UTC+3
    assert candle_date("2026-11-15T00:00:00") == "2026-11-15" and candle_date("2026-11-15") == "2026-11-15"
    assert candle_date("bad") is None and candle_date(None) is None
    # before the first trade the last-trade field may still hold the previous session's price
    assert tick_quote({"m_LastTradePrice": "80.5", "m_TradedVolume": "0"})["last"] is None
    assert tick_quote({"m_LastTradePrice": "80.5", "m_TradedVolume": "1200"})["last"] == 80.5
    assert tick_quote({"m_LastTradePrice": "80.5"})["last"] == 80.5                 # no volume field at all: taken as given

    def token(req):
        return httpx.Response(200, json={"accessToken": "t", "expiresIn": 3600, "tokenType": "Bearer"})
    YounitClient._tokens.clear()
    younit = YounitClient("tid", "key", transport=httpx.MockTransport(token))
    monkeypatch.setattr(stream, "snapshot", lambda *a, **k: {"errors": [], "values": {
        "sy1": {"m_LastTradePrice": "80.5", "m_TradedVolume": "0", "m_SectorName": "Banks"},
        "sy2": {"m_LastTradePrice": "60", "m_OpenPrice": "59", "m_DailyHighPrice": "61", "m_DailyLowPrice": "58", "m_TradedVolume": "900"}}})
    got = younit.live([{"symbol": "COMI", "stock_id": 1}, {"symbol": "TMGH", "stock_id": 2}])
    assert got["quotes"] == {"TMGH": [60.0, 59.0, 61.0, 58.0, 900.0]} and got["sectors"] == {"COMI": "Banks"}


# =============================================================================
# manual trades and money
# =============================================================================
def test_a_stock_with_no_bar_in_the_latest_session_can_still_be_traded(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT + [11]))                     # traded in the latest session
    load(c, "TMGH", bars(FLAT))                            # last traded the session before
    assert c.post("/api/v1/trades", json={"side": "BUY", "symbol": "COMI", "qty": 10}).json()["trade_date"] == DAYS[30]
    preview = c.post("/api/v1/trades/preview", json={"side": "BUY", "symbol": "TMGH", "qty": 10}).json()
    assert preview["error"] is None and preview["trade_date"] == DAYS[30] and preview["price_date"] == DAYS[29]
    done = c.post("/api/v1/trades", json={"side": "BUY", "symbol": "TMGH", "qty": 10})
    assert done.status_code == 201, done.text              # used to be refused as "before the last recorded trade"
    tx = done.json()
    assert tx["trade_date"] == DAYS[30] and tx["price_date"] == DAYS[29] and tx["price"] == "10.0000" and tx["backdated"] is False
    # a back-dated order: the preview and the order give the same answer
    body = {"side": "BUY", "symbol": "TMGH", "qty": 10, "trade_date": DAYS[20]}
    refused = c.post("/api/v1/trades", json=body)
    assert refused.status_code == 422 and "chronological" in refused.json()["detail"]
    assert c.post("/api/v1/trades/preview", json=body).json()["error"] == refused.json()["detail"]
    row = next(t for t in c.get("/api/v1/trades").json()["transactions"] if t["symbol"] == "TMGH")
    assert row["price_date"] == DAYS[29] and row["backdated"] is False


def test_a_back_dated_trade_is_marked(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT + [11, 12]))
    tx = c.post("/api/v1/trades", json={"side": "BUY", "symbol": "COMI", "qty": 10, "trade_date": DAYS[10]}).json()
    assert tx["backdated"] is True and tx["trade_date"] == DAYS[10]
    assert c.get("/api/v1/trades").json()["transactions"][0]["backdated"] is True


def test_share_prices_keep_tenths_of_a_piastre(tmp_path):
    c = client(tmp_path)
    days = DAYS[:32]
    rows = [(d, 0.827, 0.84, 0.82, 0.827, 9000) for d in days[:31]] + [(days[31], 0.83, 0.84, 0.826, 0.835, 9000)]
    load(c, "LOWP", rows[:31], name="Low priced")
    c.post("/api/v1/trades", json={"side": "BUY", "symbol": "LOWP", "qty": 10000})
    holding = c.get("/api/v1/portfolio").json()["holdings"][0]
    assert holding["avg_price"] == 0.827 and holding["last"] == 0.827 and holding["cost"] == 8270.0
    load(c, "LOWP", rows)
    c.post("/api/v1/trades", json={"side": "SELL", "symbol": "LOWP", "qty": 5000})
    sell = c.get("/api/v1/trades").json()["transactions"][0]
    assert sell["price"] == 0.835 and sell["avg_cost"] == 0.827
    assert sell["realized_gross"] == pytest.approx((sell["price"] - sell["avg_cost"]) * 5000)   # reconciles on screen


def test_ledger_rows_add_up_to_the_totals_to_the_piastre():
    schedule = DEFAULT_FEE_SCHEDULE
    txs = [{"type": "DEPOSIT", "amount": "1000000"}]
    rng = __import__("random").Random(7)
    held = 0
    for _ in range(120):
        price = Decimal(rng.randint(8000, 9000)) / 10000          # around 0.85: awkward divisions
        if held and rng.random() < 0.6:
            qty = rng.randint(1, held)
            side, held = "SELL", held - qty
        else:
            qty = rng.randint(1, 3000)
            side, held = "BUY", held + qty
        gross = money(price * qty)
        txs.append({"type": side, "symbol": "X", "qty": qty, "price": str(price), "gross": str(gross),
                    "fees_total": str(money(gross * Decimal("0.00305")))})
    state = replay(txs)
    sells = [r for r in state.rows if r["type"] == "SELL"]
    assert len(sells) > 20
    assert sum(r["realized_gross"] for r in sells) == state.realized_gross == money(state.realized_gross)
    assert sum(r["realized_net"] for r in sells) == state.realized_net
    pos = state.positions["X"]
    assert pos.cost >= 0 and pos.buy_fees >= 0 and (pos.qty > 0 or (pos.cost == 0 and pos.buy_fees == 0))
    # everything paid in equals everything accounted for
    assert state.cash == D("1000000") - state.buys_gross + state.sells_gross - state.fees_paid
    assert state.buys_gross - pos.cost + state.realized_gross == state.sells_gross
    assert schedule is not None


def test_portfolio_history_matches_a_full_replay_for_every_day(tmp_path):
    c = client(tmp_path)
    load(c, "COMI", bars(FLAT + [11, 12, 13, 12, 14]))
    load(c, "TMGH", bars([20.0] * 30 + [21, 22, 21, 23, 24]))
    orders = [("BUY", "COMI", 500, DAYS[30]), ("BUY", "TMGH", 200, DAYS[31]), ("SELL", "COMI", 200, DAYS[32]),
              ("BUY", "TMGH", 100, DAYS[33]), ("SELL", "TMGH", 300, DAYS[34])]
    for side, symbol, qty, day in orders:
        assert c.post("/api/v1/trades", json={"side": side, "symbol": symbol, "qty": qty, "trade_date": day}).status_code == 201
    curve = c.get("/api/v1/portfolio").json()["history"]["curve"]
    txs = list(reversed(c.get("/api/v1/trades").json()["transactions"]))
    closes = {"COMI": dict(zip(DAYS, FLAT + [11, 12, 13, 12, 14], strict=False)), "TMGH": dict(zip(DAYS, [20.0] * 30 + [21, 22, 21, 23, 24], strict=False))}
    assert [p["date"] for p in curve] == DAYS[30:35]
    for point in curve:
        cash = 50000.0 + sum(t["cash_delta"] for t in txs if t["trade_date"] and t["trade_date"] <= point["date"])
        qty: dict = {}
        for t in txs:
            if t["trade_date"] and t["trade_date"] <= point["date"]:
                qty[t["symbol"]] = qty.get(t["symbol"], 0) + (t["qty"] if t["type"] == "BUY" else -t["qty"])
        assert point["value"] == pytest.approx(cash + sum(q * closes[s][point["date"]] for s, q in qty.items()))
    assert curve[-1]["value"] == c.get("/api/v1/portfolio").json()["summary"]["total_value"]


# =============================================================================
# everything else
# =============================================================================
def test_buy_and_hold_does_not_jump_when_a_stock_lists_later():
    idx = pd.bdate_range("2025-01-01", periods=20)
    a = pd.DataFrame({"open": 10.0, "high": 20.5, "low": 9.5, "close": [10 + i * 0.5 for i in range(20)], "volume": 1e4}, index=idx)
    b = pd.DataFrame({"open": 5.0, "high": 5.1, "low": 4.9, "close": 5.0, "volume": 1e4}, index=idx[10:])
    cfg = StrategyConfig(name="t", type="sma_cross", params={"fast": 2, "slow": 5})
    out = run_backtest(cfg, {"A": a, "B": b}, DEFAULT_FEE_SCHEDULE, start=None, end=None, capital=100000)
    curve = [p["equity"] for p in out["buy_and_hold"]["curve"]]
    steps = [later - earlier for earlier, later in zip(curve, curve[1:], strict=False)]
    assert min(steps) >= 0                                  # A only ever rises and B is flat: no drop on B's first day
    assert curve[-1] == pytest.approx(100000 * (1 + ((19.5 / 10 - 1) + 0) / 2))


def test_alerts_count_sessions_not_calendar_days_and_ignore_old_bars(tmp_path, clock):
    week = sessions(40, date(2026, 11, 12))
    c = client(tmp_path)
    load(c, "COMI", bars([10.0] * 39 + [11.0], week))                         # +10% on Thursday 12 Nov
    load(c, "TMGH", bars([10.0] * 29 + [11.0], week[:30]))                    # +10% on its last bar, weeks ago
    rows = bars([10.0] * 40, week)
    load(c, "SWDY", rows[:-1] + [(*rows[-1][:5], 3000)])                      # 3x the volume of the 20 sessions before
    clock(2026, 11, 12, 15)
    c.post("/api/v1/alerts", json={"kind": "change_pct_above", "symbol": "COMI", "value": 5})
    c.post("/api/v1/alerts", json={"kind": "change_pct_above", "symbol": "TMGH", "value": 5})
    vol = c.post("/api/v1/alerts", json={"kind": "volume_ratio_above", "symbol": "SWDY", "value": 3}).json()
    fired = c.post("/api/v1/alerts/check").json()["triggered"]
    assert {e["symbol"] for e in fired} == {"COMI", "SWDY"}                   # TMGH's move is weeks old: not "today"
    assert next(e for e in fired if e["symbol"] == "SWDY")["observed"] == pytest.approx(3.0)
    assert c.get("/api/v1/stocks/SWDY").json()["assessment"]["volume_ratio"] == pytest.approx(3.0)
    for day, hour in ((13, 10), (14, 10), (15, 9)):                           # Friday, Saturday, Sunday before the open
        clock(2026, 11, day, hour)
        assert c.post("/api/v1/alerts/check").json()["triggered"] == []      # Thursday's move is reported once
    # editing an alert arms it again
    c.put(f"/api/v1/alerts/{vol['id']}", json={"kind": "volume_ratio_above", "symbol": "SWDY", "value": 2.5})
    assert [e["symbol"] for e in c.post("/api/v1/alerts/check").json()["triggered"]] == ["SWDY"]


def test_day_figures_and_signals_use_the_latest_session_only(tmp_path, clock):
    week = sessions(40, date(2026, 11, 12))
    c = client(tmp_path)
    load(c, "COMI", bars([10.0] * 39 + [11.0], week))
    load(c, "TMGH", bars([10.0] * 29 + [11.0], week[:30]))                    # a cross-up on a bar from weeks ago
    clock(2026, 11, 15, 12)
    by_sector = {s["sector"]: s for s in c.get("/api/v1/market/sectors").json()}
    assert by_sector["Banks"]["day_pct"] == pytest.approx(10) and by_sector["Banks"]["traded"] == 1
    assert by_sector["Real Estate"]["day_pct"] is None and by_sector["Real Estate"]["best"] is None
    assert by_sector["Real Estate"]["stocks"] == 1 and by_sector["Real Estate"]["traded"] == 0
    stale = next(r for r in c.get("/api/v1/stocks").json() if r["symbol"] == "TMGH")
    assert stale["current"] is False and stale["as_of"] == week[29]
    st = strategy(c, ["COMI", "TMGH"])
    assert [(s["symbol"], s["date"]) for s in c.get("/api/v1/signals").json()] == [("COMI", week[-1])]
    c.post("/api/v1/alerts", json={"kind": "strategy_signal", "strategy_id": st["id"]})
    out = c.post("/api/v1/alerts/check").json()["triggered"]
    assert len(out) == 1 and "COMI (entry)" in out[0]["message"] and "TMGH" not in out[0]["message"]


def test_csv_dates_use_one_format_for_the_whole_file(tmp_path):
    c = client(tmp_path)

    def post(lines):
        text = "date,open,high,low,close,volume\n" + "".join(f"{d},10,10.5,9.5,10,1000\n" for d in lines)
        return c.post("/api/v1/data/bars/import", data={"symbol": "COMI"}, files={"file": ("x.csv", text, "text/csv")})

    # month/day/year, 2 Jan .. 10 Feb 2025: used to be stored as 13 Jan .. 2 Oct
    us = [f"{d:%m/%d/%Y}" for d in pd.bdate_range("2025-01-02", "2025-02-10")]
    r = post(us)
    assert r.status_code == 200 and (r.json()["first_date"], r.json()["last_date"]) == ("2025-01-02", "2025-02-10")
    eu = [f"{d:%d/%m/%Y}" for d in pd.bdate_range("2025-01-02", "2025-02-10")]
    assert post(eu).json()["last_date"] == "2025-02-10"
    # every date fits both readings: refused rather than guessed
    r = post(["03/04/2025", "05/06/2025", "07/08/2025"])
    assert r.status_code == 422 and "YYYY-MM-DD" in r.json()["detail"]
    # two formats in one file, and plain rubbish
    assert post(["2025-01-02", "03/01/2025"]).status_code == 422
    r = post(["2025-01-02", "soon"])
    assert r.status_code == 422 and "line 3" in r.json()["detail"]
    assert post(["2025-01-02", "2025-01-03"]).status_code == 200 and post(["20250102", "20250103"]).status_code == 200


def test_weekly_and_monthly_bars_are_dated_with_their_last_session():
    idx = pd.DatetimeIndex(sessions(8, date(2026, 11, 15)))                    # ... Thu 12 Nov, Sun 15 Nov
    df = pd.DataFrame({"open": 1.0, "high": 2.0, "low": 0.5, "close": [float(i) for i in range(8)], "volume": 10.0}, index=idx)
    df.index.name = "date"
    weekly, monthly = ind.resample(df, "w"), ind.resample(df, "m")
    assert weekly.index[-1] == pd.Timestamp("2026-11-15") and weekly.index[-2] == pd.Timestamp("2026-11-12")
    assert monthly.index[-1] == pd.Timestamp("2026-11-15")                     # not 30 November, which has not happened
    assert weekly["close"].iloc[-1] == 7.0 and weekly["volume"].iloc[-2] == 50.0


def test_rsi_is_wilders_and_a_flat_series_is_neutral():
    close = pd.Series([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
                       46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18])
    out = ind.rsi(close)
    assert out.iloc[:14].isna().all()
    # the worked example every textbook uses
    assert [round(v, 2) for v in out.iloc[14:20]] == [70.46, 66.25, 66.48, 69.35, 66.29, 57.92]
    assert ind.rsi(pd.Series([10.0] * 40)).iloc[-1] == 50.0
    assert ind.rsi(pd.Series([float(i) for i in range(1, 41)])).iloc[-1] == 100.0


def test_a_huge_backtest_is_still_small_enough_to_store():
    trade = {"symbol": "COMI", "qty": 100, "entry_date": "2025-01-01", "entry_price": 10.0, "exit_date": "2025-01-05",
             "exit_price": 11.0, "exit_reason": "signal", "gross_pnl": 100.0, "fees": 6.1, "net_pnl": 93.9, "return_pct": 9.3}
    curve = [{"date": f"2025-{1 + i // 28 % 12:02d}-{1 + i % 28:02d}", "equity": 50000.0 + i} for i in range(800)]
    doc = App._fit({"trades": [dict(trade, qty=i) for i in range(9000)], "equity_curve": list(curve), "warnings": [],
                    "benchmark": None, "buy_and_hold": {"curve": list(curve)}, "metrics": {"trades": 9000}})
    assert len(json.dumps(doc)) < 900_000
    assert doc["trades_total"] == 9000 and len(doc["trades"]) == 400 and doc["trades"][-1]["qty"] == 8999
    assert doc["metrics"]["trades"] == 9000 and "400 most recent of 9000" in doc["warnings"][-1]
    small = App._fit({"trades": [trade], "equity_curve": list(curve), "warnings": [], "benchmark": None, "buy_and_hold": None})
    assert small["warnings"] == [] and small["trades_total"] == 1 and len(small["equity_curve"]) == 800
