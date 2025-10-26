from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class FundingSnapshot:
    symbol: str
    hyperliquid_rate_bps: float
    lighter_rate_bps: float
    timestamp_ms: int


@dataclass
class StrategyDecision:
    symbol: str
    edge_bps: float
    direction: str  # long_hl_short_lighter or inverse
    size: float
    action: str  # enter / exit / rebalance


class StrategyEngine:
    def __init__(self, min_edge_bps: float, exit_edge_bps: float) -> None:
        self._min_edge_bps = min_edge_bps
        self._exit_edge_bps = exit_edge_bps
        self._open_positions: dict[str, StrategyDecision] = {}

    def evaluate(self, snapshot: FundingSnapshot, notional: float) -> Optional[StrategyDecision]:
        edge = snapshot.hyperliquid_rate_bps - snapshot.lighter_rate_bps
        if snapshot.symbol in self._open_positions:
            if abs(edge) <= self._exit_edge_bps:
                decision = self._open_positions.pop(snapshot.symbol)
                decision.action = "exit"
                return decision
            return None

        if abs(edge) < self._min_edge_bps:
            return None

        direction = "long_hl_short_lighter" if edge > 0 else "long_lighter_short_hl"
        decision = StrategyDecision(
            symbol=snapshot.symbol,
            edge_bps=edge,
            direction=direction,
            size=notional,
            action="enter",
        )
        self._open_positions[snapshot.symbol] = decision
        return decision


