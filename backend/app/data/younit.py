"""Read-only market data from the Younit (EFG Hermes) API.

Only three calls exist here: get a token, list the stocks, read daily history.
There is deliberately no code for orders, funds, portfolio or anything else
that touches the brokerage account: this application is paper trading only.

The credentials come from the server's environment (YOUNIT_TRADING_ID,
YOUNIT_API_KEY). They are never sent to the browser, logged, or stored.
"""
from __future__ import annotations

import re
import threading
import time
from datetime import date, datetime

import httpx

from .calendar import CAIRO

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
STREAM_URL = "https://iengine138.hermesonline.com/"
STREAM_ADAPTER = "PROXY_MarketBeat"  # market data only; the orders adapter is never used
STREAM_CHUNK = 40
INDEX_PROBE = 25
QUOTE_FIELDS = ["m_LastTradePrice", "m_OpenPrice", "m_DailyHighPrice", "m_DailyLowPrice", "m_TradedVolume", "m_SectorName"]
DEPTH_FIELDS = ["m_LastTradePrice", "m_ClosePrice", "m_BidPrice", "m_BidVol", "m_AskPrice", "m_AskVol",
                "m_BidBook", "m_AskBook", "m_TotalBids", "m_TotalAsks"]
TICK_FIELDS = DEPTH_FIELDS + ["m_OpenPrice", "m_DailyHighPrice", "m_DailyLowPrice", "m_TradedVolume", "m_TradedValue",
                             "m_TradesCount", "m_LastTradeVolume", "m_Change", "m_PercentChange", "m_LastUpdated"]
MARKET_TICK_FIELDS = ["m_LastTradePrice", "m_PercentChange", "m_TradedVolume"]
INDEX_FIELDS = ["m_IndexName", "m_EnglishName", "m_IndexValue", "m_IndexClose", "m_PrecentChange"]
SYMBOL = re.compile(r"[A-Z0-9_]{1,12}")


class YounitError(RuntimeError):
    pass


class YounitRateLimit(YounitError):
    """The feed asked for fewer requests. Not a fault: stop, wait `retry_after` seconds, carry on."""

    def __init__(self, retry_after: int = 60):
        super().__init__("Younit rate limit reached; try again in a few minutes")
        self.retry_after = retry_after


def _retry_after(res: httpx.Response) -> int:
    try:
        return min(max(int(float(res.headers.get("retry-after", ""))), 5), 300)
    except ValueError:
        return 60


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


def _untraded(row: dict) -> bool:
    """True when the feed says outright that nothing has traded today.

    Before the first trade the "last trade price" field may still hold the previous
    session's price; a stated volume of zero means it must not be read as today's.
    A row with no volume field at all is taken at face value.
    """
    raw = row.get("m_TradedVolume")
    return raw not in (None, "") and _num(raw) <= 0


def candle_date(raw) -> str | None:
    """The Cairo calendar day of a history candle.

    A plain date or a local timestamp is taken as written. A timestamp that carries a
    time zone (e.g. Cairo midnight written in UTC) is converted first, so the bar is
    not filed under the day before.
    """
    text = str(raw or "").strip()
    if len(text) < 10:
        return None
    try:
        if len(text) > 10:
            stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if stamp.tzinfo is not None:
                stamp = stamp.astimezone(CAIRO)
            return stamp.date().isoformat()
        return date.fromisoformat(text).isoformat()
    except ValueError:
        try:
            return date.fromisoformat(text[:10]).isoformat()
        except ValueError:
            return None


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


def tick_quote(row: dict) -> dict:
    """The session figures of one stock from a streaming row; None where the feed has no value."""
    def pos(key):
        value = _num(row.get(key))
        return value if value > 0 else None

    def signed(key):
        raw = row.get(key)
        return _num(raw) if raw not in (None, "") else None
    last = None if _untraded(row) else pos("m_LastTradePrice")
    return {"last": last, "open": pos("m_OpenPrice"), "high": pos("m_DailyHighPrice"), "low": pos("m_DailyLowPrice"),
            "volume": pos("m_TradedVolume"), "value": pos("m_TradedValue"), "trades": pos("m_TradesCount"),
            "last_size": pos("m_LastTradeVolume"), "change": signed("m_Change"), "change_pct": signed("m_PercentChange"),
            "updated": str(row.get("m_LastUpdated") or "")[:40] or None}


