"""Younit feed: client parsing, shared cache, and the API on top of it (no network)."""
import json
from datetime import date, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.data.calendar import is_trading_day
from app.data.feed import Feed, StoreDocs
from app.data.younit import YounitClient, YounitError
from app.main import create_app
from app.store.sqlite_store import Store


def days(n: int, end: date | None = None) -> list[str]:
    out, d = [], end or date.today()
    while len(out) < n:
        if is_trading_day(d):
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out[::-1]


class FakeYounit:
    """Stands in for YounitClient: three stocks, deterministic rising prices."""

    def __init__(self, n=260):
        self.n, self.calls, self.fail = n, [], set()
        self.listing = [{"symbol": "COMI", "name": "Commercial International Bank", "stock_id": 1},
                        {"symbol": "TMGH", "name": "Talaat Moustafa Group", "stock_id": 2},
                        {"symbol": "NEWCO", "name": "A New Listing", "stock_id": 3}]

    def stocks(self):
        return self.listing

    def live(self, stocks, timeout=8.0):
        self.live_calls = getattr(self, "live_calls", 0) + 1
        prices = getattr(self, "live_prices", {})
        return {"quotes": {s["symbol"]: [prices[s["symbol"]], prices[s["symbol"]], prices[s["symbol"]] + 1, prices[s["symbol"]] - 1, 500.0]
                           for s in stocks if s["symbol"] in prices},
                "sectors": getattr(self, "sectors", {"NEWCO": "Real Estate"}),
                "indices": getattr(self, "indices", [{"id": 1, "name": "EGX 30", "value": 31000.0, "prev_close": 30000.0, "change_pct": 3.33}]),
                "errors": [], "answered": len(stocks)}

    def depth(self, stock_id, timeout=6.0):
        from app.data.depth import build
        bids = [(0.827, 107879, 4), (0.825, 45000, 2), (0.824, 5971, 1), (0.823, 329008, 2), (0.822, 2968690, 5),
                (0.821, 90774, 2), (0.82, 208848, 5), (0.819, 34500, 3)]
        asks = [(0.828, 155401, 1), (0.829, 401808, 3), (0.83, 162073, 12), (0.832, 290061, 3), (0.833, 415746, 1),
                (0.834, 270000, 2), (0.835, 450007, 10), (0.837, 500000, 2)]
        return build({"m_LastTradePrice": "0.827", "m_BidPrice": "0.827", "m_AskPrice": "0.828",
                      "m_BidBook": "|".join(f"{p},{s},{n}" for p, s, n in bids),
                      "m_AskBook": "|".join(f"{p},{s},{n}" for p, s, n in asks),
                      "m_TotalBids": "19225841", "m_TotalAsks": "18831655"})

    def snapshot(self):
        self.snapshots = getattr(self, "snapshots", 0) + 1
        return {"fields": ["id", "name", "reuterCode"],   # like the real list: no prices in it
                "stocks": [{**s, "last": None, "open": None, "high": None, "low": None, "volume": None} for s in self.listing]}

    def daily_history(self, stock_id, date_from, date_to):
        self.calls.append((stock_id, date_from, date_to))
        if stock_id in self.fail:
            raise YounitError("Younit request failed (HTTP 500)")
        rows = []
        for i, d in enumerate(days(self.n)):
            if date_from.isoformat() <= d <= date_to.isoformat():
                c = 10.0 * stock_id + i * 0.1
                rows.append([d, c - 0.05, c + 0.2, c - 0.2, c, 1000.0 * stock_id])
        return rows


@pytest.fixture(autouse=True)
def _fresh_feed():
    Feed.reset()
    yield
    Feed.reset()


@pytest.fixture()
def env(tmp_path):
    fake = FakeYounit()
    app = create_app(Settings(data_dir=tmp_path, younit_trading_id="", younit_api_key=""), Store(tmp_path / "t.sqlite3"), younit=fake)
    with TestClient(app) as c:
        yield c, fake


def test_no_sample_prices_once_a_feed_is_configured(env):
    c, _ = env
    s = c.get("/api/v1/status").json()
    assert s["provider"]["configured"] and s["provider"]["read_only"] and s["provider"]["refresh_due"]
    assert s["data"]["mode"] == "none" and s["data"]["has_sample_data"] is False
    assert c.get("/api/v1/stocks").json() == []
    assert c.get("/api/v1/market/overview").json()["indices"] == []


