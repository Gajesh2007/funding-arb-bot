"""Price coordination for dual-leg execution to ensure similar entry prices."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

from funding_arb_bot.exchanges.base import ExchangeClient, Ticker


@dataclass
class CoordinatedPrice:
    """Price coordination result for dual-leg execution."""

    primary_price: float
    hedge_price: float
    mid_spread_bps: float
    is_acceptable: bool


async def get_coordinated_prices(
    symbol: str,
    primary: ExchangeClient,
    hedge: ExchangeClient,
    max_spread_bps: float = 50.0,
) -> CoordinatedPrice:
    """Fetch current prices from both exchanges and validate spread.

    Args:
        symbol: Trading symbol
        primary: Primary exchange client
        hedge: Hedge exchange client
        max_spread_bps: Maximum acceptable mid-price spread in bps

    Returns:
        CoordinatedPrice with mid prices and acceptability flag
    """
    # Fetch tickers from both exchanges
    primary_ticker = await primary.ticker_stream([symbol]).__anext__()
    hedge_ticker = await hedge.ticker_stream([symbol]).__anext__()

    # Calculate mids
    primary_mid = (primary_ticker.bid + primary_ticker.ask) / 2
    hedge_mid = (hedge_ticker.bid + hedge_ticker.ask) / 2

    # Calculate spread in bps
    avg_mid = (primary_mid + hedge_mid) / 2
    spread_bps = abs(primary_mid - hedge_mid) / avg_mid * 10000

    is_acceptable = spread_bps <= max_spread_bps

    return CoordinatedPrice(
        primary_price=primary_mid,
        hedge_price=hedge_mid,
        mid_spread_bps=spread_bps,
        is_acceptable=is_acceptable,
    )


def calculate_limit_prices(
    coordinated: CoordinatedPrice,
    is_buy_primary: bool,
    is_buy_hedge: bool,
    slippage_bps: float,
) -> Tuple[float, float]:
    """Calculate aggressive limit prices with slippage buffer.

    Args:
        coordinated: Coordinated price data
        is_buy_primary: True if buying on primary exchange
        is_buy_hedge: True if buying on hedge exchange
        slippage_bps: Slippage tolerance in basis points

    Returns:
        (primary_limit_price, hedge_limit_price)
    """
    slippage_factor = 1 + (slippage_bps / 10000)

    if is_buy_primary:
        primary_price = coordinated.primary_price * slippage_factor
    else:
        primary_price = coordinated.primary_price / slippage_factor

    if is_buy_hedge:
        hedge_price = coordinated.hedge_price * slippage_factor
    else:
        hedge_price = coordinated.hedge_price / slippage_factor

    return primary_price, hedge_price

