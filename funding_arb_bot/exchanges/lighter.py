"""Lighter exchange connector leveraging the official zklighter SDK."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import AsyncIterator, Dict, List, Optional

from eth_account import Account as EthAccount

import lighter
from lighter.api.account_api import AccountApi
from lighter.api.funding_api import FundingApi
from lighter.api.order_api import OrderApi
from lighter.api_client import ApiClient
from lighter.configuration import Configuration
from lighter.models.account import Account
from lighter.models.funding_rate import FundingRate

from .base import ExchangeClient, FundingSnapshot, OrderRequest, OrderResult, OrderTimeInForce, OrderType, Position, Side, SymbolSpec, Ticker


@dataclass
class _MarketMeta:
    market_id: int
    price_decimals: int
    size_decimals: int


@dataclass
class _AuthContext:
    signer: lighter.SignerClient
    account_index: int


SIGNER_TIF = {
    OrderTimeInForce.IOC: lighter.SignerClient.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
    OrderTimeInForce.GTT: lighter.SignerClient.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
    OrderTimeInForce.POST_ONLY: lighter.SignerClient.ORDER_TIME_IN_FORCE_POST_ONLY,
}

SIGNER_TYPE = {
    OrderType.LIMIT: lighter.SignerClient.ORDER_TYPE_LIMIT,
    OrderType.MARKET: lighter.SignerClient.ORDER_TYPE_MARKET,
}


class LighterClient(ExchangeClient):
    """Adapter over the official zklighter SDK using SignerClient for trading."""

    name = "lighter"

    def __init__(self, base_url: str, private_key: str) -> None:
        self._base_url = base_url
        self._private_key = private_key
        self._api_client = ApiClient(Configuration(host=base_url))
        self._account_api = AccountApi(self._api_client)
        self._funding_api = FundingApi(self._api_client)
        self._order_api = OrderApi(self._api_client)
        self._auth: Optional[_AuthContext] = None
        self._market_meta: Dict[str, _MarketMeta] | None = None

    async def _ensure_auth(self) -> _AuthContext:
        if self._auth is not None:
            return self._auth

        signer = lighter.SignerClient(self._base_url, self._private_key)
        address = EthAccount.from_key(self._private_key).address
        accounts = await self._account_api.accounts_by_l1_address(l1_address=address)
        master = min(accounts.sub_accounts, key=lambda sub: sub.index).index
        self._auth = _AuthContext(signer=signer, account_index=master)
        return self._auth

    async def _load_markets(self) -> Dict[str, _MarketMeta]:
        if self._market_meta is not None:
            return self._market_meta

        details = await self._order_api.order_book_details(filter="all")
        mapping: Dict[str, _MarketMeta] = {}
        for market in details.order_book_details or []:
            symbol = market.symbol
            mapping[symbol] = _MarketMeta(
                market_id=market.market_id,
                price_decimals=market.supported_price_decimals,
                size_decimals=market.supported_size_decimals,
            )
        self._market_meta = mapping
        return mapping

    async def get_symbols(self) -> list[SymbolSpec]:
        markets = await self._load_markets()
        specs: List[SymbolSpec] = []
        for symbol, meta in markets.items():
            base, quote = (symbol.split("/") + ["USDC"])[:2]
            specs.append(
                SymbolSpec(
                    symbol=symbol,
                    base_asset=base,
                    quote_asset=quote,
                    tick_size=10 ** (-meta.price_decimals),
                    lot_size=10 ** (-meta.size_decimals),
                    max_leverage=10.0,
                )
            )
        return specs

    async def funding_stream(self, symbols: list[str]) -> AsyncIterator[FundingSnapshot]:
        targets = set(symbols)
        while True:
            response = await self._funding_api.funding_rates()
            now = int(time.time() * 1000)
            for rate in response.funding_rates:
                if targets and rate.symbol not in targets:
                    continue
                yield _funding_snapshot(rate, now)
            await asyncio.sleep(60)

    async def ticker_stream(self, symbols: list[str]) -> AsyncIterator[Ticker]:
        targets = set(symbols)
        markets = await self._load_markets()
        while True:
            for symbol, meta in markets.items():
                if targets and symbol not in targets:
                    continue
                ob = await self._order_api.order_book_orders(market_id=meta.market_id, limit=1)
                if ob.bids and ob.asks:
                    bid = float(ob.bids[0].price)
                    ask = float(ob.asks[0].price)
                    yield Ticker(symbol=symbol, bid=bid, ask=ask, timestamp=int(time.time() * 1000))
            await asyncio.sleep(5)

    async def get_positions(self) -> list[Position]:
        auth = await self._ensure_auth()
        account: Account = await self._account_api.account(by="index", value=str(auth.account_index))
        positions: List[Position] = []
        for pos in account.positions or []:
            size = float(pos.size)
            side = Side.BUY if size >= 0 else Side.SELL
            positions.append(
                Position(
                    symbol=pos.symbol,
                    side=side,
                    size=abs(size),
                    entry_price=float(pos.entry_price),
                    leverage=float(pos.max_leverage or 1),
                )
            )
        return positions

    async def place_order(self, order: OrderRequest) -> OrderResult:
        auth = await self._ensure_auth()
        markets = await self._load_markets()
        if order.symbol not in markets:
            raise ValueError(f"Unknown symbol {order.symbol}")
        meta = markets[order.symbol]

        base_amount = int(order.size * (10 ** meta.size_decimals))
        tif = SIGNER_TIF[order.time_in_force]
        order_type = SIGNER_TYPE[order.order_type]
        if order.order_type == OrderType.LIMIT:
            if order.price is None:
                raise ValueError("Limit order requires price")
            price = int(order.price * (10 ** meta.price_decimals))
            tx, resp, _ = await auth.signer.create_order(
                market_index=meta.market_id,
                client_order_index=int(time.time() * 1000),
                base_amount=base_amount,
                price=price,
                is_ask=1 if order.side == Side.SELL else 0,
                order_type=order_type,
                time_in_force=tif,
                reduce_only=order.reduce_only,
                order_expiry=int((time.time() + 3600) * 1000),
            )
        else:
            avg_px = int((order.price or 0) * (10 ** meta.price_decimals))
            tx, resp, _ = await auth.signer.create_market_order(
                market_index=meta.market_id,
                client_order_index=int(time.time() * 1000),
                base_amount=base_amount,
                avg_execution_price=avg_px,
                is_ask=1 if order.side == Side.SELL else 0,
                reduce_only=order.reduce_only,
            )

        return OrderResult(
            client_id=order.client_id,
            exchange_order_id=str(resp.tx_hash or tx.tx_hash if hasattr(tx, "tx_hash") else time.time()),
            status=str(resp.code),
            filled_size=0.0,
            average_fill_price=None,
        )

    async def cancel_order(self, exchange_order_id: str) -> None:
        auth = await self._ensure_auth()
        market_id, order_index = exchange_order_id.split(":")
        await auth.signer.cancel_order(market_index=int(market_id), order_index=int(order_index))


def _funding_snapshot(rate: FundingRate, timestamp_ms: int) -> FundingSnapshot:
    return FundingSnapshot(
        symbol=rate.symbol,
        rate=float(rate.rate),
        next_funding_timestamp=timestamp_ms + 8 * 60 * 60 * 1000,
        last_updated=timestamp_ms,
    )