def test_refresh_then_everything_runs_on_feed_prices(env):
    c, fake = env
    r = c.post("/api/v1/data/refresh").json()
    assert r.pop("seconds") >= 0
    assert r == {"updated": 3, "remaining": 0, "total": 3, "errors": [], "stalled": False}
    s = c.get("/api/v1/status").json()
    assert s["data"]["mode"] == "younit" and s["data"]["sources"][0]["symbols"] == 3
    assert s["provider"]["refresh_due"] is False and s["provider"]["latest_bar_date"] == days(1)[0]
    assert "connected for market data only" in s["broker_note"] and s["live_trading_enabled"] is False

    rows = {r["symbol"]: r for r in c.get("/api/v1/stocks").json()}
    assert set(rows) == {"COMI", "TMGH", "NEWCO"}
    assert rows["COMI"]["sector"] == "Banks" and rows["NEWCO"]["sector"] == "Unclassified"
    assert rows["COMI"]["source"] == "younit" and rows["COMI"]["last"] == pytest.approx(10 + 259 * 0.1)

    d = c.get("/api/v1/stocks/COMI").json()
    assert "Younit" in d["data_note"] and d["assessment"]["sma200"] is not None
    assert c.post("/api/v1/trades", json={"side": "BUY", "symbol": "NEWCO", "qty": 5}).json()["price_source"] == "younit"
    st = c.post("/api/v1/strategies", json={"name": "T", "type": "sma_cross", "params": {"fast": 5, "slow": 20}}).json()
    bt = c.post("/api/v1/backtests", json={"strategy_id": st["id"]}).json()
    assert bt["data_sources"] == ["younit"] and not any("SAMPLE" in w for w in bt["warnings"])
    assert bt["benchmark"] is None  # the feed has no index series; nothing is invented in its place
    assert c.get("/api/v1/audit", params={"limit": 50}).json()[-1 if False else 0]["entity"] in ("backtest", "market_data")

    # a second refresh right away has nothing to do and makes no history calls
    before = len(fake.calls)
    assert c.post("/api/v1/data/refresh").json()["updated"] == 0 and len(fake.calls) == before


def test_incremental_refresh_merges_and_keeps_history(tmp_path):
    store, fake = Store(tmp_path / "f.sqlite3"), FakeYounit(n=100)
    feed = Feed(StoreDocs(store))
    feed.refresh(fake, today=date.today())
    idx = store.get("egxMarket", "index")
    idx["checked"] = {k: "2000-01-01T00:00:00+00:00" for k in idx["checked"]}   # pretend it was long ago
    store.put("egxMarket", "index", idx)
    fake.n, fake.calls = 105, []
    Feed.reset()
    out = feed.refresh(fake, today=date.today())
    assert out["updated"] == 3
    assert all(c[1] > date.today() - timedelta(days=30) for c in fake.calls)   # asked only for the recent tail
    bars = feed.load()["frames"]["COMI"]
    assert len(bars) >= 100 and bars.index.is_monotonic_increasing and bars.index.is_unique
    assert bars.index[-1].strftime("%Y-%m-%d") == days(1)[0]


def test_batches_respect_the_time_budget_and_report_failures(tmp_path):
    store, fake = Store(tmp_path / "f.sqlite3"), FakeYounit()
    feed = Feed(StoreDocs(store))
    partial = feed.refresh(fake, today=date.today(), budget_seconds=0)   # no time: only the stock list is saved
    assert partial["updated"] == 0 and partial["remaining"] == 3 and partial["stalled"]
    fake.fail = {2}
    out = feed.refresh(fake, today=date.today())
    assert out["updated"] == 2 and out["remaining"] == 1 and "TMGH" in out["errors"][0]
    assert feed.summary(date.today())["refresh_due"] is True
    fake.fail = set()
    assert feed.refresh(fake, today=date.today())["remaining"] == 0


def test_feed_outage_is_reported_and_writes_nothing(env):
    c, fake = env
    c.post("/api/v1/data/refresh")

    def down():
        raise YounitError("cannot reach Younit (ConnectTimeout)")
    fake.snapshot = down
    r = c.post("/api/v1/data/refresh")
    assert r.status_code == 502 and "cannot reach Younit" in r.json()["detail"]
    assert len(c.get("/api/v1/stocks").json()) == 3   # yesterday's data still served