def _shape(body, items) -> str:
    """Describe a response by its structure: key names and types only, no values."""
    def keys(d):
        return ", ".join(sorted(str(k) for k in d)[:25])
    if items and isinstance(items[0], dict):
        return f"{len(items)} entries with fields [{keys(items[0])}]"
    if items:
        return f"{len(items)} entries of type {type(items[0]).__name__}"
    if isinstance(body, list):
        return "the list is empty"
    path, node = [], body
    while isinstance(node, dict) and len(path) < 4:
        path.append("{" + keys(node) + "}")
        node = node.get("data")
    return "no list found; response is " + (" > ".join(path) if path else type(body).__name__)


class YounitClient:
    _tokens: dict[str, tuple[str, float]] = {}  # trading id -> (authorization header, expiry); shared per server instance
    _lock = threading.Lock()

    def __init__(self, trading_id: str, api_key: str, *, transport: httpx.BaseTransport | None = None,
                 base_url: str = BASE_URL):
        self._trading_id = trading_id.strip()
        self._api_key = api_key.strip()
        self._base = base_url
        self._http = httpx.Client(timeout=httpx.Timeout(12.0, connect=6.0), headers=HEADERS, transport=transport)

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
                raise YounitRateLimit(_retry_after(res))
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
            except httpx.TimeoutException:
                raise YounitError("Younit took too long to answer") from None
            except httpx.HTTPError as exc:
                raise YounitError(f"cannot reach Younit ({exc.__class__.__name__})") from None
            if res.status_code == 401 and attempt == 0:
                continue  # token expired early: sign in once more and retry
            if res.status_code == 429:
                raise YounitRateLimit(_retry_after(res))
            if res.status_code >= 400:
                raise YounitError(f"Younit request failed (HTTP {res.status_code})")
            try:
                return res.json()
            except ValueError:
                raise YounitError("Younit returned an unreadable response") from None
        raise YounitError("Younit rejected the request")

    # ---- market data -----------------------------------------------------
    def snapshot(self) -> dict:
        """The whole market in one call: every stock with its latest price.

        Returns {"stocks": [{symbol, name, stock_id, last, open, high, low, volume}], "fields": [...]}.
        `last` and the other figures are None when the feed does not supply them.
        """
        body = self._get(f"/api/stocks/market/{EGX_MARKET_ID}")
        raw_list = _unwrap(body, "stocks", "items", "result")
        out: dict[str, dict] = {}
        for raw in raw_list:
            if not isinstance(raw, dict):
                continue
            symbol = _first(raw, "symbol", "Symbol", "ticker")
            if not symbol:
                # the live API identifies a stock by its Reuters code, e.g. "COMI.CA"
                symbol = str(_first(raw, "reuterCode", "reuterID", "reutersCode", "ric") or "").split(".")[0]
            symbol = str(symbol or "").strip().upper()
            stock_id = _first(raw, "stockId", "securityID", "securityId", "stockID", "id")
            if not symbol or not SYMBOL.fullmatch(symbol) or stock_id is None:
                continue
            try:
                stock_id = int(stock_id)
            except (TypeError, ValueError):
                continue
            name = str(_first(raw, "stockName", "securityName", "name", "shortName") or symbol).strip()

            def pos(*keys, raw=raw):
                value = _num(_first(raw, *keys))
                return value if value > 0 else None
            out[symbol] = {
                "symbol": symbol, "name": name[:120], "stock_id": stock_id,
                "last": pos("price", "lastPrice", "last", "lastTradePrice", "currentPrice"),
                "open": pos("openPrice", "open"), "high": pos("highPrice", "high"), "low": pos("lowPrice", "low"),
                "volume": pos("volume", "totalVolume", "tradedVolume", "tradeVolume"),
            }
        if not out:
            # Say what came back (field names only, never values) so the mismatch can be fixed.
            raise YounitError(f"Younit stock list could not be read: {_shape(body, raw_list)}")
        first = next((r for r in raw_list if isinstance(r, dict)), {})
        return {"stocks": [out[s] for s in sorted(out)], "fields": sorted(str(k) for k in first)[:60]}

    def stocks(self) -> list[dict]:
        """All EGX stocks: [{symbol, name, stock_id}], sorted by symbol."""
        return [{k: s[k] for k in ("symbol", "name", "stock_id")} for s in self.snapshot()["stocks"]]

    def live(self, stocks: list[dict], *, timeout: float = 8.0) -> dict:
        """Current session figures for the given stocks, plus sectors and index levels.

        Returns {"quotes": {symbol: [last, open, high, low, volume]}, "sectors": {symbol: name},
                 "indices": [{id, name, value, prev_close, change_pct}], "errors": [...]}.
        """
        from . import stream
        by_item = {f"sy{s['stock_id']}": s["symbol"] for s in stocks}
        items = sorted(by_item)
        groups = [{"items": items[i:i + STREAM_CHUNK], "fields": QUOTE_FIELDS, "data_adapter": STREAM_ADAPTER}
                  for i in range(0, len(items), STREAM_CHUNK)]
        # Index ids are not documented: ask for a range, one subscription each, and keep whatever exists.
        groups += [{"items": [f"ix{i}"], "fields": INDEX_FIELDS, "data_adapter": STREAM_ADAPTER, "required": False}
                   for i in range(1, INDEX_PROBE + 1)]
        token = self._authorization().split(" ", 1)[-1]
        try:
            got = stream.snapshot(STREAM_URL, STREAM_ADAPTER, groups, user=self._trading_id, password=token, timeout=timeout)
        except stream.StreamError as exc:
            raise YounitError(f"Younit live prices: {exc}") from None
        quotes, sectors, indices = {}, {}, []
        for item, row in got["values"].items():
            if item in by_item:
                symbol = by_item[item]
                sector = str(row.get("m_SectorName") or "").strip()
                if sector:
                    sectors[symbol] = sector[:60]
                last = _num(row.get("m_LastTradePrice"))
                if last <= 0 or _untraded(row):
                    continue  # no trade yet today: the settled history stands
                opened = _num(row.get("m_OpenPrice")) or last
                high = max(_num(row.get("m_DailyHighPrice")), last, opened)
                low = min(v for v in (_num(row.get("m_DailyLowPrice")), last, opened) if v > 0)
                quotes[symbol] = [last, opened, high, low, max(_num(row.get("m_TradedVolume")), 0.0)]
            elif item.startswith("ix"):
                value = _num(row.get("m_IndexValue"))
                name = str(row.get("m_EnglishName") or row.get("m_IndexName") or "").strip()
                if value > 0 and name:
                    indices.append({"id": int(item[2:]), "name": name[:60], "value": value,
                                    "prev_close": _num(row.get("m_IndexClose")) or None,
                                    "change_pct": _num(row.get("m_PrecentChange")) if row.get("m_PrecentChange") else None})
        return {"quotes": quotes, "sectors": sectors, "indices": sorted(indices, key=lambda i: i["id"]),
                "errors": got["errors"], "answered": len(got["values"])}

    def depth(self, stock_id: int, *, timeout: float = 6.0) -> dict:
        """The order book of one stock right now (bids and asks by price level)."""
        from . import depth, stream
        token = self._authorization().split(" ", 1)[-1]
        item = f"sy{int(stock_id)}"
        try:
            got = stream.snapshot(STREAM_URL, STREAM_ADAPTER,
                                  [{"items": [item], "fields": DEPTH_FIELDS, "data_adapter": STREAM_ADAPTER}],
                                  user=self._trading_id, password=token, timeout=timeout, grace=0.2)
        except stream.StreamError as exc:
            raise YounitError(f"Younit price depth: {exc}") from None
        return depth.build(got["values"].get(item, {}))

    def follow_stock(self, stock_id: int, *, max_seconds: float = 240.0):
        """Live feed of one stock: yields {"quote": {...}, "depth": {...}} on every change, None on heartbeats."""
        from . import depth, stream
        token = self._authorization().split(" ", 1)[-1]
        item = f"sy{int(stock_id)}"
        group = {"items": [item], "fields": TICK_FIELDS, "data_adapter": STREAM_ADAPTER}
        try:
            for update in stream.follow(STREAM_URL, STREAM_ADAPTER, group, user=self._trading_id, password=token,
                                        max_seconds=max_seconds):
                if update is None:
                    yield None
                    continue
                row = (update.get(item) or {}).get("row")
                if row:
                    yield {"quote": tick_quote(row), "depth": depth.build(row)}
        except stream.StreamError as exc:
            raise YounitError(f"Younit live stream: {exc}") from None

    def follow_market(self, stocks: list[dict], index_ids: list[int] = (), *, max_seconds: float = 240.0):
        """Live feed of the whole market.

        Yields {"q": {symbol: [last, change_pct, volume]}, "i": {index id: [value, change_pct]}} holding only
        what changed since the previous message, and None on heartbeats.
        """
        from . import stream
        token = self._authorization().split(" ", 1)[-1]
        by_item = {f"sy{s['stock_id']}": s["symbol"] for s in stocks}
        items = sorted(by_item)
        groups = [{"items": items[i:i + STREAM_CHUNK], "fields": MARKET_TICK_FIELDS, "data_adapter": STREAM_ADAPTER}
                  for i in range(0, len(items), STREAM_CHUNK)]
        groups += [{"items": [f"ix{int(i)}"], "fields": ["m_IndexValue", "m_PrecentChange"], "data_adapter": STREAM_ADAPTER,
                    "required": False} for i in index_ids]
        try:
            for update in stream.follow(STREAM_URL, STREAM_ADAPTER, groups, user=self._trading_id, password=token,
                                        max_seconds=max_seconds, settle=0.4):
                if update is None:
                    yield None
                    continue
                quotes, indices = {}, {}
                for item, change in update.items():
                    row = change["row"]
                    if item in by_item:
                        last = _num(row.get("m_LastTradePrice"))
                        if last > 0 and not _untraded(row):
                            pct = row.get("m_PercentChange")
                            quotes[by_item[item]] = [last, _num(pct) if pct not in (None, "") else None,
                                                     _num(row.get("m_TradedVolume")) or None]
                    elif item.startswith("ix"):
                        value = _num(row.get("m_IndexValue"))
                        if value > 0:
                            pct = row.get("m_PrecentChange")
                            indices[item[2:]] = [value, _num(pct) if pct not in (None, "") else None]
                if quotes or indices:
                    yield {"q": quotes, "i": indices}
        except stream.StreamError as exc:
            raise YounitError(f"Younit live stream: {exc}") from None

    def daily_history(self, stock_id: int, date_from: date, date_to: date) -> list[list]:
        """Daily bars [[YYYY-MM-DD, open, high, low, close, volume], ...], oldest first."""
        data = self._get("/api/charts/GetChartingHistoricalDataFeed",
                         {"SecurityID": stock_id, "Period": "Day",
                          "DateFrom": date_from.isoformat(), "DateTo": date_to.isoformat()})
        rows: dict[str, list] = {}
        candles = _unwrap(data, "chartingDataViewModel", "candles", "items")
        for c in candles:
            if not isinstance(c, dict):
                continue
            stamp = candle_date(_first(c, "dateTime", "date", "Date"))
            close = _num(_first(c, "price", "close", "closePrice"))
            if stamp is None or close <= 0:
                continue
            o = _num(_first(c, "openPrice", "open")) or close
            h = max(_num(_first(c, "highPrice", "high")), o, close)
            low_raw = _num(_first(c, "lowPrice", "low"))
            low = min(v for v in (low_raw, o, close) if v > 0)
            rows[stamp] = [stamp, round(o, 4), round(h, 4), round(low, 4), round(close, 4),
                           max(_num(_first(c, "volume", "Volume")), 0.0)]
        if candles and not rows:
            raise YounitError(f"Younit price history could not be read: {_shape(data, candles)}")
        return [rows[k] for k in sorted(rows)]
