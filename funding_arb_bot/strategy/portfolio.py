"""Portfolio manager for multi-symbol hedging and allocation."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, List

from funding_arb_bot.strategy.engine import StrategyDecision

logger = logging.getLogger(__name__)


@dataclass
class PortfolioAllocation:
    """Allocation decision for multi-symbol portfolio."""

    symbol: str
    allocated_notional: float
    priority: int


class PortfolioManager:
    """Manage allocation across multiple symbols with position limits."""

    def __init__(
        self,
        max_total_notional: float,
        max_symbol_notional: float,
        max_positions: int = 5,
    ) -> None:
        self._max_total_notional = max_total_notional
        self._max_symbol_notional = max_symbol_notional
        self._max_positions = max_positions
        self._open_positions: Dict[str, float] = {}

    def allocate(
        self,
        opportunities: List[StrategyDecision],
        base_notional: float,
    ) -> List[PortfolioAllocation]:
        """Allocate capital across multiple opportunities.

        Args:
            opportunities: List of strategy decisions sorted by edge
            base_notional: Base notional per position

        Returns:
            List of allocations respecting limits
        """
        allocations: List[PortfolioAllocation] = []
        total_allocated = sum(self._open_positions.values())

        for idx, opp in enumerate(opportunities):
            # Skip if already have position
            if opp.symbol in self._open_positions:
                continue

            # Check position count limit
            if len(self._open_positions) + len(allocations) >= self._max_positions:
                logger.info(
                    "max_positions_reached",
                    extra={"max": self._max_positions, "current": len(self._open_positions)},
                )
                break

            # Scale notional by edge strength (higher edge = more allocation)
            # But cap at max_symbol_notional
            edge_multiplier = min(opp.edge_bps / 20, 2.0)  # 20 bps baseline, max 2x
            allocated = min(base_notional * edge_multiplier, self._max_symbol_notional)

            # Check total notional limit
            if total_allocated + allocated > self._max_total_notional:
                remaining = self._max_total_notional - total_allocated
                if remaining > base_notional * 0.5:
                    allocated = remaining
                else:
                    logger.info("max_total_notional_reached", extra={"total": total_allocated})
                    break

            allocations.append(
                PortfolioAllocation(
                    symbol=opp.symbol,
                    allocated_notional=allocated,
                    priority=idx,
                )
            )
            total_allocated += allocated

        return allocations

    def register_position(self, symbol: str, notional: float) -> None:
        """Register a newly opened position."""
        self._open_positions[symbol] = notional

    def close_position(self, symbol: str) -> None:
        """Remove a closed position."""
        self._open_positions.pop(symbol, None)

    def get_open_symbols(self) -> List[str]:
        """Get list of symbols with open positions."""
        return list(self._open_positions.keys())

    def get_available_capacity(self) -> float:
        """Get remaining notional capacity."""
        used = sum(self._open_positions.values())
        return max(0, self._max_total_notional - used)

