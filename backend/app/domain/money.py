from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
TICK = Decimal("0.0001")
ZERO = Decimal("0")


def D(value) -> Decimal:
    """Exact decimal from str/int/float/Decimal (floats go through str to avoid binary noise)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def money(value) -> Decimal:
    return D(value).quantize(CENT, rounding=ROUND_HALF_UP)


def px(value) -> Decimal:
    """A share price. EGX quotes cheap stocks in tenths of a piastre, so prices keep four decimals;
    only amounts of money are rounded to the piastre."""
    return D(value).quantize(TICK, rounding=ROUND_HALF_UP)


def f(value) -> float:
    """Presentation-only conversion for JSON responses."""
    return float(money(value))
