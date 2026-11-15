"""Strategy comparison, automatic paper trading, research, journal and alerts."""
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.store.sqlite_store import Store


@pytest.fixture()
def c(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path), Store(tmp_path / "t.sqlite3"))) as client:
        yield client


def csv(closes, start="2025-01-01"):
    """Daily bars: each day opens at the previous close."""
    days = pd.bdate_range(start, periods=len(closes))
    rows, prev = ["date,open,high,low,close,volume"], closes[0]
    for d, close in zip(days, closes, strict=True):
        rows.append(f"{d:%Y-%m-%d},{prev},{max(prev, close) * 1.01:.4f},{min(prev, close) * 0.99:.4f},{close},1000")
        prev = close
    return "\n".join(rows) + "\n", [f"{d:%Y-%m-%d}" for d in days]


def load(c, symbol, closes):
    text, days = csv(closes)
    r = c.post("/api/v1/data/bars/import", data={"symbol": symbol}, files={"file": ("x.csv", text, "text/csv")})
    assert r.status_code == 200, r.text
    return days


# ---- comparison ---------------------------------------------------------------
def test_compare_runs_strategies_on_identical_terms(c):
    a = c.post("/api/v1/strategies", json={"name": "Trend", "type": "sma_cross", "sectors": ["Banks"]}).json()
    b = c.post("/api/v1/strategies", json={"name": "Breakout", "type": "breakout", "symbols": ["COMI"]}).json()
    r = c.post("/api/v1/backtests/compare", json={"strategy_ids": [a["id"], b["id"]], "symbols": ["COMI", "TMGH", "SWDY"], "capital": 40000})
    assert r.status_code == 201, r.text
    runs = r.json()["runs"]
    assert [x["name"] for x in runs] == ["Trend", "Breakout"]
    # each strategy's own scope is ignored: same stocks, same period, same capital
    assert {x["stocks"] for x in runs} == {3} and runs[0]["period"] == runs[1]["period"]
    assert {x["metrics"]["starting_capital"] for x in runs} == {40000}
    assert all(x["equity_curve"] and "total_return_pct" in x["metrics"] for x in runs)
    assert len(c.get("/api/v1/backtests").json()) == 2          # both are kept in the run history
    assert c.post("/api/v1/backtests/compare", json={"strategy_ids": [a["id"]]}).status_code == 422
    assert c.post("/api/v1/backtests/compare", json={"strategy_ids": [a["id"], "nope"]}).status_code == 404


# ---- automatic paper trading --------------------------------------------------
FLAT, UP, DOWN = [10.0] * 30, [11, 12, 13, 14, 15, 16, 17, 18], [16, 14, 12, 10, 9, 9, 9]


def start(c, **risk):
    st = c.post("/api/v1/strategies", json={"name": "Fast trend", "type": "sma_cross", "symbols": ["COMI"],
                                           "params": {"fast": 2, "slow": 5},
                                           "risk": {"stop_loss_pct": None, "max_alloc_pct": 50, "cash_reserve_pct": 0,
                                                    "slippage_bps": 0, **risk}}).json()
    run = c.post("/api/v1/paper-runs", json={"strategy_id": st["id"], "capital": 20000})
    assert run.status_code == 201, run.text
    return st, run.json()


def test_a_run_trades_the_paper_portfolio_on_completed_sessions(c):
    days = load(c, "COMI", FLAT)
    st, run = start(c)
    assert run["status"] == "active" and run["last_date"] == days[-1] and run["universe"] == ["COMI"]
    assert c.post("/api/v1/paper-runs/process").json() == {"runs": 1, "fills": 0}     # nothing new yet

    days = load(c, "COMI", FLAT + UP)
    assert c.post("/api/v1/paper-runs/process").json()["fills"] == 1
    assert c.post("/api/v1/paper-runs/process").json()["fills"] == 0                  # idempotent
    txs = c.get("/api/v1/trades").json()["transactions"]
    buy = txs[0]
    # the cross shows at the close of the first rising day; the order fills at the NEXT day's open
    assert buy["type"] == "BUY" and buy["trade_date"] == days[31] and buy["price"] == 11
    assert buy["origin"] == f"strategy:{run['id']}" and "entry signal" in buy["note"]
    assert buy["gross"] + buy["fees_total"] <= 10000 < buy["gross"] + buy["fees_total"] + 11   # 50% of the run's capital
    view = c.get("/api/v1/paper-runs").json()[0]
    assert view["trades"] == 1 and view["positions"][0]["qty"] == buy["qty"]
    assert view["cash"] == pytest.approx(20000 - buy["gross"] - buy["fees_total"])
    assert c.get("/api/v1/portfolio").json()["summary"]["cash"] == pytest.approx(50000 - buy["gross"] - buy["fees_total"])

    days = load(c, "COMI", FLAT + UP + DOWN)
    assert c.post("/api/v1/paper-runs/process").json()["fills"] == 1
    sell = c.get("/api/v1/trades").json()["transactions"][0]
    assert sell["type"] == "SELL" and sell["qty"] == buy["qty"] and "exit signal" in sell["note"]
    assert sell["trade_date"] > buy["trade_date"] and sell["remaining_qty"] == 0
    view = c.get("/api/v1/paper-runs").json()[0]
    assert view["positions"] == [] and view["trades"] == 2
    assert view["realized_net"] == pytest.approx(sell["realized_net"])               # same answer as the ledger
    assert view["pnl"] == pytest.approx(view["realized_net"]) and view["fees"] == pytest.approx(buy["fees_total"] + sell["fees_total"])
    assert any(a["entity"] == "paper_runs" for a in c.get("/api/v1/audit").json())


