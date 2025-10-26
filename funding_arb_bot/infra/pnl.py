"""PnL tracking including funding payments, trading fees, and realized gains."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List

logger = logging.getLogger(__name__)


@dataclass
class TradeRecord:
    """Single trade execution record."""

    timestamp: float
    symbol: str
    exchange: str
    side: str
    quantity: float
    price: float
    fee: float
    is_entry: bool


@dataclass
class FundingPayment:
    """Funding payment record."""

    timestamp: float
    symbol: str
    exchange: str
    rate: float
    payment_usd: float
    position_size: float


@dataclass
class PositionPnL:
    """PnL snapshot for a position."""

    symbol: str
    entry_value_usd: float
    current_value_usd: float
    unrealized_pnl: float
    funding_earned: float
    fees_paid: float
    net_pnl: float


class PnLTracker:
    """Track realized/unrealized PnL, funding, and fees."""

    def __init__(self, state_file: Path | str = ".pnl_state.json") -> None:
        self._state_file = Path(state_file)
        self._trades: List[TradeRecord] = []
        self._funding_payments: List[FundingPayment] = []
        self._total_fees = 0.0
        self._total_funding = 0.0
        self._realized_pnl = 0.0
        self._load_state()

    def record_trade(
        self,
        symbol: str,
        exchange: str,
        side: str,
        quantity: float,
        price: float,
        fee: float,
        is_entry: bool,
    ) -> None:
        """Record a trade execution."""
        trade = TradeRecord(
            timestamp=time.time(),
            symbol=symbol,
            exchange=exchange,
            side=side,
            quantity=quantity,
            price=price,
            fee=fee,
            is_entry=is_entry,
        )
        self._trades.append(trade)
        self._total_fees += fee
        self._save_state()

        logger.info(
            "trade_recorded",
            extra={
                "symbol": symbol,
                "exchange": exchange,
                "side": side,
                "quantity": quantity,
                "price": price,
                "fee": fee,
            },
        )

    def record_funding(
        self,
        symbol: str,
        exchange: str,
        rate: float,
        position_size: float,
        payment_usd: float,
    ) -> None:
        """Record a funding payment."""
        funding = FundingPayment(
            timestamp=time.time(),
            symbol=symbol,
            exchange=exchange,
            rate=rate,
            payment_usd=payment_usd,
            position_size=position_size,
        )
        self._funding_payments.append(funding)
        self._total_funding += payment_usd
        self._save_state()

        logger.info(
            "funding_recorded",
            extra={
                "symbol": symbol,
                "exchange": exchange,
                "rate": rate,
                "payment": payment_usd,
            },
        )

    def calculate_position_pnl(
        self,
        symbol: str,
        lighter_entry_px: float,
        lighter_current_px: float,
        lighter_qty: float,
        hl_entry_px: float,
        hl_current_px: float,
        hl_qty: float,
    ) -> PositionPnL:
        """Calculate current PnL for an open position.

        Args:
            symbol: Trading symbol
            lighter_entry_px: Entry price on Lighter
            lighter_current_px: Current price on Lighter
            lighter_qty: Position size on Lighter (signed: + for long, - for short)
            hl_entry_px: Entry price on Hyperliquid
            hl_current_px: Current price on Hyperliquid
            hl_qty: Position size on Hyperliquid (signed)

        Returns:
            PositionPnL with breakdown
        """
        # Calculate unrealized PnL per leg
        lighter_pnl = (lighter_current_px - lighter_entry_px) * lighter_qty
        hl_pnl = (hl_current_px - hl_entry_px) * hl_qty

        unrealized = lighter_pnl + hl_pnl

        # Sum funding for this symbol
        symbol_funding = sum(f.payment_usd for f in self._funding_payments if f.symbol == symbol)

        # Sum fees for this symbol
        symbol_fees = sum(t.fee for t in self._trades if t.symbol == symbol)

        net_pnl = unrealized + symbol_funding - symbol_fees

        entry_value = abs(lighter_entry_px * lighter_qty) + abs(hl_entry_px * hl_qty)
        current_value = abs(lighter_current_px * lighter_qty) + abs(hl_current_px * hl_qty)

        return PositionPnL(
            symbol=symbol,
            entry_value_usd=entry_value,
            current_value_usd=current_value,
            unrealized_pnl=unrealized,
            funding_earned=symbol_funding,
            fees_paid=symbol_fees,
            net_pnl=net_pnl,
        )

    def get_total_pnl(self) -> Dict[str, float]:
        """Get total PnL summary across all positions."""
        return {
            "realized_pnl": self._realized_pnl,
            "total_funding": self._total_funding,
            "total_fees": self._total_fees,
            "net_pnl": self._realized_pnl + self._total_funding - self._total_fees,
        }

    def _save_state(self) -> None:
        """Persist PnL state to disk."""
        try:
            state = {
                "trades": [
                    {
                        "timestamp": t.timestamp,
                        "symbol": t.symbol,
                        "exchange": t.exchange,
                        "side": t.side,
                        "quantity": t.quantity,
                        "price": t.price,
                        "fee": t.fee,
                        "is_entry": t.is_entry,
                    }
                    for t in self._trades
                ],
                "funding_payments": [
                    {
                        "timestamp": f.timestamp,
                        "symbol": f.symbol,
                        "exchange": f.exchange,
                        "rate": f.rate,
                        "payment_usd": f.payment_usd,
                        "position_size": f.position_size,
                    }
                    for f in self._funding_payments
                ],
                "total_fees": self._total_fees,
                "total_funding": self._total_funding,
                "realized_pnl": self._realized_pnl,
            }
            with open(self._state_file, "w") as f:
                json.dump(state, f, indent=2)
        except Exception as e:
            logger.error("pnl_save_failed", extra={"error": str(e)})

    def _load_state(self) -> None:
        """Load PnL state from disk."""
        if not self._state_file.exists():
            return
        try:
            with open(self._state_file, "r") as f:
                state = json.load(f)
            self._total_fees = state.get("total_fees", 0.0)
            self._total_funding = state.get("total_funding", 0.0)
            self._realized_pnl = state.get("realized_pnl", 0.0)
            logger.info("pnl_state_loaded", extra=state)
        except Exception as e:
            logger.error("pnl_load_failed", extra={"error": str(e)})

