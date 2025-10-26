"""Abstract base classes and typed models for exchange connectors."""

from __future__ import annotations

import abc
from dataclasses import dataclass
from enum import Enum
from typing import AsyncIterator, Protocol


class Side(str, Enum):
    """Order side."""

    BUY = "buy"
    SELL = "sell"


class OrderType(str, Enum):
    """Supported order types."""

    MARKET = "market"
    LIMIT = "limit"


class OrderTimeInForce(str, Enum):
    """Time in force policies for orders."""

    IOC = "ioc"
    GTT = "gtt"
    POST_ONLY = "post_only"


@dataclass(frozen=True)
class SymbolSpec:
    """Static attributes of a tradable symbol."""

    symbol: str
    base_asset: str
    quote_asset: str
    tick_size: float
    lot_size: float
    max_leverage: float


@dataclass(frozen=True)
class FundingSnapshot:
    """Funding information for a symbol."""

    symbol: str
    rate: float
    next_funding_timestamp: int
    last_updated: int


@dataclass(frozen=True)
class Ticker:
    """Bid/ask mid snapshot."""

    symbol: str
    bid: float
    ask: float
    timestamp: int


@dataclass(frozen=True)
class Position:
    """Representation of an open position."""

    symbol: str
    side: Side
    size: float
    entry_price: float
    leverage: float


@dataclass(frozen=True)
class OrderRequest:
    """Order intent envelope for execution router."""

    client_id: str
    symbol: str
    side: Side
    size: float
    order_type: OrderType
    price: float | None = None
    reduce_only: bool = False
    time_in_force: OrderTimeInForce = OrderTimeInForce.GTT


@dataclass(frozen=True)
class OrderResult:
    """Result of an order submission."""

    client_id: str
    exchange_order_id: str
    status: str
    filled_size: float
    average_fill_price: float | None


class ExchangeClient(Protocol):
    """Common interface for exchange connectors."""

    name: str

    async def get_symbols(self) -> list[SymbolSpec]:
        """Return all tradable symbol specifications."""

    async def funding_stream(self, symbols: list[str]) -> AsyncIterator[FundingSnapshot]:
        """Yield funding updates for requested symbols."""

    async def ticker_stream(self, symbols: list[str]) -> AsyncIterator[Ticker]:
        """Yield ticker updates for requested symbols."""

    async def get_positions(self) -> list[Position]:
        """Return current open positions."""

    async def place_order(self, order: OrderRequest) -> OrderResult:
        """Submit an order and return the outcome."""

    async def cancel_order(self, exchange_order_id: str) -> None:
        """Cancel an existing order."""


class ExchangeFactory(Protocol):
    """Factory protocol for dependency injection of exchange clients."""

    def __call__(self, *args, **kwargs) -> ExchangeClient:
        ...


