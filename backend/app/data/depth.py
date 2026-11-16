"""Order-book ("price depth") parsing.

What the feed sends today (seen in the session, 16 November 2026): the best bid
and the best ask with their sizes, and the total waiting on each side. It names
two fields for the levels behind them and leaves both out, so `build` usually
has the top of the book and nothing more, and says so (`top_only`).

Should it send them: each side of the book is one text field whose layout is not
documented. `parse_side` accepts JSON or delimited text. Which column is the
price, which the size and which the number of orders is decided ONCE for the
whole side (a book is a table: every level has the same layout), not level by
level, so a small size can never be mistaken for a price. When a side cannot
be read, the caller is given a short sample of the raw text so the layout can
be recognised and handled properly.
"""
from __future__ import annotations

import json
import re

NUMBER = re.compile(r"-?\d+(?:\.\d+)?")
GROUPED = re.compile(r"(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])")  # 1,200 or 12,500.5
OTHER_SEPARATOR = re.compile(r"\d[^\d.,-]+-?\d")  # two numbers with something other than a comma between them
RECORD_SEPARATORS = ["\n", "|", ";", "#", "~", "^"]
MAX_LEVELS = 200
MAX_DISTANCE = 0.6  # a book price further than this from the last trade is not a price
BOOK_KEYS = ("m_BidBook", "m_AskBook")  # the feed's two book fields: one text each, when it sends them


def _tokens(part: str) -> list[str]:
    """The numbers of one record, as written. "1,200" is one number when the fields are not comma-separated."""
    if OTHER_SEPARATOR.search(part):
        part = GROUPED.sub(lambda m: m.group(0).replace(",", ""), part)
    return [t for t in NUMBER.findall(part) if float(t) > 0]


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _roles(rows: list[list[str]], near: float | None) -> list[dict] | None:
    """Read a side as a table: find the price, size and order-count columns once, for every level."""
    width = len(rows[0]) if rows else 0
    if width < 2 or any(len(r) != width for r in rows):
        return None
    cols = [[float(r[j]) for r in rows] for j in range(width)]

    def distance(j: int) -> float:
        return _median([abs(v - near) / near for v in cols[j]]) if near else _median(cols[j])

    candidates = [j for j in range(width)
                  if not near or all(abs(v - near) / near <= MAX_DISTANCE for v in cols[j])]
    if not candidates:
        return None
    # A price is written with decimals, differs on every level, and sits near the last trade: in that order.
    price = max(candidates, key=lambda j: (sum("." in r[j] for r in rows) * 2 >= len(rows),
                                           len(set(cols[j])) == len(rows), -distance(j)))
    rest = [j for j in range(width) if j != price]
    size = max(rest, key=lambda j: _median(cols[j]))
    orders = next((j for j in rest if j != size and all(v == int(v) and v < 100_000 for v in cols[j])), None)
    return [{"price": cols[price][i], "size": cols[size][i], "orders": int(cols[orders][i]) if orders is not None else None}
            for i in range(len(rows))]


def _level(tokens: list[str], near: float | None) -> dict | None:
    """One level on its own, for a side whose records do not all have the same shape."""
    levels = _roles([tokens], near) if len(tokens) >= 2 else None
    return levels[0] if levels else None


def _read(rows: list[list[str]], near: float | None) -> list[dict]:
    rows = [r for r in rows if len(r) >= 2]
    if not rows:
        return []
    table = _roles(rows, near)
    if table is not None:
        return table
    return [lv for r in rows if (lv := _level(r, near))]


def _from_json(value, near: float | None) -> list[dict]:
    if isinstance(value, dict):
        value = next((v for v in value.values() if isinstance(v, list)), [])
    out, rows = [], []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict):
            lowered = {str(k).lower(): v for k, v in item.items()}

            def pick(*hints, lowered=lowered):
                for key, v in lowered.items():
                    if any(h in key for h in hints):
                        try:
                            return float(v)
                        except (TypeError, ValueError):
                            continue
                return None
            price, size = pick("price", "prc"), pick("vol", "qty", "quantity", "size")
            count = pick("count", "orders", "num", "no")
            if price and size and price > 0 and size > 0:
                out.append({"price": price, "size": size, "orders": int(count) if count else None})
                continue
            item = list(item.values())
        if isinstance(item, (list, tuple)):
            tokens = []
            for v in item:
                try:
                    if float(v) > 0:
                        tokens.append(repr(float(v)) if isinstance(v, float) else str(v).strip())
                except (TypeError, ValueError):
                    pass
            rows.append(tokens)
    return out or _read(rows, near)