def test_csv_import_overrides_the_feed_for_that_account(env):
    c, _ = env
    c.post("/api/v1/data/refresh")
    good = "Date,Open,High,Low,Close,Volume\n2024-01-01,10,11,9,10.5,1000\n2024-01-02,10.5,12,10,11,2000\n"
    assert c.post("/api/v1/data/bars/import", data={"symbol": "COMI"}, files={"file": ("c.csv", good, "text/csv")}).status_code == 200
    assert c.get("/api/v1/stocks/COMI").json()["quote"]["source"] == "csv"
    assert c.get("/api/v1/stocks/TMGH").json()["quote"]["source"] == "younit"


# ---- the HTTP client itself ---------------------------------------------------
def make_client(handler):
    YounitClient._tokens.clear()
    return YounitClient("tid-1", "key-1", transport=httpx.MockTransport(handler))


def test_client_signs_in_once_reuses_the_token_and_parses_both_field_spellings():
    seen = {"token": 0, "auth": []}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/public-keys/token":
            seen["token"] += 1
            assert json.loads(req.content) == {"tradingId": "tid-1", "secret": "key-1"}
            return httpx.Response(200, json={"data": {"accessToken": f"tok{seen['token']}", "expiresIn": 3600, "tokenType": "Bearer"}})
        seen["auth"].append(req.headers["authorization"])
        if req.url.path == "/api/stocks/market/1":
            return httpx.Response(200, json={"data": [
                {"stockId": 7, "symbol": "comi", "stockName": "CIB"},
                {"securityID": 9, "symbol": "TMGH", "securityName": "TMG"},
                {"stockId": 11, "symbol": ""}, {"symbol": "NOID"}, "garbage"]})
        assert dict(req.url.params) == {"SecurityID": "7", "Period": "Day", "DateFrom": "2026-01-01", "DateTo": "2026-01-10"}
        return httpx.Response(200, json={"messages": None, "data": {"errorCode": 0, "data": {"chartingDataViewModel": [
            {"dateTime": "2026-01-05T00:00:00", "openPrice": 10, "highPrice": 11, "lowPrice": 9.5, "price": 10.5, "volume": 100},
            {"date": "2026-01-04T00:00:00", "open": 9, "high": 10, "low": 8.5, "close": 9.5, "volume": 50},
            {"dateTime": "2026-01-06T00:00:00", "openPrice": 0, "highPrice": 0, "lowPrice": 0, "price": 12, "volume": None},
            {"dateTime": "2026-01-07T00:00:00", "price": 0}, {"dateTime": "bad", "price": 5}]}}})

    c = make_client(handler)
    assert c.stocks() == [{"symbol": "COMI", "name": "CIB", "stock_id": 7}, {"symbol": "TMGH", "name": "TMG", "stock_id": 9}]
    rows = c.daily_history(7, date(2026, 1, 1), date(2026, 1, 10))
    assert rows == [["2026-01-04", 9.0, 10.0, 8.5, 9.5, 50.0], ["2026-01-05", 10.0, 11.0, 9.5, 10.5, 100.0],
                    ["2026-01-06", 12.0, 12.0, 12.0, 12.0, 0.0]]
    assert seen["token"] == 1 and seen["auth"] == ["Bearer tok1", "Bearer tok1"]


def test_client_reauthenticates_once_on_401_and_explains_failures():
    state = {"token": 0, "calls": 0}

    def handler(req):
        if req.url.path == "/api/public-keys/token":
            state["token"] += 1
            return httpx.Response(200, json={"accessToken": f"t{state['token']}", "expiresIn": 3600, "tokenType": "Bearer"})
        state["calls"] += 1
        return httpx.Response(401) if req.headers["authorization"] == "Bearer t1" else httpx.Response(200, json=[])
    c = make_client(handler)
    with pytest.raises(YounitError, match="the list is empty"):
        c.stocks()
    assert state == {"token": 2, "calls": 2}

    with pytest.raises(YounitError, match="rejected the Trading ID"):
        make_client(lambda r: httpx.Response(401)).stocks()
    with pytest.raises(YounitError, match="rate limit"):
        make_client(lambda r: httpx.Response(200, json={"accessToken": "t", "expiresIn": 60, "tokenType": "Bearer"})
                    if "token" in r.url.path else httpx.Response(429)).stocks()

    def boom(_):
        raise httpx.ConnectError("x")
    with pytest.raises(YounitError, match="cannot reach Younit") as info:
        make_client(boom).stocks()
    assert "key-1" not in str(info.value) and "tid-1" not in str(info.value)