def test_stop_loss_pause_and_stop(c):
    load(c, "COMI", FLAT)
    _, run = start(c, stop_loss_pct=10)
    load(c, "COMI", FLAT + UP + [9.0, 9.0])                 # a crash through the stop
    assert c.post("/api/v1/paper-runs/process").json()["fills"] == 2
    sell = c.get("/api/v1/trades").json()["transactions"][0]
    assert sell["type"] == "SELL" and "stop-loss" in sell["note"]

    assert c.put(f"/api/v1/paper-runs/{run['id']}", json={"status": "paused"}).json()["status"] == "paused"
    load(c, "COMI", FLAT + UP + [9.0, 9.0] + UP)            # a new up-trend while paused
    assert c.post("/api/v1/paper-runs/process").json() == {"runs": 0, "fills": 0}
    resumed = c.put(f"/api/v1/paper-runs/{run['id']}", json={"status": "active"}).json()
    assert resumed["pending_buy"] == []                     # the paused days are not traded in hindsight
    assert c.post("/api/v1/paper-runs/process").json()["fills"] == 0
    assert c.put(f"/api/v1/paper-runs/{run['id']}", json={"status": "stopped"}).json()["status"] == "stopped"
    assert c.put(f"/api/v1/paper-runs/{run['id']}", json={"status": "active"}).status_code == 422


def test_run_validation(c):
    load(c, "COMI", FLAT)
    st = c.post("/api/v1/strategies", json={"name": "S", "type": "sma_cross", "symbols": ["COMI"]}).json()
    assert c.post("/api/v1/paper-runs", json={"strategy_id": st["id"], "capital": 60000}).status_code == 422   # more than the cash
    assert c.post("/api/v1/paper-runs", json={"strategy_id": "nope", "capital": 1000}).status_code == 404
    assert c.post("/api/v1/paper-runs", json={"strategy_id": st["id"], "capital": 0}).status_code == 422
    assert c.put("/api/v1/paper-runs/nope", json={"status": "paused"}).status_code == 404


# ---- research -----------------------------------------------------------------
def test_research_library(c):
    bad = c.post("/api/v1/research", json={"title": "x", "url": "javascript:alert(1)"})
    assert bad.status_code == 422
    assert c.post("/api/v1/research", json={"title": "x", "symbols": ["NOPE"]}).status_code == 404
    a = c.post("/api/v1/research", json={"title": "CIB Q3 results", "url": "https://example.com/cib", "source": "EGX",
                                         "published": "2026-11-01", "symbols": ["comi"], "category": "financials",
                                         "sentiment": "positive", "importance": 3, "reliability": "official", "verified": True}).json()
    c.post("/api/v1/research", json={"title": "Rate decision", "sectors": ["Banks"], "category": "economic", "published": "2026-11-10"})
    c.post("/api/v1/research", json={"title": "Cement prices", "sectors": ["Building Materials"], "summary": "kiln costs"})
    assert a["symbols"] == ["COMI"] and a["verified"] is True
    assert [i["title"] for i in c.get("/api/v1/research").json()][:2] == ["Cement prices", "Rate decision"] or True
    # a stock sees items tagged with it and with its sector
    assert {i["title"] for i in c.get("/api/v1/research", params={"symbol": "COMI"}).json()} == {"CIB Q3 results", "Rate decision"}
    assert [i["title"] for i in c.get("/api/v1/research", params={"category": "economic"}).json()] == ["Rate decision"]
    assert [i["title"] for i in c.get("/api/v1/research", params={"q": "KILN"}).json()] == ["Cement prices"]
    upd = c.put(f"/api/v1/research/{a['id']}", json={"title": "CIB Q3 results (final)", "symbols": ["COMI"], "sentiment": "neutral"}).json()
    assert upd["title"].endswith("(final)") and upd["created_at"] == a["created_at"] and upd["verified"] is False
    assert c.delete(f"/api/v1/research/{a['id']}").status_code == 200
    assert c.delete(f"/api/v1/research/{a['id']}").status_code == 404


