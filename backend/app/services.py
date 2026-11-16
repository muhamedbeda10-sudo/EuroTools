"""Application services: glue between the store, market data and the domain rules."""
from __future__ import annotations

import functools
import json
import math
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pandas as pd

from .config import Settings
from .data.calendar import cairo_now, market_open
from .data.market import BUILD_LOCK, MarketData
from .domain import candles
from .domain import indicators as ind
from .domain.backtest import run_backtest
from .domain.fees import DEFAULT_FEE_SCHEDULE, FeeSchedule, compute_fees
from .domain.ledger import LedgerError, build_trade, replay
from .domain.money import ZERO, D, f, money, px
from .domain.strategies import StrategyConfig, signals
from .store.errors import ConflictError

# Several people looking at the same stock share one feed call for a few seconds.
_DEPTH_CACHE: dict[str, tuple[float, dict]] = {}
DEPTH_CACHE_SECONDS = 5.0


CANDLE_LOOKBACK = 120          # bars of the chart that candle patterns are reported for
CANDLE_CONTEXT = 80            # bars a market-wide scan reads per stock: enough for every pattern's context
MAX_STORED_TRADES = 400        # per saved backtest; the totals always cover every trade
MAX_BACKTEST_BYTES = 800_000   # a stored document may not exceed 1 MiB


class NotFound(LookupError):
    pass


def retry_conflict(fn):
    """Run a change once more if someone else changed the same data at the same moment.

    The store forgets what it had read when a write is refused, so the second
    attempt starts from the current data.
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ConflictError:
            return fn(*args, **kwargs)
    return wrapper


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def clean(obj):
    """Make a structure JSON-safe: NaN/inf -> None, Decimal -> float, Timestamp -> date string."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.strftime("%Y-%m-%d")
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if hasattr(obj, "item"):  # numpy scalar
        return clean(obj.item())
    return obj


def _period_open(last: pd.Timestamp, timeframe: str) -> bool:
    """Whether the week or month of the latest bar is still running (EGX weeks end on Thursday).
    A holiday on the last day keeps the answer at "open", which errs on the careful side."""
    if timeframe == "w":
        return last.dayofweek != 3
    if timeframe == "m":
        nxt = last.date() + timedelta(days=1)
        while nxt.weekday() in (4, 5):  # Friday, Saturday
            nxt += timedelta(days=1)
        return nxt.month == last.month
    return False


