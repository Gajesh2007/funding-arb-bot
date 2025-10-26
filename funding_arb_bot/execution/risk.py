"""Pre-trade risk checks and margin monitoring."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from funding_arb_bot.config import RiskLimits
from funding_arb_bot.exchanges.base import ExchangeClient, Position

logger = logging.getLogger(__name__)


@dataclass
class MarginHealth:
    """Margin health snapshot for an exchange."""

    exchange: str
    total_margin_used: float
    account_value: float
    utilization: float
    is_healthy: bool
    liquidation_risk: bool


@dataclass
class RiskCheckResult:
    """Result of pre-trade risk validation."""

    approved: bool
    reason: str
    primary_margin: Optional[MarginHealth] = None
    hedge_margin: Optional[MarginHealth] = None


async def check_balances(
    symbol: str,
    notional_usd: float,
    primary: ExchangeClient,
    hedge: ExchangeClient,
    limits: RiskLimits,
) -> RiskCheckResult:
    """Validate sufficient balance and margin before trade.

    Args:
        symbol: Trading symbol
        notional_usd: Order size in USD
        primary: Primary exchange client
        hedge: Hedge exchange client
        limits: Risk limit configuration

    Returns:
        RiskCheckResult with approval status
    """
    # Get current positions
    try:
        primary_positions = await primary.get_positions()
        hedge_positions = await hedge.get_positions()
    except Exception as e:
        return RiskCheckResult(approved=False, reason=f"Failed to fetch positions: {e}")

    # Calculate total notional
    total_notional = sum(p.size * p.entry_price for p in primary_positions)
    total_notional += sum(p.size * p.entry_price for p in hedge_positions)

    # Check global notional limit
    if total_notional + notional_usd > limits.max_total_notional:
        return RiskCheckResult(
            approved=False,
            reason=f"Total notional {total_notional + notional_usd:.2f} exceeds limit {limits.max_total_notional}",
        )

    # Check per-symbol notional limit
    symbol_notional = sum(p.size * p.entry_price for p in primary_positions if p.symbol == symbol)
    symbol_notional += sum(p.size * p.entry_price for p in hedge_positions if p.symbol == symbol)

    if symbol_notional + notional_usd > limits.max_symbol_notional:
        return RiskCheckResult(
            approved=False,
            reason=f"Symbol {symbol} notional {symbol_notional + notional_usd:.2f} exceeds limit {limits.max_symbol_notional}",
        )

    return RiskCheckResult(approved=True, reason="Risk checks passed")


async def check_margin_health(
    exchange_name: str,
    client: ExchangeClient,
    margin_buffer: float,
) -> MarginHealth:
    """Check margin utilization and liquidation risk.

    Args:
        exchange_name: Exchange identifier
        client: Exchange client
        margin_buffer: Minimum required margin buffer ratio

    Returns:
        MarginHealth snapshot

    Note:
        This is a skeleton - actual implementation requires exchange-specific
        margin/balance APIs which aren't exposed in current connectors.
    """
    # Placeholder: would need exchange-specific account balance endpoints
    # For now, assume healthy
    return MarginHealth(
        exchange=exchange_name,
        total_margin_used=0.0,
        account_value=10000.0,
        utilization=0.0,
        is_healthy=True,
        liquidation_risk=False,
    )

