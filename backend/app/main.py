"""EGX Intelligence API. Trading here is on paper, with one exception that is fenced off:

the owner of the brokerage account can look at it (app/broker.py), can send a real order they
approved themselves (app/real_orders.py), and can approve in advance what fits a box they set
(app/real_auto.py), which then goes out the same way. Nothing else in this service reaches a broker."""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import time
from collections import OrderedDict
from datetime import date
from decimal import Decimal
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import assistant, background, broker, orders, paper, push, real_auto, real_orders
from .accounts import AccountError, Accounts
from .assistant_prefs import PrefsIn, save_prefs
from .config import Settings, get_settings
from .data.calendar import market_open
from .data.feed import Feed, FirestoreDocs, StoreDocs
from .data.market import DataError
from .data.younit import YounitClient, YounitError, YounitRateLimit
from .domain.backtest import BacktestError
from .domain.fees import FeeSchedule
from .domain.ledger import LedgerError
from .domain.strategies import STRATEGY_TYPES, StrategyConfig
from .extras import AlertIn, Extras, JournalIn, ResearchIn
from .llm import ClaudeModel
from .services import App, NotFound, clean
from .store.errors import AuthError, ConflictError
from .store.firestore_store import FirestoreStore, uid_from_token
from .store.sqlite_store import Store

MAX_CSV_BYTES = 5 * 1024 * 1024
STREAM_SECONDS = 240.0  # one streaming response; kept under the function time limit
NO_BUFFERING = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


class TradeIn(BaseModel):
    side: Literal["BUY", "SELL"]
    symbol: str = Field(min_length=1, max_length=12)
    qty: int = Field(gt=0, le=100_000_000)
    trade_date: date | None = None
    note: str = Field(default="", max_length=1000)
    client_order_id: str | None = Field(default=None, max_length=64)


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    symbols: list[str] = Field(default_factory=list, max_length=300)


class AppSettingsIn(BaseModel):
    starting_capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))
    benchmark: str | None = Field(default=None, max_length=12)


class CompareIn(BaseModel):
    strategy_ids: list[str] = Field(min_length=2, max_length=4)
    symbols: list[str] | None = Field(default=None, max_length=400)
    start: date | None = None
    end: date | None = None
    capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))


class PaperRunIn(BaseModel):
    strategy_id: str = Field(min_length=1, max_length=40)
    capital: Decimal = Field(gt=0, le=Decimal("1000000000"))
    symbols: list[str] | None = Field(default=None, max_length=400)


class PaperRunStatusIn(BaseModel):
    status: Literal["active", "paused", "stopped"]


class AccountIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=128)


class AccountActiveIn(BaseModel):
    active: bool


class AssistantMessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=assistant.MAX_MESSAGE_CHARS)
    page: str | None = Field(default=None, max_length=200)


class AssistantResolveIn(BaseModel):
    decisions: dict[str, Literal["approve", "decline"]] = Field(max_length=40)


class AssistantAccessIn(BaseModel):
    access: Literal["full", "confirm", "read"]


class BacktestIn(BaseModel):
    strategy_id: str | None = None
    strategy: StrategyConfig | None = None
    symbols: list[str] | None = Field(default=None, max_length=300)
    start: date | None = None
    end: date | None = None
    capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))


MAX_CACHED_USERS = 20