class App:
    """One unit of work for one user. `cache` outlives it (per user, per server instance)."""

    def __init__(self, store, settings: Settings, cache: dict | None = None, feed=None, younit=None):
        self.store = store
        self.settings = settings
        self.cache = cache if cache is not None else {}
        self.feed = feed      # data.feed.Feed when the Younit feed is configured, else None
        self.younit = younit  # data.younit.YounitClient: market data, and the read-only look at the real account
        # Whether this request may look at the real brokerage account. The API sets it for each
        # sign-in (broker.may_view); anything that builds an App itself gets the safe answer.
        self.real_account_allowed = False
        # Who this unit of work is for, when the server has sign-in: set by the API for each request.
        self.uid: str | None = None
        self.signed_in = False
        self.id_token: str | None = None   # that person's sign-in for this unit of work; never stored, never sent on
        self._app_settings: dict | None = None
        self.market: MarketData = None  # set by bootstrap()

    # ---- bootstrap -------------------------------------------------------
    def bootstrap(self) -> App:
        """Read this user's settings (creating them on first use) and attach market data.

        On the deployed app this first read is also the authentication check:
        the database refuses it unless the caller's sign-in token is valid.
        """
        # The two reads every request needs are independent: do them at the same time.
        with ThreadPoolExecutor(1) as pool:
            feed_state = pool.submit(self.feed.load) if self.feed is not None else None
            cfg = self.store.get("settings", "app")
            feed_state = feed_state.result() if feed_state is not None else None
        if cfg is None:
            try:
                with self.store.transaction():
                    self._app_settings = {"starting_capital": str(self.settings.initial_capital_egp), "currency": "EGP",
                                          "benchmark": "EGX30", "active_portfolio_id": None, "data_version": 0}
                    # `create` is the guard: it can succeed for one request only.
                    self.store.create("settings", "fees", DEFAULT_FEE_SCHEDULE.model_dump(mode="json"))
                    self._new_portfolio(self.settings.initial_capital_egp, reason="initial")
            except ConflictError:
                # A first page load fires several requests at once. The commit is atomic and
                # the fee schedule can only be created once, so exactly one of them sets the
                # account up; the others land here and read what the winner wrote.
                pass
            cfg = self.store.get("settings", "app")
            if cfg is None:
                raise RuntimeError("could not initialise this account; reload the page")
        self._app_settings = cfg
        self.market = MarketData(self.store, self.cache.setdefault("market", {}),
                                 data_version=int(self._app_settings.get("data_version", 0)),
                                 sample=self.settings.seed_sample_data,
                                 feed=feed_state)
        return self

    def import_lists(self) -> list[str]:
        """The collections holding this account's own imports, when they still have to be read (for `store.warm`).

        Empty once they are in memory: they are read again only after an import, not on every request.
        """
        return [] if self.market.imports_held() else ["instruments", "bars"]

    def provider_status(self) -> dict:
        if self.feed is None:
            return {"name": None, "configured": False}
        return {"name": "younit", "configured": True, "read_only": True, **self.feed.summary(self.market.today)}

    def _feed_stock(self, symbol: str) -> dict:
        stock = next((i for i in self.market.feed["instruments"]
                      if i["symbol"] == symbol and i.get("listed", True)), None)
        if stock is None:
            raise NotFound(f"{symbol} is not in the live feed")
        return stock

    def depth(self, symbol: str) -> dict:
        """Order book of one stock, straight from the feed. Nothing is stored."""
        symbol = symbol.upper()
        if self.feed is None or self.younit is None:
            raise NotFound("price depth needs the live market-data feed")
        stock = self._feed_stock(symbol)
        cached = _DEPTH_CACHE.get(symbol)
        if cached and time.monotonic() - cached[0] < DEPTH_CACHE_SECONDS:
            return cached[1]
        book = {"symbol": symbol, "as_of": cairo_now().isoformat(timespec="seconds"), "market_open": market_open(),
                **self.younit.depth(stock["stock_id"])}
        _DEPTH_CACHE[symbol] = (time.monotonic(), book)
        while len(_DEPTH_CACHE) > 50:
            _DEPTH_CACHE.pop(next(iter(_DEPTH_CACHE)))
        return book

    def follow(self, symbol: str, max_seconds: float):
        """Tick-by-tick quote and order book of one stock, for as long as the caller keeps reading."""
        symbol = symbol.upper()
        if self.feed is None or self.younit is None:
            raise NotFound("live streaming needs the market-data feed")
        stock = self._feed_stock(symbol)
        return self.younit.follow_stock(stock["stock_id"], max_seconds=max_seconds)

    def follow_market(self, max_seconds: float):
        """Tick-by-tick prices of every tracked stock and the indices."""
        if self.feed is None or self.younit is None:
            raise NotFound("live streaming needs the market-data feed")
        state = self.market.feed
        current = [i for i in state["instruments"] if i.get("listed", True)]
        tracked = [i for i in current if i["symbol"] in state["frames"]] or current
        indices = {i["id"]: i["name"] for i in (state.get("live") or {}).get("indices") or []}
        ticks = self.younit.follow_market(tracked, list(indices), max_seconds=max_seconds)
        return ticks, indices

    def poll_live(self) -> dict:
        """Latest prices for the running session. Does nothing while the market is closed."""
        if self.feed is None or self.younit is None:
            raise NotFound("no market-data feed is configured")
        if not market_open():
            return {"updated": False, "market_open": False}
        return {**self.feed.poll_live(self.younit), "market_open": True}

    def refresh_feed(self) -> dict:
        if self.feed is None or self.younit is None:
            raise NotFound("no market-data feed is configured")
        result = self.feed.refresh(self.younit, today=self.market.today)
        if result["updated"] and result["remaining"] == 0:
            # one line per completed update, not one per batch of forty stocks
            self.audit("refresh", "market_data", {"total": result["total"]})
        return result

    def bump_data_version(self) -> None:
        cfg = self.app_settings()
        cfg["data_version"] = int(cfg.get("data_version", 0)) + 1
        self._save_settings(cfg)
        self.market.data_version = cfg["data_version"]

    def _save_settings(self, cfg: dict) -> None:
        self.store.put("settings", "app", cfg)
        self._app_settings = dict(cfg)

    def audit(self, action: str, entity: str, detail: dict | None = None) -> None:
        self.store.append("audit", {"ts": now_iso(), "action": action, "entity": entity, "detail": detail or {}})

    # ---- settings --------------------------------------------------------
    def app_settings(self) -> dict:
        return dict(self._app_settings)

    def update_app_settings(self, *, starting_capital: Decimal | None, benchmark: str | None) -> dict:
        with self.store.transaction():
            cur = self.app_settings()
            before = dict(cur)
            if starting_capital is not None:
                cur["starting_capital"] = str(money(starting_capital))
            if benchmark is not None:
                ins = self.market.instrument(benchmark)
                if ins is None:
                    raise NotFound(f"unknown benchmark {benchmark}")
                cur["benchmark"] = benchmark
            self._save_settings(cur)
            self.audit("update", "settings", {"before": before, "after": cur})
            return cur

    def fee_schedule(self) -> FeeSchedule:
        return FeeSchedule.model_validate(self.store.get("settings", "fees"))

    def update_fee_schedule(self, schedule: FeeSchedule) -> FeeSchedule:
        with self.store.transaction():
            before = self.store.get("settings", "fees")
            after = schedule.model_dump(mode="json")
            self.store.put("settings", "fees", after)
            self.audit("update", "fee_schedule", {"before": before, "after": after})
        return schedule

    # ---- quotes ----------------------------------------------------------
    def quotes(self) -> pd.DataFrame:
        """Latest quote row per stock, with short-term returns."""
        self.market._load()
        mcache = self.market.cache
        if "quotes" in mcache:
            return mcache["quotes"]
        with BUILD_LOCK:  # requests arriving together compute the table once
            return self._quotes(mcache)

    def _quotes(self, mcache: dict) -> pd.DataFrame:
        if "quotes" in mcache:
            return mcache["quotes"]
        # An account with no imports of its own sees exactly the shared feed, so the
        # table is computed once per server instance instead of once per account.
        shared = self.market.feed.setdefault("_quotes", {}) if mcache.get("shared_only") else None
        if shared is not None and shared.get("key") == mcache["key"][1:]:
            mcache["quotes"] = shared["table"]
            return mcache["quotes"]
        rows = []
        for insx in self.market.instruments(include_indices=True):
            df = self.market.bars(insx["symbol"])
            if df is None or len(df) == 0:
                continue
            close = df["close"]
            last = float(close.iloc[-1])
            prev = float(close.iloc[-2]) if len(close) > 1 else None
            rows.append({
                "symbol": insx["symbol"], "name": insx["name"], "sector": insx["sector"], "type": insx["type"],
                "last": last,
                "change": last - prev if prev else None,
                "change_pct": (last / prev - 1) * 100 if prev else None,
                "week_pct": ind.pct_change_over(close, 5),
                "month_pct": ind.pct_change_over(close, 21),
                "volume": float(df["volume"].iloc[-1]),
                "avg_volume_20": ind.avg_volume(df["volume"]),  # the 20 sessions before this one
                "turnover": last * float(df["volume"].iloc[-1]),
                "as_of": df.index[-1].strftime("%Y-%m-%d"),
                "source": self.market.source(insx["symbol"]),
                "live": self.market.is_live(insx["symbol"]),
                "spark": [round(float(v), 2) for v in close.tail(30)],
            })
        table = pd.DataFrame(rows)
        if len(table):
            # `current`: the row is from the market's latest session. A stock that did not trade in it
            # (suspended, illiquid) keeps its last price but is left out of "today" figures and alerts.
            stocks = table["type"] == "stock"
            latest = table.loc[stocks, "as_of"].max() if stocks.any() else table["as_of"].max()
            table["current"] = table["as_of"] == latest
        mcache["quotes"] = table
        if shared is not None:
            shared.update(key=mcache["key"][1:], table=mcache["quotes"])
        return mcache["quotes"]

    def _records(self, df: pd.DataFrame) -> list[dict]:
        return clean(df.astype(object).where(df.notna(), None).to_dict("records"))

    def stock_rows(self, sector: str | None = None, q: str | None = None, category: str | None = None) -> list[dict]:
        self.store.warm(lists=["watchlist", *self.import_lists()])
        df = self.quotes()
        if df.empty:
            return []
        df = df[df["type"] == "stock"]
        if sector:
            df = df[df["sector"] == sector]
        if category:
            cat = self.store.get("categories", category)
            if cat is None:
                raise NotFound("category not found")
            df = df[df["symbol"].isin(cat["symbols"])]
        if q:
            ql = q.lower()
            df = df[df["symbol"].str.lower().str.contains(ql, regex=False) | df["name"].str.lower().str.contains(ql, regex=False)]
        watch = {w["symbol"] for w in self.store.list("watchlist")}
        out = self._records(df.sort_values("symbol"))
        for r in out:
            r["watched"] = r["symbol"] in watch
        return out

    def market_overview(self) -> dict:
        df = self.quotes()
        if df.empty:
            return {"indices": [], "breadth": None, "gainers": [], "losers": [], "most_active": []}
        stocks = df[df["type"] == "stock"]
        latest = stocks["as_of"].max()
        current = stocks[stocks["current"] & stocks["change_pct"].notna()]
        cols = ["symbol", "name", "sector", "last", "change_pct", "volume", "turnover"]
        return {
            "as_of": latest,
            "indices": self._records(df[df["type"] == "index"][["symbol", "name", "last", "change", "change_pct", "as_of", "source", "spark"]])
            + [{"symbol": i["name"], "name": i["name"], "last": i["value"], "change_pct": i["change_pct"],
                "change": i["value"] - i["prev_close"] if i["prev_close"] else None,
                "as_of": str(i["as_of"])[:16].replace("T", " "), "source": "younit", "live": i["live"], "spark": []}
               for i in self.market.cache.get("indices", [])],
            "breadth": {
                "covered": int(len(stocks)),
                "advancers": int((current["change_pct"] > 0).sum()),
                "decliners": int((current["change_pct"] < 0).sum()),
                "unchanged": int((current["change_pct"] == 0).sum()),
                "volume": float(current["volume"].sum()),
                "turnover_approx": float(current["turnover"].sum()),
                "avg_change_pct": float(current["change_pct"].mean()) if len(current) else None,
            },
            "gainers": self._records(current.nlargest(5, "change_pct")[cols]),
            "losers": self._records(current.nsmallest(5, "change_pct")[cols]),
            "most_active": self._records(current.nlargest(5, "volume")[cols]),
        }

    def sectors(self) -> list[dict]:
        df = self.quotes()
        if df.empty:
            return []
        stocks = df[df["type"] == "stock"]
        market_month = stocks["month_pct"].mean()
        out = []
        for sector, g in stocks.groupby("sector"):
            today = g[g["current"]]  # "day" figures use the latest session only, never an older last bar
            ranked = today.dropna(subset=["change_pct"]).sort_values("change_pct")
            month = g["month_pct"].mean()
            out.append({
                "sector": sector,
                "stocks": int(len(g)),
                "traded": int(len(today)),
                "day_pct": today["change_pct"].mean() if len(today) else None,
                "week_pct": g["week_pct"].mean(),
                "month_pct": month,
                "avg_volume": g["avg_volume_20"].mean(),
                "turnover_approx": today["turnover"].sum(),
                "best": None if ranked.empty else {"symbol": ranked.iloc[-1]["symbol"], "change_pct": ranked.iloc[-1]["change_pct"]},
                "worst": None if ranked.empty else {"symbol": ranked.iloc[0]["symbol"], "change_pct": ranked.iloc[0]["change_pct"]},
                "relative_strength": month - market_month if pd.notna(month) and pd.notna(market_month) else None,
            })
        return clean(sorted(out, key=lambda r: (r["month_pct"] is None, -(r["month_pct"] or 0))))

    def stock_detail(self, symbol: str, timeframe: str = "d", limit: int = 500) -> dict:
        symbol = symbol.upper()
        insx = self.market.instrument(symbol)
        if insx is None:
            raise NotFound(f"unknown symbol {symbol}")
        daily = self.market.bars(symbol)
        if daily is None or len(daily) < 2:
            return {"instrument": insx, "has_data": False}
        df = ind.resample(daily, timeframe)
        close = df["close"]
        m = ind.macd(close)
        frame = pd.DataFrame({
            "time": df.index.strftime("%Y-%m-%d"),
            "open": df["open"].values, "high": df["high"].values, "low": df["low"].values,
            "close": close.values, "volume": df["volume"].values,
            "sma20": ind.sma(close, 20).values, "sma50": ind.sma(close, 50).values,
            "sma200": ind.sma(close, 200).values, "rsi": ind.rsi(close).values,
            "macd": m["macd"].values, "macd_signal": m["signal"].values, "macd_hist": m["hist"].values,
        }).tail(limit)
        q = self.quotes()
        quote = self._records(q[q["symbol"] == symbol].drop(columns=["spark"]))[0]
        return clean({
            "instrument": insx,
            "has_data": True,
            "quote": quote,
            "watched": self.store.get("watchlist", symbol) is not None,
            "timeframe": timeframe,
            "bars": self._records(frame),
            "assessment": ind.assess(daily),
            "patterns": self._candle_patterns(symbol, daily, df, timeframe),
            "fundamentals": {
                "available": False,
                "reason": "No verified fundamental data source is connected yet (financial statements, EPS, P/E, dividends).",
            },
            "data_note": ("SAMPLE DATA - synthetic prices, not market quotes." if quote["source"] == "sample"
                          else f"Live price from Younit as of {str(self.market.cache['live_as_of'])[11:16]} Cairo time. "
                               "Today's bar is still forming." if quote.get("live")
                          else f"Last price seen today at {str(self.market.cache['live_as_of'])[11:16]} Cairo time. "
                               "The session's final bar replaces it at the next data update." if self.market.from_snapshot(symbol)
                          else "Daily prices from Younit, as of the date shown. Not a live quote." if quote["source"] == "younit"
                          else None),
        })

    def _candle_patterns(self, symbol: str, daily: pd.DataFrame, df: pd.DataFrame, timeframe: str) -> list[dict]:
        """Candle patterns of the chart's latest bars. A pattern on a candle that is not complete yet
        (today's session still running, or a week or month that has not ended) is marked `forming`:
        its shape can still change."""
        found = candles.patterns(df, last=CANDLE_LOOKBACK)
        settled = self.market.bars(symbol, settled=True)
        last = df.index[-1]
        if settled is None or len(settled) < len(daily) or _period_open(last, timeframe):
            stamp = last.strftime("%Y-%m-%d")
            for p in found:
                if p["date"] == stamp:
                    p["state"] = "forming"
        return found

    def candle_scan(self, direction: str | None = None, sessions: int = 1, sector: str | None = None,
                    watched_only: bool = False, reversals_only: bool = False) -> dict:
        """Candle patterns completed in the latest `sessions` completed sessions, across the market.

        Like the strategy signals, a stock whose last bar is older than the latest completed session
        is left out: a pattern on a stale bar is not news.
        """
        latest = self.market.latest_settled()
        out: list[dict] = []
        if latest is None:
            return {"as_of": None, "sessions": sessions, "stocks_read": 0, "matches": out}
        read = 0
        for row in self.stock_rows(sector):
            if watched_only and not row.get("watched"):
                continue
            df = self.market.bars(row["symbol"], settled=True)
            if df is None or len(df) < 30 or df.index[-1] != latest:
                continue
            read += 1
            for p in candles.patterns(df.tail(CANDLE_CONTEXT), last=sessions):
                if direction and p["direction"] != direction:
                    continue
                if reversals_only and p["kind"] != "reversal":
                    continue
                out.append({"symbol": row["symbol"], "company": row.get("name"), "sector": row.get("sector"), **p})
        out.sort(key=lambda m: (m["date"], m["symbol"]), reverse=True)
        return {"as_of": latest.strftime("%Y-%m-%d"), "sessions": sessions, "stocks_read": read, "matches": out}

    # ---- watchlist & categories -----------------------------------------
    def set_watch(self, symbol: str, on: bool) -> None:
        symbol = symbol.upper()
        if self.market.instrument(symbol) is None:
            raise NotFound(f"unknown symbol {symbol}")
        if on:
            self.store.put("watchlist", symbol, {"symbol": symbol, "added_at": now_iso()})
        else:
            self.store.delete("watchlist", symbol)

    def watchlist(self) -> list[dict]:
        symbols = [w["symbol"] for w in self.store.list("watchlist")]
        return [r for r in self.stock_rows() if r["symbol"] in symbols]

    def save_category(self, name: str, symbols: list[str], id: str | None = None) -> dict:
        known = {i["symbol"] for i in self.market.instruments()}
        symbols = sorted({s.strip().upper() for s in symbols if s.strip()})
        unknown = [s for s in symbols if s not in known]
        if unknown:
            raise NotFound(f"unknown symbol(s): {', '.join(unknown)}")
        if id is not None and self.store.get("categories", id) is None:
            raise NotFound("category not found")
        doc = {"id": id or uuid.uuid4().hex[:12], "name": name.strip(), "symbols": symbols}
        with self.store.transaction():
            self.store.put("categories", doc["id"], doc)
            self.audit("save", "category", doc)
        return doc

    # ---- portfolio -------------------------------------------------------
    def _new_portfolio(self, capital, reason: str) -> dict:
        pid = uuid.uuid4().hex[:12]
        capital = money(capital)
        if capital <= 0:
            raise LedgerError("starting capital must be positive")
        doc = {"id": pid, "created_at": now_iso(), "starting_capital": str(capital), "mode": "paper"}
        self.store.put("portfolios", pid, doc)
        self.store.append(f"ledger_{pid}", {"type": "DEPOSIT", "amount": str(capital), "ts": now_iso(),
                                             "trade_date": None, "note": "Starting paper capital"})
        cfg = self.app_settings()
        cfg["active_portfolio_id"] = pid
        self._save_settings(cfg)
        self.audit("create", "portfolio", {**doc, "reason": reason})
        return doc

    def reset_portfolio(self) -> dict:
        """Start a fresh paper portfolio. The previous ledger is kept, never deleted."""
        with self.store.transaction():
            return self._new_portfolio(D(self.app_settings()["starting_capital"]), reason="reset")

    def _ledger_coll(self) -> str:
        return f"ledger_{self.app_settings()['active_portfolio_id']}"

    def _last_price(self, symbol: str) -> tuple[Decimal, str] | None:
        """Latest known price of a stock and the day it is from, or None when there is no price at all."""
        df = self.market.bars(symbol)
        if df is None or len(df) == 0:
            return None
        return px(float(df["close"].iloc[-1])), df.index[-1].strftime("%Y-%m-%d")

    def _fill(self, symbol: str, trade_date: str | None) -> tuple[Decimal, str, str]:
        """Price of a paper order: (price, the day that price is from, the session the trade is dated with).

        An order placed now belongs to the market's current session and is filled at the
        stock's latest price, even if that stock has not traded yet today: every order of
        a session carries the same date, so the ledger stays in order. A back-dated order
        (API only) is filled at that day's close and must have a bar on that day.
        """
        df = self.market.bars(symbol)
        if df is None or len(df) == 0:
            raise LedgerError(f"no price data for {symbol}")
        if trade_date is None:
            price_day = df.index[-1]
            latest = self.market.latest_date()
            session = max(price_day, pd.Timestamp(latest)) if latest else price_day
            return px(float(df["close"].iloc[-1])), price_day.strftime("%Y-%m-%d"), session.strftime("%Y-%m-%d")
        ts = pd.Timestamp(trade_date)
        if ts not in df.index:
            raise LedgerError(f"{symbol} has no bar on {trade_date} (not a session, or data missing)")
        return px(float(df.loc[ts, "close"])), trade_date, trade_date

    @staticmethod
    def _check_order(txs: list[dict], used_date: str) -> None:
        dated = [t["trade_date"] for t in txs if t.get("trade_date")]
        if dated and used_date < max(dated):
            raise LedgerError(f"trade date {used_date} is before the last recorded trade ({max(dated)}); the ledger is chronological")

    def preview_trade(self, side: str, symbol: str, qty: int, trade_date: str | None) -> dict:
        symbol = symbol.upper()
        if self.market.instrument(symbol) is None or self.market.instrument(symbol)["type"] != "stock":
            raise NotFound(f"unknown stock {symbol}")
        price, price_date, used_date = self._fill(symbol, trade_date)
        txs = self.store.list(self._ledger_coll())
        state = replay(txs)
        schedule = self.fee_schedule()
        gross = money(price * qty)
        fees = compute_fees(schedule, side.lower(), gross)
        error = None
        try:  # exactly the checks the order itself goes through, so the preview never promises what posting refuses
            self._check_order(txs, used_date)
            build_trade(state, schedule, side=side, symbol=symbol, qty=qty, price=price)
        except LedgerError as exc:
            error = str(exc)
        held = state.positions[symbol].qty if symbol in state.positions else 0
        return clean({
            "symbol": symbol, "side": side, "qty": qty, "price": price, "trade_date": used_date, "price_date": price_date,
            "price_source": self.market.source(symbol), "gross": gross,
            "fees": fees["items"], "fees_total": fees["total"], "fees_verified": schedule.verified,
            "net_cash": -(gross + fees["total"]) if side == "BUY" else gross - fees["total"],
            "cash_available": money(state.cash), "held_qty": held, "error": error,
        })

    @retry_conflict
    def post_trade(self, side: str, symbol: str, qty: int, trade_date: str | None, note: str,
                   client_order_id: str | None, origin: str = "manual") -> dict:
        from . import paper
        symbol = symbol.upper()
        insx = self.market.instrument(symbol)
        if insx is None or insx["type"] != "stock":
            raise NotFound(f"unknown stock {symbol}")
        with self.store.transaction():
            coll = self._ledger_coll()
            if client_order_id:
                for tx in self.store.list(coll):
                    if tx.get("client_order_id") == client_order_id:
                        return tx  # idempotent retry: already posted
            # Automatic runs first take every completed session they have not handled yet, so their
            # fills are recorded before this order rather than squeezed in behind it later.
            paper.process_runs(self)
            txs = self.store.list(coll)
            price, price_date, used_date = self._fill(symbol, trade_date)
            self._check_order(txs, used_date)
            latest = self.market.latest_date()
            tx = build_trade(replay(txs), self.fee_schedule(), side=side, symbol=symbol, qty=qty, price=price)
            tx.update(ts=now_iso(), trade_date=used_date, price_date=price_date, price_source=self.market.source(symbol),
                      note=note.strip(), origin=origin, mode="paper", client_order_id=client_order_id,
                      # filled at a past day's close, with what happened since already known
                      backdated=bool(trade_date and latest and used_date < latest.isoformat()))
            saved = self.store.append(coll, tx)
            self.audit("post", "paper_trade", {"seq": saved["seq"], "side": side, "symbol": symbol, "qty": qty,
                                              "price": tx["price"], "trade_date": used_date, "origin": origin})
            return saved

    def trades(self) -> dict:
        state = replay(self.store.list(self._ledger_coll()))
        rows, latest = [], {}
        for r in state.rows:
            # What the stock is at now, beside what the trade was filled at. It is read, never stored:
            # the ledger keeps only what happened.
            now = {}
            symbol = r.get("symbol")
            if symbol and "price" in r:
                if symbol not in latest:
                    latest[symbol] = self._last_price(symbol)
                if latest[symbol]:
                    last, as_of = latest[symbol]
                    filled = D(r["price"])
                    now = {"last": last, "last_as_of": as_of,
                           "since_pct": round((last - filled) / filled * 100, 2) if filled else None}
            rows.append(clean({
                **now,
                **{k: r.get(k) for k in ("seq", "ts", "type", "symbol", "qty", "trade_date", "note", "price_source",
                                         "fees_verified", "remaining_qty", "origin", "price_date", "backdated")},
                "price": D(r["price"]) if "price" in r else None,
                "gross": D(r["gross"]) if "gross" in r else D(r.get("amount", 0)),
                "fees": [{**i, "amount": D(i["amount"])} for i in r.get("fees", [])],
                "fees_total": D(r.get("fees_total", 0)),
                "cash_delta": money(r["cash_delta"]),
                "cash_after": r["cash_after"],
                "avg_cost": px(r["avg_cost"]) if "avg_cost" in r else None,
                "realized_gross": r.get("realized_gross"),
                "buy_fees_allocated": r.get("buy_fees_allocated"),
                "realized_net": r.get("realized_net"),
            }))
        return {
            "transactions": rows[::-1],
            "totals": clean({
                "buys_gross": money(state.buys_gross), "sells_gross": money(state.sells_gross),
                "fees_paid": money(state.fees_paid), "realized_gross": money(state.realized_gross),
                "realized_net": money(state.realized_net), "count": sum(1 for r in rows if r["type"] != "DEPOSIT"),
            }),
        }

    def portfolio(self) -> dict:
        pid = self.app_settings()["active_portfolio_id"]
        self.store.warm(gets=[("settings", "fees"), ("portfolios", pid)],
                        lists=[self._ledger_coll(), *self.import_lists()])
        txs = self.store.list(self._ledger_coll())
        state = replay(txs)
        schedule = self.fee_schedule()
        sector_of = {i["symbol"]: i for i in self.market.instruments()}
        holdings, by_sector, warnings = [], {}, []
        mv_total = unreal_gross = unreal_net = est_exit = ZERO
        for pos in state.positions.values():
            if pos.qty == 0:
                continue
            ins = sector_of.get(pos.symbol, {})
            known = self._last_price(pos.symbol)
            if known is None:
                # A holding must never make the whole portfolio unreadable: carry it at what was paid.
                price, as_of = px(pos.avg_price), None
                warnings.append(f"{pos.symbol} has no price data any more: it is carried at its cost, not a market price.")
            else:
                price, as_of = known
                if ins.get("listed") is False:
                    warnings.append(f"{pos.symbol} is no longer in the market feed: it is valued at its last price, from {as_of}.")
            value = money(price * pos.qty)
            sell_fee = compute_fees(schedule, "sell", value)["total"]
            gross = value - pos.cost
            net = gross - pos.buy_fees - sell_fee
            mv_total += value
            unreal_gross += gross
            unreal_net += net
            est_exit += sell_fee
            sector = ins.get("sector", "Unknown")
            by_sector[sector] = by_sector.get(sector, ZERO) + value
            holdings.append({
                "symbol": pos.symbol, "name": ins.get("name"), "sector": sector,
                "qty": pos.qty, "avg_price": px(pos.avg_price), "last": price, "as_of": as_of,
                "source": self.market.source(pos.symbol), "priced": known is not None,
                "cost": money(pos.cost), "market_value": value, "buy_fees": money(pos.buy_fees),
                "est_sell_fees": sell_fee, "unrealized_gross": money(gross), "unrealized_net_est": money(net),
                "unrealized_gross_pct": gross / pos.cost * 100 if pos.cost else None,
            })
        value_total = state.cash + mv_total
        for h in holdings:
            h["weight_pct"] = h["market_value"] / value_total * 100 if value_total else None
        net_total = state.realized_net + unreal_net
        max_stock = max((h["weight_pct"] for h in holdings), default=ZERO)
        max_sector = max((v / value_total * 100 for v in by_sector.values()), default=ZERO) if value_total else ZERO
        if max_stock > 25:
            warnings.append(f"Single-stock concentration: one holding is {max_stock:.1f}% of the portfolio.")
        if max_sector > 40:
            warnings.append(f"Sector concentration: one sector is {max_sector:.1f}% of the portfolio.")
        return clean({
            "portfolio": self.store.get("portfolios", self.app_settings()["active_portfolio_id"]),
            "mode": "paper",
            "summary": {
                "starting_capital": money(state.deposits), "cash": money(state.cash),
                "invested_cost": money(sum((h["cost"] for h in holdings), ZERO)),
                "market_value": money(mv_total), "total_value": money(value_total),
                "realized_gross": money(state.realized_gross), "realized_net": money(state.realized_net),
                "unrealized_gross": money(unreal_gross), "unrealized_net_est": money(unreal_net),
                "fees_paid": money(state.fees_paid), "est_exit_fees": money(est_exit),
                "total_gross": money(state.realized_gross + unreal_gross),
                "total_net": money(net_total),
                "return_gross_pct": (state.realized_gross + unreal_gross) / state.deposits * 100 if state.deposits else None,
                "return_net_pct": net_total / state.deposits * 100 if state.deposits else None,
                "fees_verified": schedule.verified,
            },
            "holdings": sorted(holdings, key=lambda h: -h["market_value"]),
            "sector_allocation": sorted(
                ({"sector": s, "market_value": money(v), "weight_pct": v / value_total * 100} for s, v in by_sector.items()),
                key=lambda r: -r["market_value"]),
            "cash_weight_pct": state.cash / value_total * 100 if value_total else None,
            "warnings": warnings,
            "history": self._portfolio_history(state.rows),
        })

    def _portfolio_history(self, rows: list[dict]) -> dict:
        """Portfolio value at each session's close since the first trade.

        One pass over the trades in date order, carrying cash and share counts forward
        (the ledger is not replayed for every charted day).
        """
        dated = sorted((r for r in rows if r.get("trade_date")), key=lambda r: (r["trade_date"], r["seq"]))
        if not dated:
            return {"curve": [], "benchmark": None}
        closes = self.market.closes(sorted({r["symbol"] for r in dated}))
        if closes.empty:  # none of the traded stocks has a price history any more
            return {"curve": [], "benchmark": None}
        closes = closes[closes.index >= pd.Timestamp(dated[0]["trade_date"])].ffill()
        cash = sum((D(r["cash_delta"]) for r in rows if not r.get("trade_date")), ZERO)  # the starting deposit
        held: dict[str, int] = {}
        paid: dict[str, Decimal] = {}  # last traded price, used on a day the stock has no close yet
        curve, i = [], 0
        columns = list(closes.columns)
        for ts, row in zip(closes.index, closes.to_numpy(), strict=True):
            day = ts.strftime("%Y-%m-%d")
            while i < len(dated) and dated[i]["trade_date"] <= day:
                r = dated[i]
                cash += D(r["cash_delta"])
                held[r["symbol"]] = held.get(r["symbol"], 0) + (r["qty"] if r["type"] == "BUY" else -r["qty"])
                paid[r["symbol"]] = D(r["price"])
                i += 1
            price = dict(zip(columns, row, strict=True))
            value = cash
            for symbol, qty in held.items():
                if qty:
                    close = price.get(symbol)
                    value += (D(float(close)) if close is not None and close == close else paid[symbol]) * qty
            curve.append({"date": day, "value": f(value)})
        bench = None
        bsym = self.app_settings()["benchmark"]
        bdf = self.market.bars(bsym)
        if bdf is not None and curve:
            b = bdf["close"].reindex(closes.index).ffill().dropna()
            if len(b) >= 2:
                base = curve[0]["value"]
                bench = {"symbol": bsym, "source": self.market.source(bsym),
                         "curve": [{"date": d.strftime("%Y-%m-%d"), "value": round(float(v / b.iloc[0]) * base, 2)} for d, v in b.items()]}
        return {"curve": curve, "benchmark": bench}

    # ---- strategies & backtests -----------------------------------------
    def save_strategy(self, cfg: StrategyConfig, id: str | None = None) -> dict:
        known = {i["symbol"] for i in self.market.instruments()}
        unknown = [s for s in cfg.symbols if s not in known]
        if unknown:
            raise NotFound(f"unknown symbol(s): {', '.join(unknown)}")
        with self.store.transaction():
            before = self.store.get("strategies", id) if id else None
            if id and before is None:
                raise NotFound("strategy not found")
            doc = {**cfg.model_dump(mode="json"), "id": id or uuid.uuid4().hex[:12],
                   "created_at": before["created_at"] if before else now_iso(), "updated_at": now_iso()}
            self.store.put("strategies", doc["id"], doc)
            self.audit("update" if before else "create", "strategy", {"before": before, "after": doc})
            return doc

    def delete_strategy(self, id: str) -> None:
        with self.store.transaction():
            before = self.store.get("strategies", id)
            if before is None:
                raise NotFound("strategy not found")
            self.store.delete("strategies", id)
            self.audit("delete", "strategy", {"before": before})

    def strategy_universe(self, cfg: StrategyConfig, override: list[str] | None = None) -> list[str]:
        stocks = self.market.instruments()
        if override:
            wanted = {s.upper() for s in override}
            return sorted(i["symbol"] for i in stocks if i["symbol"] in wanted)
        if cfg.symbols or cfg.sectors:
            return sorted(i["symbol"] for i in stocks if i["symbol"] in cfg.symbols or i["sector"] in cfg.sectors)
        return sorted(i["symbol"] for i in stocks)

    def backtest(self, cfg: StrategyConfig, *, strategy_id: str | None, symbols: list[str] | None,
                 start: str | None, end: str | None, capital: Decimal | None) -> dict:
        universe = self.strategy_universe(cfg, symbols)
        frames = {s: df for s in universe if (df := self.market.bars(s, settled=True)) is not None and len(df) > 1}
        bsym = self.app_settings()["benchmark"]
        bdf = self.market.bars(bsym, settled=True)
        schedule = self.fee_schedule()
        result = run_backtest(
            cfg, frames, schedule, start=start, end=end,
            capital=capital if capital is not None else D(self.app_settings()["starting_capital"]),
            benchmark=bdf["close"] if bdf is not None else None, benchmark_name=bsym,
        )
        sources = sorted({self.market.source(s) for s in result["symbols"]})
        if "sample" in sources:
            result["warnings"].insert(0, "Run on SAMPLE (synthetic) prices: results say nothing about real EGX stocks.")
        doc = self._fit(clean({
            "id": uuid.uuid4().hex[:12], "ts": now_iso(), "strategy_id": strategy_id,
            "strategy": cfg.model_dump(mode="json"), "fee_schedule": schedule.model_dump(mode="json"),
            "data_sources": sources, "mode": "backtest", **result,
        }))
        with self.store.transaction():
            self.store.put("backtests", doc["id"], doc)
            self.audit("run", "backtest", {"id": doc["id"], "strategy": cfg.name, "symbols": len(result["symbols"]),
                                           "period": result["period"], "net_profit": doc["metrics"]["net_profit"]})
        return doc

    @staticmethod
    def _fit(doc: dict) -> dict:
        """Keep a backtest small enough to store: the latest trades in full, the curves thinned if needed.

        The metrics always describe every trade; only the stored trade list is shortened.
        """
        total = len(doc["trades"])
        doc["trades_total"] = total
        if total > MAX_STORED_TRADES:
            doc["trades"] = doc["trades"][-MAX_STORED_TRADES:]

        def size() -> int:
            return len(json.dumps(doc, separators=(",", ":")))

        while size() > MAX_BACKTEST_BYTES and len(doc["trades"]) > 50:
            doc["trades"] = doc["trades"][len(doc["trades"]) // 2:]
        while size() > MAX_BACKTEST_BYTES and len(doc["equity_curve"]) > 120:
            doc["equity_curve"] = doc["equity_curve"][::2] + doc["equity_curve"][-1:]
            for key in ("benchmark", "buy_and_hold"):
                if doc.get(key) and doc[key].get("curve"):
                    doc[key]["curve"] = doc[key]["curve"][::2] + doc[key]["curve"][-1:]
        if len(doc["trades"]) < total:
            doc["warnings"] = [*doc["warnings"], f"The {len(doc['trades'])} most recent of {total} trades are listed; "
                                                 "the results cover all of them."]
        return doc

    def compare(self, strategy_ids: list[str], *, symbols: list[str] | None, start: str | None, end: str | None,
                capital: Decimal | None) -> dict:
        """Backtest several strategies over the same stocks, period, capital and fees, side by side."""
        docs = []
        for sid in strategy_ids:
            doc = self.store.get("strategies", sid)
            if doc is None:
                raise NotFound("strategy not found")
            docs.append(doc)
        # One shared universe: the stocks given, or every stock, never each strategy's own scope.
        universe = symbols or [i["symbol"] for i in self.market.instruments()]
        runs = []
        for doc in docs:
            cfg = StrategyConfig.model_validate({k: doc[k] for k in StrategyConfig.model_fields})
            run = self.backtest(cfg, strategy_id=doc["id"], symbols=universe, start=start, end=end, capital=capital)
            runs.append({k: run[k] for k in ("id", "strategy_id", "period", "metrics", "warnings", "equity_curve")}
                        | {"name": doc["name"], "stocks": len(run["symbols"])})
        return {"runs": runs, "benchmark": None, "same": {"stocks": runs[0]["stocks"], "period": runs[0]["period"],
                                                          "capital": runs[0]["metrics"]["starting_capital"]}}

    def backtests(self) -> list[dict]:
        docs = sorted(self.store.list("backtests"), key=lambda d: d["ts"], reverse=True)
        return [{k: d[k] for k in ("id", "ts", "strategy_id", "period", "symbols", "metrics", "data_sources", "warnings")}
                | {"strategy_name": d["strategy"]["name"], "strategy_type": d["strategy"]["type"]} for d in docs]

    def active_signals(self) -> list[dict]:
        """Entry/exit signals of the latest completed session for every saved strategy. Informational only.

        A stock whose last bar is older than that session (suspended, or simply not traded)
        gives no signal: a cross that happened months ago is not news today.
        """
        out = []
        latest = self.market.latest_settled()
        for doc in self.store.list("strategies"):
            cfg = StrategyConfig.model_validate({k: doc[k] for k in StrategyConfig.model_fields})
            for symbol in self.strategy_universe(cfg):
                df = self.market.bars(symbol, settled=True)  # signals are read on completed sessions only
                if df is None or len(df) < 30 or df.index[-1] != latest:
                    continue
                last = signals(cfg, df).iloc[-1]
                if last["entry"] or last["exit"]:
                    out.append({"strategy_id": doc["id"], "strategy": doc["name"], "symbol": symbol,
                                "signal": "entry" if last["entry"] else "exit",
                                "date": df.index[-1].strftime("%Y-%m-%d"), "close": float(df["close"].iloc[-1]),
                                "source": self.market.source(symbol)})
        return out
