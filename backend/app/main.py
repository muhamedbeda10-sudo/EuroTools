"""EGX Intelligence API. Paper trading only: nothing in this service can send an order to a broker."""
from __future__ import annotations

import csv
import io
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

from .accounts import AccountError, Accounts
from .config import Settings, get_settings
from .data.feed import Feed, FirestoreDocs, StoreDocs
from .data.market import DataError
from .data.younit import YounitClient, YounitError
from .domain.backtest import BacktestError
from .domain.fees import FeeSchedule
from .domain.ledger import LedgerError
from .domain.strategies import STRATEGY_TYPES, StrategyConfig
from .services import App, NotFound
from .store.errors import AuthError, ConflictError
from .store.firestore_store import FirestoreStore, uid_from_token
from .store.sqlite_store import Store

MAX_CSV_BYTES = 5 * 1024 * 1024
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


class AccountIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=128)


class AccountActiveIn(BaseModel):
    active: bool


class BacktestIn(BaseModel):
    strategy_id: str | None = None
    strategy: StrategyConfig | None = None
    symbols: list[str] | None = Field(default=None, max_length=300)
    start: date | None = None
    end: date | None = None
    capital: Decimal | None = Field(default=None, gt=0, le=Decimal("1000000000"))


MAX_CACHED_USERS = 20


def create_app(settings: Settings | None = None, store: Store | None = None, younit=None) -> FastAPI:
    settings = settings or get_settings()
    if younit is None and settings.younit_trading_id and settings.younit_api_key:
        younit = YounitClient(settings.younit_trading_id, settings.younit_api_key)
    firestore = settings.store_backend == "firestore"
    if firestore and not settings.firebase_project_id:
        raise RuntimeError("FIREBASE_PROJECT_ID is required when STORE_BACKEND=firestore")
    local_store = None if firestore else (store or Store(settings.data_dir / "egx.sqlite3"))
    caches: OrderedDict[str, dict] = OrderedDict()

    def get_core(request: Request) -> App:
        """Build the per-request application object for the signed-in user."""
        if not firestore:
            feed = Feed(StoreDocs(local_store)) if younit else None
            return App(local_store, settings, caches.setdefault("local", {}), feed, younit).bootstrap()
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise AuthError("sign in to use the app")
        token = header[7:].strip()
        uid = uid_from_token(token)
        # bootstrap() reads the user's settings first; Firestore rejects that read
        # unless the token is genuine, so the cache below is never reached by a forgery.
        core = App(FirestoreStore(settings.firebase_project_id, token, uid), settings, {},
                   Feed(FirestoreDocs(settings.firebase_project_id, token)) if younit else None, younit)
        core.bootstrap()
        core.cache = caches.setdefault(uid, {})
        core.market.cache = core.cache.setdefault("market", {})
        caches.move_to_end(uid)
        while len(caches) > MAX_CACHED_USERS:
            caches.popitem(last=False)
        return core

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

    @api.exception_handler(YounitError)
    async def _feed_down(_: Request, exc: YounitError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

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
        out = {"status": "ok", "environment": settings.app_env, "region": os.environ.get("VERCEL_REGION")}
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

    @api.get("/health/stream")
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
        return {
            "trading_mode": "paper",
            "live_trading_enabled": False,
            "broker_connected": False,
            "broker_note": ("Younit is connected for market data only (read-only). This release cannot send orders to any broker."
                            if younit else "Younit is not connected. This release cannot send orders to any broker."),
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