def create_app(settings: Settings | None = None, store: Store | None = None, younit=None, assistant_model=None) -> FastAPI:
    settings = settings or get_settings()
    if younit is None and settings.younit_trading_id and settings.younit_api_key:
        younit = YounitClient(settings.younit_trading_id, settings.younit_api_key)
    if assistant_model is None and settings.anthropic_api_key:
        assistant_model = ClaudeModel(settings.anthropic_api_key, settings.assistant_model, settings.assistant_effort)
    firestore = settings.store_backend == "firestore"
    if firestore and not settings.firebase_project_id:
        raise RuntimeError("FIREBASE_PROJECT_ID is required when STORE_BACKEND=firestore")
    local_store = None if firestore else (store or Store(settings.data_dir / "egx.sqlite3"))
    caches: OrderedDict[str, dict] = OrderedDict()

    def core_for(uid: str | None, token: str | None) -> App:
        """The application object for one person: the signed-in caller of a request, or the owner the timer works for."""
        if not firestore:
            feed = Feed(StoreDocs(local_store)) if younit else None
            core = App(local_store, settings, caches.setdefault("local", {}), feed, younit).bootstrap()
            core.real_account_allowed = broker.may_view(settings, None, signed_in=False)
            return core
        # bootstrap() reads the user's settings first; Firestore rejects that read
        # unless the token is genuine, so the cache below is never reached by a forgery.
        core = App(FirestoreStore(settings.firebase_project_id, token, uid), settings, {},
                   Feed(FirestoreDocs(settings.firebase_project_id, token)) if younit else None, younit)
        core.bootstrap()
        # Only now is the uid proven: the read above was refused unless the token is genuine.
        core.uid, core.signed_in = uid, True
        core.real_account_allowed = broker.may_view(settings, uid, signed_in=True)
        core.cache = caches.setdefault(uid, {})
        core.market.cache = core.cache.setdefault("market", {})
        caches.move_to_end(uid)
        while len(caches) > MAX_CACHED_USERS:
            caches.popitem(last=False)
        return core

    def get_core(request: Request) -> App:
        """Build the per-request application object for the signed-in user."""
        if not firestore:
            return core_for(None, None)
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise AuthError("sign in to use the app")
        token = header[7:].strip()
        return core_for(uid_from_token(token), token)

    api = FastAPI(title="EGX Intelligence API", version="0.2.0",
                  docs_url=None if firestore else "/docs", redoc_url=None, openapi_url=None if firestore else "/openapi.json")
    api.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_methods=["*"], allow_headers=["*"], expose_headers=["Content-Disposition"],
    )

    @api.exception_handler(AuthError)
    async def _auth(_: Request, exc: AuthError):
        return JSONResponse({"detail": str(exc)}, status_code=401)

    @api.exception_handler(ConflictError)
    async def _conflict(_: Request, exc: ConflictError):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @api.exception_handler(NotFound)
    async def _not_found(_: Request, exc: NotFound):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @api.exception_handler(broker.NotAllowed)
    async def _not_the_owner(_: Request, exc: broker.NotAllowed):
        return JSONResponse({"detail": str(exc)}, status_code=403)

    @api.exception_handler(YounitError)
    async def _feed_down(_: Request, exc: YounitError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @api.exception_handler(YounitRateLimit)
    async def _feed_busy(_: Request, exc: YounitRateLimit):
        return JSONResponse({"detail": str(exc), "retry_after": exc.retry_after}, status_code=429,
                            headers={"Retry-After": str(exc.retry_after)})

    @api.exception_handler(assistant.Blocked)
    async def _assistant_blocked(_: Request, exc: assistant.Blocked):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @api.exception_handler(real_orders.OrderError)
    @api.exception_handler(background.BackgroundError)
    @api.exception_handler(push.PushError)
    @api.exception_handler(AccountError)
    @api.exception_handler(LedgerError)
    @api.exception_handler(DataError)
    @api.exception_handler(BacktestError)
    async def _rule_violation(_: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    def iso(d: date | None) -> str | None:
        return d.isoformat() if d else None

    # ---- system ----------------------------------------------------------
    @api.get("/health")
    def health(probe: bool = False):
        out = {"status": "ok", "environment": settings.app_env, "region": os.environ.get("VERCEL_REGION"),
               "assistant": assistant_model is not None}  # whether a key is saved; never the key
        if probe and firestore:
            # How far is the database from this server? Timed with requests that carry no
            # credentials and are refused, so nothing is read.
            url = (f"https://firestore.googleapis.com/v1/projects/{settings.firebase_project_id}"
                   "/databases/(default)/documents/egxMarket/meta")
            times = []
            with httpx.Client(timeout=10.0) as client:
                for _ in range(6):
                    started = time.monotonic()
                    client.get(url)
                    times.append(round((time.monotonic() - started) * 1000))
            out["database_ms"] = {"first": times[0], "then": sorted(times[1:])}
        return out

    @api.get("/api/v1/ping/stream")
    def health_stream():
        """Five ticks, one a second: shows whether this host delivers a response as it is produced."""
        def ticks():
            for i in range(5):
                yield f"data: {i} {time.time():.1f}\n\n"
                time.sleep(1)
        return StreamingResponse(ticks(), media_type="text/event-stream", headers=NO_BUFFERING)

    @api.get("/api/v1/status")
    def status(core: App = Depends(get_core)):
        core.store.warm(gets=[("settings", "fees")], lists=["instruments", "bars"])
        real = broker.access(core)
        live = real_orders.menu_state(core)
        # Whether this open app should ask for the automation's looks. Sending without the owner is decided
        # at each look, on the server, from everything as it stands then.
        live["auto"] = bool(live["ready"] and real_auto.menu(core))
        live["background"] = bool(live["ready"] and background.menu(core))   # the server also takes looks by itself
        return {
            "trading_mode": "paper",
            "live_trading_enabled": bool(settings.live_trading_enabled),
            "broker_connected": False,
            "broker_note": ("Younit is connected for market data and for the real brokerage account. Real orders are on for this "
                            "sign-in, and automatic orders too: while the app is open, what fits the box you set goes to the "
                            "broker without waiting for you. Everything else is paper trading." if live["auto"] else
                            "Younit is connected for market data and for the real brokerage account. Real orders are on for this "
                            "sign-in: each one goes to the broker only after you approve it. Everything else is paper trading."
                            if live["ready"] else
                            "Younit is connected for market data, and this sign-in can look at the real brokerage account. "
                            "Real orders are off, so nothing can be sent to the broker." if real["allowed"]
                            else "Younit is connected for market data only (read-only). Nothing here can send an order to a broker."
                            if younit else "Younit is not connected. Nothing here can send an order to a broker."),
            "real_account": real,
            "real_orders": live,
            "provider": core.provider_status(),
            "data": core.market.status(),
            "storage": settings.store_backend,
            "fees_verified": core.fee_schedule().verified,
        }

    # ---- market ----------------------------------------------------------
    @api.get("/api/v1/market/overview")
    def market_overview(core: App = Depends(get_core)):
        return core.market_overview()

    @api.get("/api/v1/market/sectors")
    def market_sectors(core: App = Depends(get_core)):
        return core.sectors()

    @api.get("/api/v1/stocks")
    def stocks(core: App = Depends(get_core), *, sector: str | None = None, q: str | None = Query(default=None, max_length=60),
               category: str | None = None):
        return core.stock_rows(sector, q, category)

    def sse(ticks, hello: dict):
        """Server-sent events from a generator of ticks (None = keep-alive)."""
        def events():
            yield f"event: hello\ndata: {json.dumps(hello)}\n\n"
            try:
                for tick in ticks:
                    if tick is None:
                        yield ": keep-alive\n\n"
                    else:
                        yield f"data: {json.dumps(clean(tick), separators=(',', ':'))}\n\n"
                yield "event: end\ndata: {}\n\n"
            except YounitError as exc:
                yield f"event: failed\ndata: {json.dumps({'detail': str(exc)})}\n\n"
            finally:
                ticks.close()  # hang up on the feed as soon as the page stops listening
        return StreamingResponse(events(), media_type="text/event-stream", headers=NO_BUFFERING)

    @api.get("/api/v1/market/stream")
    def market_stream(core: App = Depends(get_core)):
        """Server-sent events: the latest price of every stock, as trades happen."""
        ticks, indices = core.follow_market(STREAM_SECONDS)
        return sse(ticks, {"market_open": market_open(), "indices": {str(k): v for k, v in indices.items()}})

    @api.get("/api/v1/stocks/{symbol}/stream")
    def stock_stream(core: App = Depends(get_core), *, symbol: str):
        """Server-sent events: one message per change in the stock's price or order book.

        The connection to the feed lives on the server, so the feed's credentials
        never reach the browser. A stream ends by itself before the host's time
        limit; the page simply opens the next one.
        """
        ticks = core.follow(symbol, STREAM_SECONDS)  # validates the symbol before any bytes are sent
        return sse(ticks, {"market_open": market_open()})

    @api.get("/api/v1/stocks/{symbol}/depth")
    def stock_depth(core: App = Depends(get_core), *, symbol: str):
        return core.depth(symbol)

    @api.get("/api/v1/stocks/{symbol}")
    def stock(core: App = Depends(get_core), *, symbol: str, timeframe: Literal["d", "w", "m"] = "d"):
        return core.stock_detail(symbol, timeframe)

    # ---- watchlist & categories -----------------------------------------
    @api.get("/api/v1/watchlist")
    def watchlist(core: App = Depends(get_core)):
        return core.watchlist()

    @api.put("/api/v1/watchlist/{symbol}")
    def watch(core: App = Depends(get_core), *, symbol: str):
        core.set_watch(symbol, True)
        return {"symbol": symbol.upper(), "watched": True}

    @api.delete("/api/v1/watchlist/{symbol}")
    def unwatch(core: App = Depends(get_core), *, symbol: str):
        core.set_watch(symbol, False)
        return {"symbol": symbol.upper(), "watched": False}

    @api.get("/api/v1/categories")
    def categories(core: App = Depends(get_core)):
        return core.store.list("categories")

    @api.post("/api/v1/categories", status_code=201)
    def create_category(core: App = Depends(get_core), *, body: CategoryIn):
        return core.save_category(body.name, body.symbols)

    @api.put("/api/v1/categories/{id}")
    def update_category(core: App = Depends(get_core), *, id: str, body: CategoryIn):
        return core.save_category(body.name, body.symbols, id)

    @api.delete("/api/v1/categories/{id}")
    def delete_category(core: App = Depends(get_core), *, id: str):
        if not core.store.delete("categories", id):
            raise HTTPException(404, "category not found")
        core.audit("delete", "category", {"id": id})
        return {"deleted": id}

    # ---- portfolio & trades ---------------------------------------------
    @api.get("/api/v1/portfolio")
    def portfolio(core: App = Depends(get_core)):
        return core.portfolio()

    @api.post("/api/v1/portfolio/reset")
    def reset_portfolio(core: App = Depends(get_core)):
        return core.reset_portfolio()

    @api.get("/api/v1/trades")
    def trades(core: App = Depends(get_core)):
        return core.trades()

    @api.post("/api/v1/trades/preview")
    def preview_trade(core: App = Depends(get_core), *, body: TradeIn):
        return core.preview_trade(body.side, body.symbol, body.qty, iso(body.trade_date))

    @api.post("/api/v1/trades", status_code=201)
    def post_trade(core: App = Depends(get_core), *, body: TradeIn):
        return core.post_trade(body.side, body.symbol, body.qty, iso(body.trade_date), body.note, body.client_order_id)

    @api.get("/api/v1/trades/export.csv")
    def export_trades(core: App = Depends(get_core)):
        buf = io.StringIO()
        cols = ["seq", "ts", "trade_date", "type", "symbol", "qty", "price", "gross", "fees_total", "cash_delta",
                "cash_after", "avg_cost", "realized_gross", "buy_fees_allocated", "realized_net", "price_source", "note"]
        w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for row in reversed(core.trades()["transactions"]):
            w.writerow({k: ("" if row.get(k) is None else row.get(k)) for k in cols})
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": 'attachment; filename="egx-paper-trades.csv"'})

    # ---- settings --------------------------------------------------------
    @api.get("/api/v1/settings")
    def get_app_settings(core: App = Depends(get_core)):
        return core.app_settings()

    @api.put("/api/v1/settings")
    def put_app_settings(core: App = Depends(get_core), *, body: AppSettingsIn):
        return core.update_app_settings(starting_capital=body.starting_capital, benchmark=body.benchmark)

    @api.get("/api/v1/settings/fees")
    def get_fees(core: App = Depends(get_core)):
        return core.fee_schedule()

    @api.put("/api/v1/settings/fees")
    def put_fees(core: App = Depends(get_core), *, body: FeeSchedule):
        return core.update_fee_schedule(body)

    # ---- strategies & backtests -----------------------------------------
    @api.get("/api/v1/strategy-types")
    def strategy_types(core: App = Depends(get_core)):
        return STRATEGY_TYPES

    @api.get("/api/v1/strategies")
    def strategies(core: App = Depends(get_core)):
        return core.store.list("strategies")

    @api.post("/api/v1/strategies", status_code=201)
    def create_strategy(core: App = Depends(get_core), *, body: StrategyConfig):
        return core.save_strategy(body)

    @api.put("/api/v1/strategies/{id}")
    def update_strategy(core: App = Depends(get_core), *, id: str, body: StrategyConfig):
        return core.save_strategy(body, id)

    @api.delete("/api/v1/strategies/{id}")
    def delete_strategy(core: App = Depends(get_core), *, id: str):
        core.delete_strategy(id)
        return {"deleted": id}

    @api.get("/api/v1/signals")
    def active_signals(core: App = Depends(get_core)):
        return core.active_signals()

    @api.post("/api/v1/backtests", status_code=201)
    def run_backtest(core: App = Depends(get_core), *, body: BacktestIn):
        if body.strategy is not None:
            cfg = body.strategy
        elif body.strategy_id:
            doc = core.store.get("strategies", body.strategy_id)
            if doc is None:
                raise HTTPException(404, "strategy not found")
            cfg = StrategyConfig.model_validate({k: doc[k] for k in StrategyConfig.model_fields})
        else:
            raise HTTPException(422, "provide strategy_id or strategy")
        return core.backtest(cfg, strategy_id=body.strategy_id, symbols=body.symbols,
                             start=iso(body.start), end=iso(body.end), capital=body.capital)

    @api.get("/api/v1/backtests")
    def list_backtests(core: App = Depends(get_core)):
        return core.backtests()

    @api.get("/api/v1/backtests/{id}")
    def get_backtest(core: App = Depends(get_core), *, id: str):
        doc = core.store.get("backtests", id)
        if doc is None:
            raise HTTPException(404, "backtest not found")
        return doc

    @api.post("/api/v1/data/live")
    def poll_live_prices(core: App = Depends(get_core)):
        """Latest prices while the market is open. The page calls this once a minute."""
        return core.poll_live()

    @api.post("/api/v1/data/refresh")
    def refresh_market_data(core: App = Depends(get_core)):
        """Pull the next batch of prices from the feed. The page calls this until `remaining` is 0."""
        return core.refresh_feed()

    # ---- strategy comparison & automatic paper trading -------------------
    @api.post("/api/v1/backtests/compare", status_code=201)
    def compare_strategies(body: CompareIn, core: App = Depends(get_core)):
        return core.compare(body.strategy_ids, symbols=body.symbols, start=iso(body.start), end=iso(body.end),
                            capital=body.capital)

    @api.get("/api/v1/paper-runs")
    def list_paper_runs(core: App = Depends(get_core)):
        return paper.runs_view(core)

    @api.post("/api/v1/paper-runs", status_code=201)
    def start_paper_run(body: PaperRunIn, core: App = Depends(get_core)):
        return paper.start_run(core, body.strategy_id, body.capital, body.symbols)

    @api.put("/api/v1/paper-runs/{id}")
    def change_paper_run(id: str, body: PaperRunStatusIn, core: App = Depends(get_core)):
        return paper.set_status(core, id, body.status)

    @api.post("/api/v1/paper-runs/process")
    def process_paper_runs(core: App = Depends(get_core)):
        """Fill the orders of every active run up to the latest completed session, then carry out any
        stop-loss or take-profit whose price has been reached."""
        out = paper.process_runs(core)
        done = orders.process(core)
        return {**out, "orders": done["filled"]}

    # ---- the real brokerage account (read-only) ----------------------------
    @api.get("/api/v1/real-account")
    def real_account(core: App = Depends(get_core), *, fresh: bool = False):
        """Cash and holdings of the owner's real brokerage account, with the checks made on them.

        Looks only. Refused (403) for every sign-in except the ones named on the server.
        """
        return broker.view(core, fresh=fresh)

    # ---- real orders: prepared here, sent only on the owner's approval -------
    @api.get("/api/v1/real-orders")
    def list_real_orders(core: App = Depends(get_core)):
        """The switches, the limits and today's use of them, the proposals that wait and the orders that were sent."""
        return real_orders.view(core)

    @api.get("/api/v1/real-orders/settings")
    def get_real_trading_settings(core: App = Depends(get_core)):
        return real_orders.settings_view(core)

    @api.put("/api/v1/real-orders/settings")
    def put_real_trading_settings(body: real_orders.LimitsIn, core: App = Depends(get_core)):
        """The owner's own switch and limits for real orders."""
        return real_orders.save_limits(core, body)

    # ---- automatic real orders: the owner's standing approval, inside a box ---
    @api.get("/api/v1/real-orders/auto")
    def get_real_auto(core: App = Depends(get_core)):
        """The automatic box, whether it is on, what the automation holds, and what it would do with what waits."""
        return real_auto.view(core)

    @api.put("/api/v1/real-orders/auto")
    def put_real_auto(body: real_auto.AutoIn, core: App = Depends(get_core)):
        """The owner's box for automatic orders. Switching it on is refused until hand-approved orders have worked."""
        return real_auto.save(core, body)

    @api.post("/api/v1/real-orders/auto/stop")
    def stop_real_auto(core: App = Depends(get_core)):
        """The one-tap stop: no further automatic order, and the automation's open buys are cancelled."""
        return real_auto.stop(core)

    @api.post("/api/v1/real-orders/auto/tick")
    def tick_real_auto(core: App = Depends(get_core)):
        """One look by the automation, asked for by the owner's open app during the session.

        The only place an order is sent without the owner approving that order. It goes through
        real_orders.send_waiting, which is the owner's approval path with the automatic box in the owner's place.
        """
        result = real_auto.tick(core)
        push.report(core, result)   # the owner's other devices hear of it too
        return result

    @api.put("/api/v1/real-orders/auto/positions/{symbol}")
    def put_real_auto_levels(symbol: str, body: real_auto.LevelsIn, core: App = Depends(get_core)):
        """Move the stop-loss or the take-profit of a position the automation holds."""
        return real_auto.set_levels(core, symbol, body)

    # ---- the same looks without a browser, and word of them to the owner's devices ---
    @api.get("/api/v1/background/look")
    def background_look(request: Request):
        """The hosting platform's timer calls this every minute during the session (vercel.json).

        Not for people: it is answered only when the call carries the platform's own secret. The server then
        signs in as the owner with the key they placed in its environment, and takes the looks their open app
        would have taken.
        """
        background.check_timer(settings, request.headers.get("authorization"))
        return background.wake(settings, core_for, assistant_model, firestore=firestore)

    @api.get("/api/v1/background")
    def get_background(core: App = Depends(get_core)):
        """Whether the server takes looks by itself for this owner, and when it last did."""
        return {**background.view(core), "push": push.status(core)}

    @api.post("/api/v1/background/key")
    def make_background_key(body: background.KeyIn, core: App = Depends(get_core)):
        """Seal the owner's sign-in into a key for the server's environment. Shown once, to its owner."""
        return background.make_key(core, body)

    @api.put("/api/v1/background")
    def put_background(body: background.SwitchIn, core: App = Depends(get_core)):
        return {**background.set_enabled(core, body), "push": push.status(core)}

    @api.post("/api/v1/push/subscribe")
    def push_subscribe(body: push.SubscriptionIn, core: App = Depends(get_core)):
        """This device will be told what the automation did with real money."""
        return push.subscribe(core, body)

    @api.post("/api/v1/push/unsubscribe")
    def push_unsubscribe(body: push.EndpointIn, core: App = Depends(get_core)):
        return push.unsubscribe(core, body)

    @api.post("/api/v1/push/test")
    def push_test(core: App = Depends(get_core)):
        return push.test(core)

    @api.post("/api/v1/real-orders/check")
    def check_real_order(body: real_orders.OrderIn, core: App = Depends(get_core)):
        """What stands in the way of an order, without writing anything down or sending anything."""
        return real_orders.check(core, body)

    @api.post("/api/v1/real-orders", status_code=201)
    def propose_real_order(body: real_orders.OrderIn, core: App = Depends(get_core)):
        """Write a proposal. It is not sent: it waits for approval."""
        return real_orders.propose(core, body, "manual")

    @api.post("/api/v1/real-orders/{id}/check")
    def check_waiting_real_order(id: str, core: App = Depends(get_core)):
        """The last look before approving: the proposal judged as it would be on sending, with fresh figures."""
        return real_orders.check_waiting(core, id)

    @api.post("/api/v1/real-orders/{id}/approve")
    def approve_real_order(id: str, body: real_orders.ApproveIn, core: App = Depends(get_core)):
        """The owner's yes: the one way an order goes to the broker. Reached from the Real account page only;
        the assistant has no tool for it."""
        return real_orders.approve(core, id, body)

    @api.post("/api/v1/real-orders/{id}/decline")
    def decline_real_order(id: str, core: App = Depends(get_core)):
        return real_orders.decline(core, id)

    @api.post("/api/v1/real-orders/{id}/cancel")
    def cancel_real_order(id: str, core: App = Depends(get_core)):
        """Ask the broker to cancel an order of ours that is still open."""
        return real_orders.cancel(core, id)

    @api.post("/api/v1/real-orders/{id}/not-placed")
    def settle_real_order(id: str, core: App = Depends(get_core)):
        """Close an order that was in doubt, after the owner checked at the broker that it was not placed."""
        return real_orders.not_placed(core, id)

    # ---- protective orders ------------------------------------------------
    @api.get("/api/v1/orders")
    def list_orders(core: App = Depends(get_core), *, status: Literal["open", "all"] = "open"):
        return [orders.view(core, o) for o in orders.list_orders(core, status)[:100]]

    @api.post("/api/v1/orders", status_code=201)
    def place_order(body: orders.OrderIn, core: App = Depends(get_core)):
        return orders.view(core, orders.place(core, body))

    @api.delete("/api/v1/orders/{id}")
    def cancel_order(id: str, core: App = Depends(get_core)):
        return orders.cancel(core, id)

    # ---- research, journal, alerts --------------------------------------
    @api.get("/api/v1/research")
    def list_research(core: App = Depends(get_core), *, symbol: str | None = None, sector: str | None = None,
                      category: str | None = None, strategy_id: str | None = None,
                      q: str | None = Query(default=None, max_length=80)):
        return Extras(core).research(symbol=symbol, sector=sector, category=category, strategy_id=strategy_id, q=q)

    @api.post("/api/v1/research", status_code=201)
    def create_research(body: ResearchIn, core: App = Depends(get_core)):
        return Extras(core).save_research(body)

    @api.put("/api/v1/research/{id}")
    def update_research(id: str, body: ResearchIn, core: App = Depends(get_core)):
        return Extras(core).save_research(body, id)

    @api.delete("/api/v1/research/{id}")
    def delete_research(id: str, core: App = Depends(get_core)):
        Extras(core).delete_research(id)
        return {"deleted": id}

    @api.get("/api/v1/journal")
    def list_journal(core: App = Depends(get_core), *, symbol: str | None = None, status: str | None = None):
        return Extras(core).journal(symbol=symbol, status=status)

    @api.post("/api/v1/journal", status_code=201)
    def create_journal(body: JournalIn, core: App = Depends(get_core)):
        return Extras(core).save_journal(body)

    @api.put("/api/v1/journal/{id}")
    def update_journal(id: str, body: JournalIn, core: App = Depends(get_core)):
        return Extras(core).save_journal(body, id)

    @api.delete("/api/v1/journal/{id}")
    def delete_journal(id: str, core: App = Depends(get_core)):
        Extras(core).delete_journal(id)
        return {"deleted": id}

    @api.get("/api/v1/alerts")
    def list_alerts(core: App = Depends(get_core)):
        return Extras(core).alerts()

    @api.post("/api/v1/alerts", status_code=201)
    def create_alert(body: AlertIn, core: App = Depends(get_core)):
        return Extras(core).save_alert(body)

    @api.put("/api/v1/alerts/{id}")
    def update_alert(id: str, body: AlertIn, core: App = Depends(get_core)):
        return Extras(core).save_alert(body, id)

    @api.delete("/api/v1/alerts/{id}")
    def delete_alert(id: str, core: App = Depends(get_core)):
        Extras(core).delete_alert(id)
        return {"deleted": id}

    @api.post("/api/v1/alerts/check")
    def check_alerts(core: App = Depends(get_core)):
        """Evaluate the active alerts against the latest prices. The page calls this as prices update."""
        return Extras(core).check_alerts()

    # ---- accounts --------------------------------------------------------
    def accounts_for(request: Request, core: App) -> Accounts | None:
        if not firestore:
            return None  # local SQLite runs have no sign-in and no accounts
        token = request.headers.get("authorization", "")[7:].strip()
        return Accounts(settings.firebase_project_id, settings.firebase_web_api_key, token, core.store.uid)

    @api.get("/api/v1/accounts")
    def list_accounts(request: Request, core: App = Depends(get_core)):
        acc = accounts_for(request, core)
        if acc is None or not acc.can_manage():
            return {"can_manage": False, "accounts": []}
        return {"can_manage": True, "accounts": acc.list()}

    @api.post("/api/v1/accounts", status_code=201)
    def create_account(request: Request, body: AccountIn, core: App = Depends(get_core)):
        acc = accounts_for(request, core)
        if acc is None:
            raise HTTPException(404, "accounts are not available in local mode")
        created = acc.create(body.email, body.password, body.name)
        core.audit("create", "account", {"uid": created["uid"], "email": created["email"], "name": created["name"]})
        return created

    @api.put("/api/v1/accounts/{uid}")
    def set_account_active(request: Request, uid: str, body: AccountActiveIn, core: App = Depends(get_core)):
        acc = accounts_for(request, core)
        if acc is None:
            raise HTTPException(404, "accounts are not available in local mode")
        result = acc.set_active(uid, body.active)
        core.audit("activate" if body.active else "deactivate", "account", {"uid": uid})
        return result

    # ---- assistant ---------------------------------------------------------
    def assistant_allowed(request: Request, core: App) -> bool:
        """With several accounts on one API key, the key's owner decides who may spend from it."""
        if not firestore or settings.assistant_users == "all":
            return True
        return accounts_for(request, core).can_manage()

    def assistant_ready(request: Request, core: App):
        if assistant_model is None:
            raise HTTPException(503, "The assistant is not connected yet: no Claude API key is saved on the server.")
        if not assistant_allowed(request, core):
            raise HTTPException(403, "The assistant is switched on for administrators only.")
        return assistant_model

    def assistant_stream(events):
        """Server-sent events: one JSON object per step of the assistant's work."""
        def body():
            try:
                for event in events:
                    if event["type"] == "beat":
                        yield ": keep-alive\n\n"
                    else:
                        yield f"data: {json.dumps(clean(event), ensure_ascii=False, separators=(',', ':'))}\n\n"
            except Exception:  # noqa: BLE001 - the reply has started: the failure has to be reported inside it
                logging.getLogger("egx.assistant").exception("assistant stream failed")
                failed = {"type": "error", "detail": "Something went wrong while the assistant was working. Try again."}
                yield f"data: {json.dumps(failed)}\n\n"
        return StreamingResponse(body(), media_type="text/event-stream", headers=NO_BUFFERING)

    @api.get("/api/v1/assistant")
    def assistant_status(request: Request, core: App = Depends(get_core)):
        return assistant.status(core, assistant_model, allowed=assistant_model is not None and assistant_allowed(request, core))

    @api.put("/api/v1/assistant/access")
    def assistant_access(request: Request, body: AssistantAccessIn, core: App = Depends(get_core)):
        assistant_ready(request, core)
        return {"access": save_prefs(core, PrefsIn(access=body.access))["access"]}

    @api.put("/api/v1/assistant/settings")
    def assistant_settings(request: Request, body: PrefsIn, core: App = Depends(get_core)):
        """Model, thinking effort, access, daily budget, trading limits and the autopilot, for this account."""
        assistant_ready(request, core)
        save_prefs(core, body)
        return assistant.status(core, assistant_model, allowed=True)

    @api.post("/api/v1/assistant/autopilot")
    def assistant_autopilot(request: Request, core: App = Depends(get_core)):
        """Let the assistant review the portfolio by itself if a review is due. The page calls this; it does nothing otherwise."""
        if assistant_model is None or not assistant_allowed(request, core):
            return {"ran": False, "mode": "off"}
        return assistant.run_autopilot(core, assistant_model)

    @api.post("/api/v1/assistant/chats", status_code=201)
    def assistant_new_chat(request: Request, core: App = Depends(get_core)):
        assistant_ready(request, core)
        return assistant.transcript(assistant.new_chat(core))

    @api.get("/api/v1/assistant/chats/{id}")
    def assistant_chat(request: Request, id: str, core: App = Depends(get_core)):
        assistant_ready(request, core)
        return assistant.transcript(assistant.load(core, id))

    @api.delete("/api/v1/assistant/chats/{id}")
    def assistant_delete_chat(request: Request, id: str, core: App = Depends(get_core)):
        assistant_ready(request, core)
        assistant.delete_chat(core, id)
        return {"deleted": id}

    @api.post("/api/v1/assistant/chats/{id}/messages")
    def assistant_message(request: Request, id: str, body: AssistantMessageIn, core: App = Depends(get_core)):
        """Say something to the assistant. The reply streams back as it is produced."""
        model = assistant_ready(request, core)
        return assistant_stream(assistant.send(core, model, id, body.text, body.page))

    @api.post("/api/v1/assistant/chats/{id}/resolve")
    def assistant_resolve(request: Request, id: str, body: AssistantResolveIn, core: App = Depends(get_core)):
        """Approve or decline the actions the assistant is waiting to take, then let it carry on."""
        model = assistant_ready(request, core)
        return assistant_stream(assistant.resolve(core, model, id, body.decisions))

    # ---- data import & audit --------------------------------------------
    @api.post("/api/v1/data/bars/import")
    async def import_bars(core: App = Depends(get_core), *, symbol: str = Form(max_length=12), file: UploadFile = File(),
                          name: str | None = Form(default=None, max_length=120),
                          sector: str | None = Form(default=None, max_length=80)):
        raw = await file.read(MAX_CSV_BYTES + 1)
        if len(raw) > MAX_CSV_BYTES:
            raise HTTPException(413, "file too large (5 MB max)")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise HTTPException(422, "file must be UTF-8 text") from None
        with core.store.transaction():
            result = core.market.import_csv(symbol, text, name=name, sector=sector)
            core.bump_data_version()
            core.audit("import", "bars", {**result, "filename": file.filename})
        return result

    @api.get("/api/v1/audit")
    def audit(core: App = Depends(get_core), *, limit: int = Query(default=100, ge=1, le=1000)):
        return core.store.recent("audit", limit)

    return api


app = create_app()
