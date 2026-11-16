"""The Younit (EFG Hermes) API: market data, a look at the brokerage account, and its orders.

Almost everything here reads. Market data: the stock list, daily history, live prices and
the order book. The account (see `app/broker.py`, which decides who may look): its cash,
its holdings and whose it is.

Two calls change something at the broker: `place_limit_order` and `cancel_order`. Nothing in
this file decides to use them. They are called from `app/real_orders.py` only, after the
account's owner approved that one order and every check there passed. Each is sent once: an
answer that never came is reported as doubtful (`OrderUncertain`), never tried again. There
is no code for market orders, hidden orders, changing an order or moving money.

The credentials come from the server's environment (YOUNIT_TRADING_ID,
YOUNIT_API_KEY). They are never sent to the browser, logged, or stored.
"""
from __future__ import annotations

import logging
import math
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
    "User-Agent": "egx-intelligence/0.3 (read-only)",
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
# Asked for with a single look at the book only: what the feed says about the stock and this account's data.
BOOK_STATUS_FIELDS = ["m_DataFeedSubscribtionStatus", "m_SymbolStatusUI", "m_TOP", "m_TOV"]   # the feed's own spelling
TICK_FIELDS = DEPTH_FIELDS + ["m_OpenPrice", "m_DailyHighPrice", "m_DailyLowPrice", "m_TradedVolume", "m_TradedValue",
                             "m_TradesCount", "m_LastTradeVolume", "m_Change", "m_PercentChange", "m_LastUpdated"]
MARKET_TICK_FIELDS = ["m_LastTradePrice", "m_PercentChange", "m_TradedVolume"]
INDEX_FIELDS = ["m_IndexName", "m_EnglishName", "m_IndexValue", "m_IndexClose", "m_PrecentChange"]
SYMBOL = re.compile(r"[A-Z0-9_]{1,12}")
# The numbers the broker's order API uses. Only these are ever sent.
SIDES = {"BUY": 100, "SELL": 200}   # a plain buy; a plain sell of settled shares (201 and 203 are same-day and T+1 sells)
ORDER_NORMAL = 0                    # 1 is a concealed (iceberg) order: never used
EXPIRES_TODAY = 7                   # a day order: gone at the session's close
VIA_API = 8
EXECUTION_DEFAULT = 1


book_log = logging.getLogger("egx.depth")
if not book_log.handlers:   # one line now and then; the host shows what is written here
    book_log.addHandler(logging.StreamHandler())
    book_log.setLevel(logging.INFO)
BOOK_NOTE_SECONDS = 600
_BOOK_NOTED: dict[str, float] = {}


def _note_book(item: str, row: dict, book: dict) -> None:
    """Leave a line every ten minutes per stock that says what the feed sent for its book.

    The layout of the book fields is not documented. The line lets what this code read be checked
    against what arrived, and tells a layout it does not read from a feed that sent no levels.
    """
    from . import depth
    now = time.monotonic()
    if now - _BOOK_NOTED.get(item, -1e9) < BOOK_NOTE_SECONDS:
        return
    _BOOK_NOTED[item] = now
    while len(_BOOK_NOTED) > 200:
        _BOOK_NOTED.pop(next(iter(_BOOK_NOTED)))
    book_log.info("depth: %s read as %d bids and %d asks (best price only: %s) from %s", item, len(book["bids"]),
                  len(book["asks"]), ",".join(book["top_only"] or []) or "no", depth.describe(row))


class YounitError(RuntimeError):
    pass


class OrderRefused(YounitError):
    """The broker answered and said no. Nothing was placed or cancelled; the message is the broker's own reason."""


class OrderUncertain(YounitError):
    """An order or a cancellation was sent and no clear answer came back.

    It may or may not have taken effect. The only safe next step is to look at the
    broker's list of orders; sending it again could place it twice.
    """


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


def _opt(v) -> float | None:
    """A figure the feed may leave out: None says "not given", which is not the same as zero."""
    try:
        out = float(v)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _count(v) -> int:
    """A whole number of shares; anything unreadable or negative counts as none."""
    n = _opt(v)
    return max(int(n), 0) if n is not None else 0


def _object(body):
    """The payload of a response that carries one object, unwrapped from its `data` envelope(s)."""
    for _ in range(3):
        if isinstance(body, dict) and "data" in body:
            body = body["data"]
    return body


def _messages(answer) -> str:
    """What the broker said, from the `messages` of an answer. Its own words: shown to the owner, never acted on."""
    found = answer.get("messages") if isinstance(answer, dict) else None
    text = "; ".join(str(m).strip() for m in found if m and str(m).strip()) if isinstance(found, list) else ""
    return text[:500]