def test_stock_list_uses_reuters_code_when_there_is_no_symbol_and_explains_unknown_shapes():
    tok = httpx.Response(200, json={"accessToken": "t", "expiresIn": 3600, "tokenType": "Bearer"})

    def live_shape(req):
        if "token" in req.url.path:
            return tok
        return httpx.Response(200, json={"data": [
            {"stockId": 101, "reuterCode": "COMI.CA", "stockName": "CIB", "price": 80.5},
            {"stockId": "102", "reuterCode": "HRHO.CA", "shortName": "EFG"},
            {"stockId": 103, "reuterCode": ""}, {"stockId": "x", "reuterCode": "BAD.CA"}]})
    assert make_client(live_shape).stocks() == [{"symbol": "COMI", "name": "CIB", "stock_id": 101},
                                                {"symbol": "HRHO", "name": "EFG", "stock_id": 102}]

    def odd_fields(req):
        return tok if "token" in req.url.path else httpx.Response(200, json={"data": [{"code": "COMI", "secret_value": "80.5"}]})
    with pytest.raises(YounitError) as info:
        make_client(odd_fields).stocks()
    assert "fields [code, secret_value]" in str(info.value) and "80.5" not in str(info.value)

    def no_list(req):
        return tok if "token" in req.url.path else httpx.Response(200, json={"messages": ["x"], "data": {"errorCode": 5, "data": None}})
    with pytest.raises(YounitError, match=r"no list found; response is \{data, messages\} > \{data, errorCode\}"):
        make_client(no_list).stocks()

    def odd_candles(req):
        return tok if "token" in req.url.path else httpx.Response(200, json={"data": {"data": {"chartingDataViewModel": [{"t": 1, "c": 2}]}}})
    with pytest.raises(YounitError, match=r"price history could not be read: 1 entries with fields \[c, t\]"):
        make_client(odd_candles).daily_history(1, date(2026, 1, 1), date(2026, 1, 2))


def test_a_large_market_is_loaded_in_bounded_batches(tmp_path):
    from app.data import feed as feed_module
    fake = FakeYounit(n=30)
    fake.listing = [{"symbol": f"S{i:03d}", "name": f"Stock {i}", "stock_id": i + 1} for i in range(95)]
    feed = Feed(StoreDocs(Store(tmp_path / "f.sqlite3")))
    seen = []
    for _ in range(10):
        out = feed.refresh(fake, today=date.today())
        seen.append(out["updated"])
        if out["remaining"] == 0:
            break
    assert seen == [40, 40, 15] and max(seen) <= feed_module.MAX_PER_BATCH
    state = feed.load()
    assert len(state["frames"]) == 95 and all(len(b) == 30 for b in state["frames"].values())
    assert feed.summary(date.today())["refresh_due"] is False


def test_a_request_reads_one_small_document_when_nothing_changed(tmp_path):
    store = Store(tmp_path / "f.sqlite3")
    docs = StoreDocs(store)
    reads = []
    original = docs.get
    docs.get = lambda id: (reads.append(id), original(id))[1]
    feed = Feed(docs)
    feed.refresh(FakeYounit(n=40), today=date.today())
    reads.clear()
    feed.load()                      # first load on this instance: meta + index + chunks
    assert reads[0] == "meta" and "index" in reads and any(r.startswith("chunk_") for r in reads)
    reads.clear()
    frames = feed.load()["frames"]
    assert reads == ["meta"]         # every later request: one small read
    assert feed.load()["frames"] is frames   # and the same tables, not rebuilt
    # a database written by the release before `meta` existed still loads
    store.delete("egxMarket", "meta")
    Feed.reset()
    assert len(feed.load()["frames"]) == 3


