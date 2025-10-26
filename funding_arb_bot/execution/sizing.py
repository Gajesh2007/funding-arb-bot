"""Position sizing utilities converting USD notional to base asset quantities."""

from __future__ import annotations

import math
from dataclasses import dataclass

from funding_arb_bot.exchanges.base import SymbolSpec


@dataclass
class SizedOrder:
    """Calculated order size in base asset units."""

    symbol: str
    quantity: float
    price: float
    notional_usd: float


def calculate_quantity(
    notional_usd: float,
    mid_price: float,
    spec: SymbolSpec,
) -> float:
    """Convert USD notional to base asset quantity with proper rounding.

    Args:
        notional_usd: Target position size in USD
        mid_price: Current mid price (used for conversion)
        spec: Symbol specification with lot size and tick size

    Returns:
        Quantity in base asset units, rounded to lot size
    """
    if mid_price <= 0:
        raise ValueError(f"Invalid mid price: {mid_price}")

    raw_quantity = notional_usd / mid_price
    
    # Round down to lot size
    if spec.lot_size > 0:
        quantity = math.floor(raw_quantity / spec.lot_size) * spec.lot_size
    else:
        quantity = raw_quantity

    return quantity


def round_price(price: float, spec: SymbolSpec) -> float:
    """Round price to exchange tick size.

    Args:
        price: Raw price
        spec: Symbol specification with tick size

    Returns:
        Price rounded to tick size
    """
    if spec.tick_size > 0:
        return round(price / spec.tick_size) * spec.tick_size
    return price

