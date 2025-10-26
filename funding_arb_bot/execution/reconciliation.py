"""Post-execution fill reconciliation and makeup orders."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from funding_arb_bot.exchanges.base import ExchangeClient, OrderRequest, OrderResult, OrderTimeInForce, OrderType, Side

logger = logging.getLogger(__name__)


@dataclass
class FillReconciliation:
    """Result of comparing actual fills vs intended sizes."""

    primary_filled: float
    hedge_filled: float
    imbalance: float
    needs_correction: bool
    correction_side: Side | None = None
    correction_size: float = 0.0


def check_fills(
    primary_result: OrderResult,
    hedge_result: OrderResult,
    intended_primary: float,
    intended_hedge: float,
    tolerance: float = 0.01,
) -> FillReconciliation:
    """Compare actual fills against intended sizes.

    Args:
        primary_result: Order result from primary exchange
        hedge_result: Order result from hedge exchange
        intended_primary: Intended quantity for primary leg
        intended_hedge: Intended quantity for hedge leg
        tolerance: Minimum imbalance ratio to trigger correction (e.g., 0.01 = 1%)

    Returns:
        FillReconciliation with imbalance analysis
    """
    primary_filled = primary_result.filled_size
    hedge_filled = hedge_result.filled_size

    # Calculate imbalance
    imbalance = abs(primary_filled - hedge_filled)
    avg_filled = (primary_filled + hedge_filled) / 2

    needs_correction = False
    correction_side = None
    correction_size = 0.0

    if avg_filled > 0 and (imbalance / avg_filled) > tolerance:
        needs_correction = True
        if primary_filled > hedge_filled:
            # Need to increase hedge side
            correction_side = Side.BUY if hedge_result.filled_size < intended_hedge else Side.SELL
            correction_size = imbalance
        else:
            # Need to increase primary side or reduce it
            correction_side = Side.BUY if primary_result.filled_size < intended_primary else Side.SELL
            correction_size = imbalance

    return FillReconciliation(
        primary_filled=primary_filled,
        hedge_filled=hedge_filled,
        imbalance=imbalance,
        needs_correction=needs_correction,
        correction_side=correction_side,
        correction_size=correction_size,
    )


async def apply_correction(
    reconciliation: FillReconciliation,
    symbol: str,
    primary: ExchangeClient,
    hedge: ExchangeClient,
    target: str,  # "primary" or "hedge"
) -> OrderResult:
    """Place makeup order to correct imbalance.

    Args:
        reconciliation: Fill reconciliation result
        symbol: Trading symbol
        primary: Primary exchange client
        hedge: Hedge exchange client
        target: Which exchange needs correction

    Returns:
        OrderResult from correction trade
    """
    if not reconciliation.needs_correction:
        raise ValueError("No correction needed")

    client = primary if target == "primary" else hedge
    
    correction_order = OrderRequest(
        client_id=f"correction:{target}:{symbol}",
        symbol=symbol,
        side=reconciliation.correction_side,  # type: ignore
        size=reconciliation.correction_size,
        order_type=OrderType.MARKET,
        reduce_only=False,
        time_in_force=OrderTimeInForce.IOC,
    )

    logger.warning(
        "applying_fill_correction",
        extra={
            "symbol": symbol,
            "target": target,
            "side": reconciliation.correction_side,
            "size": reconciliation.correction_size,
            "imbalance": reconciliation.imbalance,
        },
    )

    return await client.place_order(correction_order)

