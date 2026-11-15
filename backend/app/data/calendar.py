"""EGX trading calendar: Sunday to Thursday. Public holidays are not modelled yet."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

CAIRO = ZoneInfo("Africa/Cairo")
# Continuous session plus the closing auction, with a few minutes either side.
SESSION_OPEN, SESSION_CLOSE = time(9, 55), time(14, 45)


def cairo_now() -> datetime:
    return datetime.now(CAIRO)


def market_open(now: datetime | None = None) -> bool:
    now = now or cairo_now()
    return is_trading_day(now.date()) and SESSION_OPEN <= now.time() <= SESSION_CLOSE


def is_trading_day(d: date) -> bool:
    return d.weekday() in (6, 0, 1, 2, 3)  # Sun, Mon, Tue, Wed, Thu


def last_trading_days(end: date, count: int) -> list[date]:
    days: list[date] = []
    d = end
    while len(days) < count:
        if is_trading_day(d):
            days.append(d)
        d -= timedelta(days=1)
    return days[::-1]


def trading_days_between(start: date, end: date) -> int:
    n, d = 0, start
    while d < end:
        d += timedelta(days=1)
        if is_trading_day(d):
            n += 1
    return n