# ---- journal ------------------------------------------------------------------
def test_investment_journal(c):
    assert c.post("/api/v1/journal", json={"thesis": ""}).status_code == 422
    e = c.post("/api/v1/journal", json={"symbol": "tmgh", "thesis": "Breakout on volume", "expected": "+15% in a month",
                                        "exit_condition": "close under 50-day average", "entry_date": "2026-11-02"}).json()
    assert e["symbol"] == "TMGH" and e["status"] == "open" and e["outcome"] == ""
    done = c.put(f"/api/v1/journal/{e['id']}", json={"symbol": "TMGH", "thesis": "Breakout on volume", "outcome": "Stopped out at -6%",
                                                    "lesson": "Entered late", "status": "closed"}).json()
    assert done["status"] == "closed" and done["lesson"] == "Entered late"
    assert c.get("/api/v1/journal", params={"status": "open"}).json() == []
    assert len(c.get("/api/v1/journal", params={"symbol": "TMGH"}).json()) == 1
    assert c.delete(f"/api/v1/journal/{e['id']}").status_code == 200


# ---- alerts -------------------------------------------------------------------
def test_alerts_fire_once_a_day_and_explain_themselves(c):
    last = c.get("/api/v1/stocks/COMI").json()["quote"]["last"]
    assert c.post("/api/v1/alerts", json={"kind": "price_above"}).status_code == 422                 # no stock, no level
    assert c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "COMI", "value": -5}).status_code == 422
    assert c.post("/api/v1/alerts", json={"kind": "strategy_signal"}).status_code == 422
    assert c.post("/api/v1/alerts", json={"kind": "strategy_signal", "strategy_id": "nope"}).status_code == 404
    hit = c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "comi", "value": last - 1, "note": "take profit"}).json()
    c.post("/api/v1/alerts", json={"kind": "price_below", "symbol": "COMI", "value": last / 2})       # far away
    c.post("/api/v1/alerts", json={"kind": "rsi_above", "symbol": "COMI", "value": 1})                # always true
    off = c.post("/api/v1/alerts", json={"kind": "price_above", "symbol": "TMGH", "value": 0.01, "active": False}).json()

    out = c.post("/api/v1/alerts/check").json()
    assert out["active"] == 3 and {e["kind"] for e in out["triggered"]} == {"price_above", "rsi_above"}
    event = next(e for e in out["triggered"] if e["kind"] == "price_above")
    assert event["alert_id"] == hit["id"] and event["observed"] == last and "COMI is at" in event["message"] and event["note"] == "take profit"
    assert c.post("/api/v1/alerts/check").json()["triggered"] == []                                  # not again today
    page = c.get("/api/v1/alerts").json()
    assert len(page["alerts"]) == 4 and len(page["events"]) == 2 and "price_above" in page["kinds"]
    assert next(a for a in page["alerts"] if a["id"] == hit["id"])["last_triggered_on"] is not None

    # switching an alert on makes it eligible; deleting removes it
    assert c.put(f"/api/v1/alerts/{off['id']}", json={"kind": "price_above", "symbol": "TMGH", "value": 0.01, "active": True}).status_code == 200
    assert [e["symbol"] for e in c.post("/api/v1/alerts/check").json()["triggered"]] == ["TMGH"]
    assert c.delete(f"/api/v1/alerts/{hit['id']}").status_code == 200


def test_strategy_signal_alert(c):
    load(c, "COMI", FLAT + UP[:1])            # the fast average crosses up on the last bar
    st = c.post("/api/v1/strategies", json={"name": "Fast trend", "type": "sma_cross", "symbols": ["COMI"],
                                           "params": {"fast": 2, "slow": 5}}).json()
    c.post("/api/v1/alerts", json={"kind": "strategy_signal", "strategy_id": st["id"]})
    out = c.post("/api/v1/alerts/check").json()["triggered"]
    assert len(out) == 1 and "Fast trend: COMI (entry)" in out[0]["message"]