def _order_row(raw: dict) -> dict | None:
    """One order from the broker's lists, whichever of its two spellings of the fields it uses."""
    try:
        order_id = int(_first(raw, "OrderId", "orderId", "orderID"))
    except (TypeError, ValueError):
        return None
    try:
        stock_id = int(_first(raw, "StockId", "stockId", "securityID"))
    except (TypeError, ValueError):
        stock_id = None
    word = str(_first(raw, "OrderTypeName", "orderType", "transactionType") or "").strip().lower()
    symbol = str(_first(raw, "ReuterId", "reuterID") or "").split(".")[0].strip().upper()
    return {"order_id": order_id, "stock_id": stock_id, "symbol": symbol if SYMBOL.fullmatch(symbol) else None,
            "side": "BUY" if word.startswith("buy") else "SELL" if word.startswith("sell") else None,
            "qty": _count(_first(raw, "Quantity", "quantity")), "price": _opt(_first(raw, "Price", "price")),
            "status": str(_first(raw, "Status", "status") or "").strip()[:60] or None,
            "executed_qty": _count(_first(raw, "ExecutedQty", "executedQty")),
            "average": _opt(_first(raw, "Average", "average"))}


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
    return "no list found; response is " + _outline(body)


def _outline(body) -> str:
    """The nesting of a response by key names only: `{data, messages} > {errorCode, data}`."""
    path, node = [], body
    while isinstance(node, dict) and len(path) < 4:
        path.append("{" + ", ".join(sorted(str(k) for k in node)[:25]) + "}")
        node = node.get("data")
    return " > ".join(path) if path else type(body).__name__


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

    def _post(self, path: str, body: dict):
        """A read that the API takes as a POST (a query with a body). Handled like any other read."""
        for attempt in (0, 1):
            try:
                res = self._http.post(f"{self._base}{path}", json=body,
                                      headers={"Authorization": self._authorization(force=attempt == 1)})
            except httpx.TimeoutException:
                raise YounitError("Younit took too long to answer") from None
            except httpx.HTTPError as exc:
                raise YounitError(f"cannot reach Younit ({exc.__class__.__name__})") from None
            if res.status_code == 401 and attempt == 0:
                continue
            if res.status_code == 429:
                raise YounitRateLimit(_retry_after(res))
            if res.status_code >= 400:
                raise YounitError(f"Younit request failed (HTTP {res.status_code})")
            try:
                return res.json()
            except ValueError:
                raise YounitError("Younit returned an unreadable response") from None
        raise YounitError("Younit rejected the request")

    def _change(self, path: str, body: dict):
        """Send one request that changes something at the broker, and say plainly what became of it.

        Returns the answer when the broker accepted the request for processing. Otherwise raises:
        `YounitError` when it certainly did not arrive (no connection, sign-in refused, too many requests),
        `OrderRefused` when the broker read it and said no, `OrderUncertain` when it was sent and the
        outcome is not known (no answer, or a server error). It is never sent a second time, except
        after a refused sign-in, which the broker gives before it looks at the request at all.
        """
        res = None
        for attempt in (0, 1):
            authorization = self._authorization(force=attempt == 1)   # a failure here means nothing was sent
            try:
                res = self._http.post(f"{self._base}{path}", json=body, headers={"Authorization": authorization})
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
                raise YounitError(f"cannot reach Younit ({exc.__class__.__name__}); nothing was sent") from None
            except httpx.HTTPError as exc:
                raise OrderUncertain(f"no answer came back from Younit ({exc.__class__.__name__})") from None
            if res.status_code != 401:
                break
        if res.status_code == 401:
            raise YounitError("Younit refused the sign-in; nothing was sent")
        if res.status_code == 429:
            raise YounitRateLimit(_retry_after(res))
        try:
            answer = res.json()
        except ValueError:
            answer = None
        if res.status_code >= 500:
            raise OrderUncertain(f"Younit answered with a server error (HTTP {res.status_code})")
        if res.status_code >= 400:
            raise OrderRefused(_messages(answer) or f"the broker refused the request (HTTP {res.status_code})")
        if not isinstance(answer, dict):
            raise OrderUncertain("Younit accepted the request but its answer could not be read")
        return answer

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
                                  [{"items": [item], "fields": DEPTH_FIELDS + BOOK_STATUS_FIELDS,
                                    "data_adapter": STREAM_ADAPTER}],
                                  user=self._trading_id, password=token, timeout=timeout, grace=0.2)
        except stream.StreamError as exc:
            raise YounitError(f"Younit price depth: {exc}") from None
        row = got["values"].get(item, {})
        book = depth.build(row)
        _note_book(item, row, book)
        return book

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
                    book = depth.build(row)
                    _note_book(item, row, book)
                    yield {"quote": tick_quote(row), "depth": book}
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

    # ---- the brokerage account (read-only) --------------------------------
    def account_holder(self) -> dict:
        """Whose account the credentials open: {"name", "account_code"}.

        The profile also carries an email address and a phone number; they are not kept.
        """
        data = _object(self._get("/api/account-utils/GetAccountInfo"))
        if not isinstance(data, dict):
            return {"name": None, "account_code": None}
        name = str(_first(data, "clientName", "name") or "").strip()
        code = _first(data, "accountCode")
        return {"name": name[:120] or None, "account_code": str(code).strip()[:40] if code is not None else None}

    def account_summary(self) -> dict:
        """Cash, the value of the holdings and their total, as the broker states them.

        A figure the broker leaves out is None, never zero. The market must be named in the
        request: without it the broker answers with every balance at zero.
        """
        body = self._get("/api/portfolio/GetPortfolioSummary", {"marketId": EGX_MARKET_ID})
        data = _object(body)
        if not isinstance(data, dict) or not any(k in data for k in ("totalCash", "totalStocks", "totalBalance")):
            # Say what came back (field names only, never values) so the mismatch can be fixed.
            raise YounitError(f"Younit account summary could not be read: response is {_outline(body)}")
        return {"cash": _opt(data.get("totalCash")), "stocks": _opt(data.get("totalStocks")),
                "total": _opt(data.get("totalBalance")), "realized": _opt(data.get("realizedProfit")),
                "unrealized": _opt(data.get("unRealizedProfit")),
                "unrealized_pct": _opt(data.get("unRealizedProfitPercentage")),
                "currency": str(data.get("currencyShortName") or "EGP").strip()[:8] or "EGP"}

    def account_positions(self) -> dict:
        """What the account holds: {"positions": [...], "stocks_value": the broker's own total or None}.

        Each position: stock_id, symbol (None when the broker sends no usable code, as it does for
        funds), name, qty, available (free to sell now), unsettled, frozen, avg_cost, cost, price,
        value, unrealized, unrealized_pct, suspended. An account that holds nothing gives an empty list.
        """
        body = self._get("/api/portfolio/GetStocksPortfolio", {"MarketId": EGX_MARKET_ID})
        data = _object(body)
        if data is None:
            return {"positions": [], "stocks_value": None}
        rows = data.get("stocks") if isinstance(data, dict) else data
        if rows is None and isinstance(data, dict):
            return {"positions": [], "stocks_value": _opt(data.get("stocksValue"))}
        if not isinstance(rows, list):
            raise YounitError(f"Younit holdings could not be read: {_shape(body, [])}")
        out = []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            qty = _count(raw.get("quantity"))
            if qty <= 0:
                continue
            symbol = str(_first(raw, "ReuterID", "reuterID", "reuterCode", "symbol") or "").split(".")[0].strip().upper()
            symbol = symbol if SYMBOL.fullmatch(symbol) else None
            try:
                stock_id = int(_first(raw, "securityID", "securityId", "stockId"))
            except (TypeError, ValueError):
                stock_id = None
            avg = _opt(raw.get("averageCost"))
            cost = avg * qty if avg is not None else _opt(raw.get("totalValue"))
            out.append({
                "stock_id": stock_id, "symbol": symbol,
                "name": str(_first(raw, "shortNameE", "shortNameA") or symbol or "Unnamed holding").strip()[:120],
                # "quantiy" is the broker's own spelling; the correct one is read too, for the day it is fixed
                "qty": qty, "available": _count(_first(raw, "quantiyValidForSale", "quantityValidForSale")),
                "unsettled": _count(raw.get("unSettledQty")), "frozen": _count(raw.get("frozenQty")),
                "avg_cost": avg, "cost": cost, "price": _opt(raw.get("marketPrice")), "value": _opt(raw.get("holdingValue")),
                "unrealized": _opt(raw.get("unRealizedProfit")), "unrealized_pct": _opt(raw.get("unRealizedProfitPercentage")),
                "suspended": raw.get("isSuspended") is True,
            })
        if rows and not out and any(isinstance(r, dict) for r in rows):
            first = next(r for r in rows if isinstance(r, dict))
            if "quantity" not in first:
                raise YounitError(f"Younit holdings could not be read: {_shape(body, rows)}")
        return {"positions": out, "stocks_value": _opt(data.get("stocksValue")) if isinstance(data, dict) else None}

    # ---- orders -------------------------------------------------------------
    def buying_power(self, stock_id: int) -> dict:
        """What can be spent on this stock now, and the trading profile an order for it must name.

        Returns {"profile_id", "buying_power", "held"}. Every order starts here: the broker
        takes no order without the profile this call gives.
        """
        data = _object(self._get(f"/api/v1/trading/buying-power/normal/{int(stock_id)}", {"marketId": EGX_MARKET_ID}))
        try:
            profile_id = int(_first(data, "profileID", "profileId")) if isinstance(data, dict) else None
        except (TypeError, ValueError):
            profile_id = None
        if profile_id is None:
            raise YounitError("Younit gave no trading profile for this stock: it may not be tradable on this account")
        return {"profile_id": profile_id, "buying_power": _opt(data.get("rawValue")),
                "held": _count(data.get("certificatesQuantityHolded"))}   # the broker's own spelling

    def trading_limits(self, stock_id: int) -> dict:
        """The broker's own price for a stock and the lowest and highest price it accepts in an order today.

        Returns {"last", "min_price", "max_price"}; a figure the broker leaves out, or gives as zero, is None.
        """
        data = _object(self._get(f"/api/stocks/stock-trading-info/{EGX_MARKET_ID}/{int(stock_id)}"))
        if not isinstance(data, dict):
            return {"last": None, "min_price": None, "max_price": None}

        def positive(key):
            value = _opt(data.get(key))
            return value if value and value > 0 else None
        return {"last": positive("price"), "min_price": positive("minPrice"), "max_price": positive("maxPrice")}

    def place_limit_order(self, *, profile_id: int, stock_id: int, side: str, qty: int, price: float) -> int:
        """Send one day order at a limit price to the exchange and return the order number the broker gave it.

        Called only from `app/real_orders.py`, after the owner approved this order. Sent once:
        see `_change` for what each failure means.
        """
        if side not in SIDES or isinstance(qty, bool) or not isinstance(qty, int) or qty <= 0 \
                or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
            raise YounitError("this is not an order that can be sent; nothing was sent")
        answer = self._change("/api/v1/orders/normal", {
            "profileID": int(profile_id), "stockID": int(stock_id), "orderCategory": ORDER_NORMAL,
            "operationType": SIDES[side], "quantity": qty, "price": float(price),
            "orderExpireTermsID": EXPIRES_TODAY, "orderVia": VIA_API, "isMarketPrice": False,
            "executionInstructionId": EXECUTION_DEFAULT, "isEdit": False,
        })
        inner = answer.get("data")
        if inner is False or (isinstance(inner, dict) and not inner.get("result")):
            raise OrderRefused(_messages(answer) or "the exchange rejected the order")
        try:
            return int(inner["orderId"])
        except (TypeError, KeyError, ValueError):
            # accepted, by every sign, but without a number to follow it by
            raise OrderUncertain("Younit accepted the order but gave no order number") from None

    def cancel_order(self, order_id: int, profile_id: int) -> None:
        """Ask the broker to cancel an order that is still open."""
        answer = self._change(f"/api/v1/orders/normal/{int(order_id)}/cancel", {"profileId": int(profile_id)})
        if answer.get("data") is False:
            raise OrderRefused(_messages(answer) or "the broker refused to cancel the order")

    def orders(self, profile_id: int) -> list[dict]:
        """The account's current and recent orders, as the broker lists them (a read, though the API takes it as a POST).

        Each: order_id, stock_id, symbol, side ("BUY", "SELL" or None when the broker's word is not understood),
        qty, price, status (the broker's own word, such as "Accepted"), executed_qty, average.
        """
        body = self._post("/core-services/Orders", {"MarketId": EGX_MARKET_ID, "ProfileIds": [int(profile_id)],
                                                    "GetFixOrders": False})
        rows = body if isinstance(body, list) else _object(body)
        return [o for o in (_order_row(r) for r in rows if isinstance(r, dict)) if o] if isinstance(rows, list) else []

    def order_history(self, profile_id: int) -> list[dict]:
        """Orders that are over (filled, cancelled, rejected, expired), newest as the broker sends them.

        Each is shaped like a row of `orders`, plus rejected (bool) and reject_reason.
        """
        rows = _object(self._get(f"/api/stocks/order-history/{EGX_MARKET_ID}/{int(profile_id)}"))
        out = []
        for raw in rows if isinstance(rows, list) else []:
            row = _order_row(raw) if isinstance(raw, dict) else None
            if row:
                out.append({**row, "rejected": raw.get("isRejected") is True,
                            "reject_reason": str(raw.get("rejectReason") or "").strip()[:300] or None})
        return out

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
