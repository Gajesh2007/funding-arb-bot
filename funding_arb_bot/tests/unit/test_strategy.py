import pytest

from funding_arb_bot.strategy.engine import FundingSnapshot, StrategyEngine


def test_strategy_enter_exit_cycle():
    engine = StrategyEngine(min_edge_bps=20, exit_edge_bps=5)
    snapshot = FundingSnapshot(symbol="ETH", hyperliquid_rate_bps=50, lighter_rate_bps=10, timestamp_ms=0)
    decision = engine.evaluate(snapshot, notional=1000)
    assert decision is not None
    assert decision.action == "enter"
    exit_snapshot = FundingSnapshot(symbol="ETH", hyperliquid_rate_bps=5, lighter_rate_bps=4, timestamp_ms=1)
    exit_decision = engine.evaluate(exit_snapshot, notional=1000)
    assert exit_decision is not None
    assert exit_decision.action == "exit"

