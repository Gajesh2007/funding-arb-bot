"""Hyperliquid exchange connector leveraging hyperliquid-python-sdk."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncIterator, Dict, List, Optional

from hyperliquid.exchange import Exchange
from hyperliquid.info import Info

from .base import ExchangeClient, FundingSnapshot, OrderRequest, OrderResult, OrderTimeInForce, OrderType, Position, Side, SymbolSpec, Ticker

HL_TIF = {
    OrderTimeInForce.POST_ONLY: {"limit": {"tif": "Alo"}},
    OrderTimeInForce.IOC: {"limit": {"tif": "Ioc"}},
    OrderTimeInForce.GTT: {"limit": {"tif": "Gtc"}},
}


class HyperliquidClient(ExchangeClient):
    """Adapter over hyperliquid-python-sdk."""

    name = "hyperliquid"

    def __init__(self, base_url: str, agent_private_key: str) -> None:
        self._base_url = base_url
        self._info = Info(base_url=base_url)
        self._exchange = Exchange(agent_private_key, base_url)
        self._executor = ThreadPoolExecutor(max_workers=4)
        self._symbols: Optional[Dict[str, SymbolSpec]] = None

    async def get_symbols(self) -> list[SymbolSpec]:
        if self._symbols is None:
            loop = asyncio.get_running_loop()
            universe = await loop.run_in_executor(self._executor, self._info.meta)
            mapping: Dict[str, SymbolSpec] = {}
            for entry in universe["universe"]:
                symbol = entry["name"]
                px_decimals = entry.get("pxDecimals", 4)
                sz_decimals = entry.get("szDecimals", 3)
                mapping[symbol] = SymbolSpec(
                    symbol=symbol,
                    base_asset=symbol,
                    quote_asset="USDC",
                    tick_size=10 ** (-px_decimals),
                    lot_size=10 ** (-sz_decimals),
                    max_leverage=float(entry.get("maxLeverage", 10)),
                )
            self._symbols = mapping
        return list(self._symbols.values())

    async def funding_stream(self, symbols: list[str]) -> AsyncIterator[FundingSnapshot]:
        symbols_set = set(symbols)
        while True:
            loop = asyncio.get_running_loop()
            data = await loop.run_in_executor(self._executor, self._info.meta_and_asset_ctxs)
            meta, ctxs = data
            for idx, ctx in enumerate(ctxs):
                if idx >= len(meta["universe"]):
                    break
                symbol = meta["universe"][idx]["name"]
                if symbols_set and symbol not in symbols_set:
                    continue
                funding = ctx.get("funding")
                if funding is not None:
                    rate = float(funding)
                    ts = int(time.time() * 1000)
                    yield FundingSnapshot(symbol=symbol, rate=rate, next_funding_timestamp=ts, last_updated=ts)
            await asyncio.sleep(60)

    async def ticker_stream(self, symbols: list[str]) -> AsyncIterator[Ticker]:
        symbols_set = set(symbols)
        loop = asyncio.get_running_loop()
        while True:
            mids = await loop.run_in_executor(self._executor, self._info.all_mids)
            timestamp = int(asyncio.get_running_loop().time() * 1000)
            for sym, data in mids.items():
                if symbols_set and sym not in symbols_set:
                    continue
                bid = float(data["bestBid"])
                ask = float(data["bestAsk"])
                yield Ticker(symbol=sym, bid=bid, ask=ask, timestamp=timestamp)
            await asyncio.sleep(5)

    async def get_positions(self) -> list[Position]:
        loop = asyncio.get_running_loop()
        state = await loop.run_in_executor(self._executor, self._info.user_state, self._exchange.wallet.address)
        positions: List[Position] = []
        for pos in state.get("positions", []):
            coin = pos["coin"]
            size = float(pos["position"]["szi"])
            entry = float(pos["position"]["entryPx"])
            side = Side.BUY if size > 0 else Side.SELL
            positions.append(
                Position(
                    symbol=coin,
                    side=side,
                    size=abs(size),
                    entry_price=entry,
                    leverage=float(pos["position"]["leverage"] or 1),
                )
            )
        return positions

    async def place_order(self, order: OrderRequest) -> OrderResult:
        loop = asyncio.get_running_loop()
        is_buy = order.side == Side.BUY
        if order.order_type == OrderType.LIMIT:
            hl_type = HL_TIF.get(order.time_in_force, HL_TIF[OrderTimeInForce.GTT])
        else:
            hl_type = {
                "trigger": {
                    "triggerPx": float(order.price or 0),
                    "isMarket": True,
                    "tpsl": "na",
                }
            }
        response = await loop.run_in_executor(
            self._executor,
            self._exchange.order,
            order.symbol,
            is_buy,
            order.size,
            order.price or 0,
            hl_type,
            order.reduce_only,
        )
        return OrderResult(
            client_id=order.client_id,
            exchange_order_id=str(response["status"]["oid"]),
            status=response["status"]["status"],
            filled_size=float(response["status"].get("filled", 0)),
            average_fill_price=float(response["status"].get("avgFillPrice", 0)),
        )

    async def cancel_order(self, exchange_order_id: str) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self._executor, self._exchange.cancel, order_id=int(exchange_order_id))


