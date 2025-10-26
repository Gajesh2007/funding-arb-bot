"""Active rebalancing to maintain delta-neutral positions."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from funding_arb_bot.exchanges.base import ExchangeClient, OrderRequest, OrderResult, OrderTimeInForce, OrderType, Position, Side

logger = logging.getLogger(__name__)


@dataclass
class PositionDrift:
    """Measure of position imbalance between exchanges."""

    symbol: str
    lighter_size: float
    lighter_side: Side
    hl_size: float
    hl_side: Side
    drift_quantity: float
    drift_bps: float
    needs_rebalance: bool


@dataclass
class RebalanceAction:
    """Corrective action to rebalance position."""

    symbol: str
    exchange: str  # "lighter" or "hyperliquid"
    side: Side
    quantity: float


def detect_drift(
    symbol: str,
    lighter_pos: Position | None,
    hl_pos: Position | None,
    drift_threshold_bps: float,
) -> PositionDrift | None:
    """Detect position drift between exchanges.

    Args:
        symbol: Trading symbol
        lighter_pos: Position on Lighter (None if closed)
        hl_pos: Position on Hyperliquid (None if closed)
        drift_threshold_bps: Threshold in bps to trigger rebalance

    Returns:
        PositionDrift if detected, None if balanced
    """
    if not lighter_pos or not hl_pos:
        return None

    # Convert to signed quantities (+ for long, - for short)
    lighter_signed = lighter_pos.size if lighter_pos.side == Side.BUY else -lighter_pos.size
    hl_signed = hl_pos.size if hl_pos.side == Side.BUY else -hl_pos.size

    # For delta-neutral hedge, sum should be ~0
    total_exposure = lighter_signed + hl_signed
    avg_size = (abs(lighter_signed) + abs(hl_signed)) / 2

    if avg_size == 0:
        return None

    drift_bps = abs(total_exposure / avg_size) * 10000

    needs_rebalance = drift_bps >= drift_threshold_bps

    return PositionDrift(
        symbol=symbol,
        lighter_size=lighter_pos.size,
        lighter_side=lighter_pos.side,
        hl_size=hl_pos.size,
        hl_side=hl_pos.side,
        drift_quantity=abs(total_exposure),
        drift_bps=drift_bps,
        needs_rebalance=needs_rebalance,
    )


def plan_rebalance(drift: PositionDrift) -> RebalanceAction:
    """Plan corrective rebalance action.

    Args:
        drift: Position drift measurement

    Returns:
        RebalanceAction to correct the drift
    """
    lighter_signed = drift.lighter_size if drift.lighter_side == Side.BUY else -drift.lighter_size
    hl_signed = drift.hl_size if drift.hl_side == Side.BUY else -drift.hl_size
    total_exposure = lighter_signed + hl_signed

    # If total exposure > 0, we're net long → need to increase short or reduce long
    # If total exposure < 0, we're net short → need to increase long or reduce short

    if total_exposure > 0:
        # Net long: add to short side (or reduce long if already short on one side)
        if hl_signed < 0:
            # HL is short, increase it
            exchange = "hyperliquid"
            side = Side.SELL
        else:
            # Lighter is long, reduce it OR increase HL short
            exchange = "hyperliquid"
            side = Side.SELL
    else:
        # Net short: add to long side
        if hl_signed > 0:
            # HL is long, increase it
            exchange = "hyperliquid"
            side = Side.BUY
        else:
            exchange = "hyperliquid"
            side = Side.BUY

    return RebalanceAction(
        symbol=drift.symbol,
        exchange=exchange,
        side=side,
        quantity=drift.drift_quantity,
    )


async def execute_rebalance(
    action: RebalanceAction,
    lighter: ExchangeClient,
    hyperliquid: ExchangeClient,
    price: float,
) -> OrderResult:
    """Execute a rebalance order.

    Args:
        action: Planned rebalance action
        lighter: Lighter exchange client
        hyperliquid: Hyperliquid exchange client
        price: Current market price for limit order

    Returns:
        OrderResult from the rebalance trade
    """
    client = lighter if action.exchange == "lighter" else hyperliquid

    order = OrderRequest(
        client_id=f"rebalance:{action.exchange}:{action.symbol}",
        symbol=action.symbol,
        side=action.side,
        size=action.quantity,
        order_type=OrderType.LIMIT,
        price=price,
        reduce_only=False,
        time_in_force=OrderTimeInForce.IOC,
    )

    logger.info(
        "rebalance_executing",
        extra={
            "symbol": action.symbol,
            "exchange": action.exchange,
            "side": action.side.value,
            "quantity": action.quantity,
        },
    )

    return await client.place_order(order)

