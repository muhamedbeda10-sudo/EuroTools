"""Read-only market data from the Younit (EFG Hermes) API.

Only three calls exist here: get a token, list the stocks, read daily history.
There is deliberately no code for orders, funds, portfolio or anything else
that touches the brokerage account: this application is paper trading only.

The credentials come from the server's environment (YOUNIT_TRADING_ID,
YOUNIT_API_KEY). They are never sent to the browser, logged, or stored.
"""
from __future__ import annotations

import threading
import time
from datetime import date

import httpx

BASE_URL = "https://tradingapis.efghermesone.com"
HEADERS = {
    "Accept-Language": "en",
    "X-Server-Select": "real",
    "x-company-code": "003",
    "x-api-version": "1.0",
    "User-Agent": "egx-intelligence/0.3 (read-only market data)",
}
REFRESH_BEFORE_EXPIRY = 300
EGX_MARKET_ID = 1


class YounitError(RuntimeError):
    pass


def _first(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _unwrap(data, *list_keys):
    """Responses arrive as the payload itself or wrapped in one or two `data` objects."""
    for _ in range(3):
        if isinstance(data, dict) and "data" in data:
            data = data["data"]
    if isinstance(data, dict):
        for k in list_keys:
            if isinstance(data.get(k), list):
                return data[k]
    return data if isinstance(data, list) else []


class YounitClient:
    _tokens: dict[str, tuple[str, float]] = {}  # trading id -> (authorization header, expiry); shared per server instance
    _lock = threading.Lock()

    def __init__(self, trading_id: str, api_key: str, *, transport: httpx.BaseTransport | None = None,
                 base_url: str = BASE_URL):
        self._trading_id = trading_id.strip()
        self._api_key = api_key.strip()
        self._base = base_url
        self._http = httpx.Client(timeout=25.0, headers=HEADERS, transport=transport)

    # ---- authentication --------------------------------------------------
    def _authorization(self, force: bool = False) -> str:
        with self._lock:
            cached = self._tokens.get(self._trading_id)
            if cached and not force and time.monotonic() < cached[1] - REFRESH_BEFORE_EXPIRY:
                return cached[0]
            try:
                res = self._http.post(f"{self._base}/api/public-keys/token",
                                      json={"tradingId": self._trading_id, "secret": self._api_key})
            except httpx.HTTPError as exc:
                raise YounitError(f"cannot reach Younit ({exc.__class__.__name__})") from None
            if res.status_code in (400, 401, 403):
                raise YounitError("Younit rejected the Trading ID / API key (check the values saved on the server)")
            if res.status_code == 429:
                raise YounitError("Younit rate limit reached; try again in a few minutes")
            if res.status_code >= 400:
                raise YounitError(f"Younit sign-in failed (HTTP {res.status_code})")
            try:
                body = res.json()
            except ValueError:
                raise YounitError("Younit sign-in returned an unreadable response") from None
            payload = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), dict) else body
            token = payload.get("accessToken") if isinstance(payload, dict) else None
            if not isinstance(token, str) or not token:
                raise YounitError("Younit sign-in returned no access token")
            lifetime = payload.get("expiresIn")
            header = f"{payload.get('tokenType') or 'Bearer'} {token}"
            self._tokens[self._trading_id] = (header, time.monotonic() + (lifetime if isinstance(lifetime, int) and lifetime > 0 else 600))
            return header

    def _get(self, path: str, params: dict | None = None):
        for attempt in (0, 1):
            try:
                res = self._http.get(f"{self._base}{path}", params=params,
                                     headers={"Authorization": self._authorization(force=attempt == 1)})
            except httpx.HTTPError as exc:
                raise YounitError(f"cannot reach Younit ({exc.__class__.__name__})") from None
            if res.status_code == 401 and attempt == 0:
                continue  # token expired early: sign in once more and retry
            if res.status_code == 429:
                raise YounitError("Younit rate limit reached; try again in a few minutes")
            if res.status_code >= 400:
                raise YounitError(f"Younit request failed (HTTP {res.status_code})")
            try:
                return res.json()
            except ValueError:
                raise YounitError("Younit returned an unreadable response") from None
        raise YounitError("Younit rejected the request")

    # ---- market data -----------------------------------------------------
    def stocks(self) -> list[dict]:
        """All EGX stocks: [{symbol, name, stock_id}], sorted by symbol."""
        out: dict[str, dict] = {}
        for raw in _unwrap(self._get(f"/api/stocks/market/{EGX_MARKET_ID}")):
            if not isinstance(raw, dict):
                continue
            symbol = str(_first(raw, "symbol", "Symbol") or "").strip().upper()
            stock_id = _first(raw, "stockId", "securityID", "securityId", "id")
            if not symbol or not symbol.isalnum() or len(symbol) > 12 or stock_id is None:
                continue
            name = str(_first(raw, "stockName", "securityName", "name", "shortName") or symbol).strip()
            out[symbol] = {"symbol": symbol, "name": name[:120], "stock_id": int(stock_id)}
        return [out[s] for s in sorted(out)]

    def daily_history(self, stock_id: int, date_from: date, date_to: date) -> list[list]:
        """Daily bars [[YYYY-MM-DD, open, high, low, close, volume], ...], oldest first."""
        data = self._get("/api/charts/GetChartingHistoricalDataFeed",
                         {"SecurityID": stock_id, "Period": "Day",
                          "DateFrom": date_from.isoformat(), "DateTo": date_to.isoformat()})
        rows: dict[str, list] = {}
        for c in _unwrap(data, "chartingDataViewModel"):
            if not isinstance(c, dict):
                continue
            stamp = str(_first(c, "dateTime", "date", "Date") or "")[:10]
            close = _num(_first(c, "price", "close", "closePrice"))
            if len(stamp) != 10 or close <= 0:
                continue
            try:
                date.fromisoformat(stamp)
            except ValueError:
                continue
            o = _num(_first(c, "openPrice", "open")) or close
            h = max(_num(_first(c, "highPrice", "high")), o, close)
            low_raw = _num(_first(c, "lowPrice", "low"))
            low = min(v for v in (low_raw, o, close) if v > 0)
            rows[stamp] = [stamp, round(o, 4), round(h, 4), round(low, 4), round(close, 4),
                           max(_num(_first(c, "volume", "Volume")), 0.0)]
        return [rows[k] for k in sorted(rows)]