def parse_side(text: str | None, near: float | None = None) -> list[dict]:
    """Levels [{price, size, orders}] of one side of the book, in the order the feed sent them."""
    text = (text or "").strip()
    if not text:
        return []
    if text[0] in "[{":
        try:
            levels = _from_json(json.loads(text), near)
            if levels:
                return levels[:MAX_LEVELS]
        except ValueError:
            pass
    best: list[dict] = []
    for sep in RECORD_SEPARATORS:
        if sep not in text:
            continue
        levels = _read([_tokens(part) for part in text.split(sep)], near)
        if len(levels) > len(best):
            best = levels
    if not best:  # a single level, or one flat run of numbers: read it in threes, then in pairs
        numbers = _tokens(text)
        for width in (3, 2):
            if len(numbers) >= width and len(numbers) % width == 0:
                levels = _read([numbers[i:i + width] for i in range(0, len(numbers), width)], near)
                if len(levels) == len(numbers) // width:
                    best = levels
                    break
    return best[:MAX_LEVELS]


def describe(row: dict) -> str:
    """What the feed sent for one stock's book, in one line, for the server's log. Market data only."""
    parts = []
    for key in BOOK_KEYS:
        text = str(row.get(key) or "")
        parts.append(f"{key}[{len(text)}]={text[:500]!r}" if row.get(key) is not None else f"{key}=absent")
    rest = {k: str(v)[:40] for k, v in sorted(row.items()) if k not in BOOK_KEYS}
    return " ".join(parts) + " " + json.dumps(rest, separators=(",", ":"))[:900]


def build(row: dict) -> dict:
    """Turn one streaming row into the depth view the page shows."""
    def num(key):
        try:
            v = float(row.get(key) or 0)
            return v if v > 0 else None
        except (TypeError, ValueError):
            return None

    last = num("m_LastTradePrice") or num("m_ClosePrice")
    best_bid, best_ask = num("m_BidPrice"), num("m_AskPrice")
    near = last or best_bid or best_ask
    bids = sorted(parse_side(row.get("m_BidBook"), near), key=lambda lv: -lv["price"])
    asks = sorted(parse_side(row.get("m_AskBook"), near), key=lambda lv: lv["price"])
    top_only = []  # the sides for which the feed gave no levels: only its best price is known
    if not bids and best_bid and num("m_BidVol"):
        bids = [{"price": best_bid, "size": num("m_BidVol"), "orders": None}]
        top_only.append("bids")
    if not asks and best_ask and num("m_AskVol"):
        asks = [{"price": best_ask, "size": num("m_AskVol"), "orders": None}]
        top_only.append("asks")
    best_bid = best_bid or (bids[0]["price"] if bids else None)
    best_ask = best_ask or (asks[0]["price"] if asks else None)
    total_bids = num("m_TotalBids") or sum(lv["size"] for lv in bids) or None
    total_asks = num("m_TotalAsks") or sum(lv["size"] for lv in asks) or None
    both = (total_bids or 0) + (total_asks or 0)
    spread = best_ask - best_bid if best_bid and best_ask else None
    unread = {side: str(row.get(key) or "")[:400] for side, key, levels in
              (("bids", "m_BidBook", bids), ("asks", "m_AskBook", asks))
              if str(row.get(key) or "").strip() and len(levels) <= 1}
    return {
        "last": last, "best_bid": best_bid, "best_ask": best_ask,
        "best_bid_size": bids[0]["size"] if bids else None, "best_ask_size": asks[0]["size"] if asks else None,
        "spread": spread, "spread_pct": spread / best_bid * 100 if spread is not None and best_bid else None,
        "total_bids": total_bids, "total_asks": total_asks,
        "bid_share_pct": total_bids / both * 100 if both and total_bids else None,
        "bids": bids, "asks": asks,
        # The sides that hold the feed's best price and nothing behind it, because no levels came with it.
        "top_only": top_only or None,
        # Present only when the book text could not be read into levels: a short sample of it.
        "unread": unread or None,
    }