# ---- live prices during the session ------------------------------------------
def test_live_prices_sit_on_top_of_history_until_the_session_settles(tmp_path):
    from datetime import datetime

    from app.data.calendar import CAIRO
    from app.data.market import MarketData
    store, fake = Store(tmp_path / "f.sqlite3"), FakeYounit(n=60)
    feed = Feed(StoreDocs(store))
    today = date.fromisoformat(days(1)[0])     # the latest session date in the fake history
    feed.refresh(fake, today=today)
    settled_close = feed.load()["frames"]["COMI"]["close"].iloc[-1]

    def market(day=today):
        return MarketData(store, {}, data_version=0, sample=False, today=day, feed=feed.load())

    assert market().instrument("NEWCO")["sector"] == "Unclassified"
    fake.live_prices = {"COMI": settled_close + 5, "TMGH": 1.0}
    t0 = datetime.combine(today, datetime.min.time(), CAIRO).replace(hour=11)
    out = feed.poll_live(fake, now=t0)
    assert out["updated"] and out["available"] and out["stocks"] == 2 and out["indices"] == 1
    m = market()
    bars = m.bars("COMI")
    # the live price replaces today's close and widens the day's range; the bar count does not change
    assert bars["close"].iloc[-1] == settled_close + 5 and bars["high"].iloc[-1] >= settled_close + 6
    assert len(bars) == 60 and m.is_live("COMI") and not m.is_live("NEWCO")
    assert m.bars("COMI", settled=True)["close"].iloc[-1] == settled_close   # backtests never see the unfinished bar
    assert m.status()["is_live"] and m.status()["live_symbols"] == 2
    assert m.instrument("NEWCO")["sector"] == "Real Estate" and m.instrument("COMI")["sector"] == "Banks"
    assert m.cache["indices"][0]["name"] == "EGX 30" and m.cache["indices"][0]["live"] is True

    # a poll 20 seconds later reuses the saved prices: the feed is not called again
    again = feed.poll_live(fake, now=t0.replace(second=20))
    assert again["updated"] is False and fake.live_calls == 1
    # a minute later it is; a stock that stops answering just falls back to its settled bar
    fake.live_prices = {"COMI": settled_close - 3}
    fake.sectors = {}
    feed.poll_live(fake, now=t0.replace(minute=2))
    m = market()
    assert m.bars("COMI")["close"].iloc[-1] == settled_close - 3 and not m.is_live("TMGH")
    assert m.instrument("NEWCO")["sector"] == "Real Estate"      # sectors seen earlier are kept

    # next morning yesterday's prices are ignored, but the sectors still apply
    tomorrow = market(today + timedelta(days=1))
    assert not tomorrow.is_live("COMI") and tomorrow.instrument("NEWCO")["sector"] == "Real Estate"
    assert tomorrow.cache["indices"][0]["live"] is False


def test_live_endpoint_only_polls_while_the_market_is_open(env, monkeypatch):
    c, fake = env
    c.post("/api/v1/data/refresh")
    import app.services as services
    monkeypatch.setattr(services, "market_open", lambda: False)
    assert c.post("/api/v1/data/live").json() == {"updated": False, "market_open": False}
    assert getattr(fake, "live_calls", 0) == 0   # market closed: the feed is not called
    monkeypatch.setattr(services, "market_open", lambda: True)
    fake.live_prices = {"COMI": 99.0}
    out = c.post("/api/v1/data/live").json()
    assert out["updated"] and out["market_open"] and out["stocks"] == 1
    s = c.get("/api/v1/status").json()
    assert s["provider"]["live"]["stocks"] == 1 and s["provider"]["live"]["sectors"] == 1
    assert c.get("/api/v1/market/overview").json()["indices"][0]["name"] == "EGX 30"

    def down(stocks, timeout=8.0):
        raise YounitError("Younit live prices: the streaming server sent no prices (connection: never connected)")
    fake.live = down
    from app.data.feed import Feed as F
    doc = c.app.state  # noqa: F841 - keep the client alive
    F.reset()
    import app.data.feed as feed_module
    monkeypatch.setattr(feed_module, "cairo_now", lambda: __import__("datetime").datetime.now(feed_module.CAIRO) + timedelta(minutes=5))
    r = c.post("/api/v1/data/live")
    assert r.status_code == 502 and "live prices" in r.json()["detail"]


def test_depth_endpoint_serves_the_book_and_refuses_unknown_stocks(env):
    c, _ = env
    c.post("/api/v1/data/refresh")
    b = c.get("/api/v1/stocks/comi/depth").json()
    assert b["symbol"] == "COMI" and b["best_bid"] == 0.827 and b["best_ask"] == 0.828
    assert len(b["bids"]) == 8 and b["bids"][0]["orders"] == 4 and b["unread"] is None and "as_of" in b
    assert c.get("/api/v1/stocks/NOPE/depth").status_code == 404
