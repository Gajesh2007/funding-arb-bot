from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Tuple

from funding_arb_bot.exchanges.base import ExchangeClient, OrderRequest, OrderResult


@dataclass
class DualLegIntent:
    leg_a: OrderRequest
    leg_b: OrderRequest


class ExecutionError(Exception):
    def __init__(self, leg: str, error: Exception, partial: Tuple[OrderResult | None, OrderResult | None]) -> None:
        super().__init__(str(error))
        self.leg = leg
        self.partial = partial
        self.original = error


class ExecutionRouter:
    def __init__(self, primary: ExchangeClient, hedge: ExchangeClient) -> None:
        self._primary = primary
        self._hedge = hedge

    async def execute(self, intent: DualLegIntent) -> tuple[OrderResult, OrderResult]:
        try:
            primary_result, hedge_result = await asyncio.gather(
                self._primary.place_order(intent.leg_a),
                self._hedge.place_order(intent.leg_b),
            )
        except Exception as exc:
            await self._handle_failure(intent, exc)
        else:
            return primary_result, hedge_result

    async def _handle_failure(self, intent: DualLegIntent, exc: Exception) -> None:
        # Attempt sequential execution to identify which leg failed
        primary_result: OrderResult | None = None
        hedge_result: OrderResult | None = None
        try:
            primary_result = await self._primary.place_order(intent.leg_a)
        except Exception as primary_exc:
            raise ExecutionError("primary", primary_exc, (primary_result, hedge_result)) from primary_exc
        try:
            hedge_result = await self._hedge.place_order(intent.leg_b)
        except Exception as hedge_exc:
            await self._attempt_cancel(intent, primary_result)
            raise ExecutionError("hedge", hedge_exc, (primary_result, hedge_result)) from hedge_exc
        raise ExecutionError("parallel", exc, (primary_result, hedge_result)) from exc

    async def _attempt_cancel(self, intent: DualLegIntent, primary_result: OrderResult | None) -> None:
        if primary_result is None:
            return
        try:
            await self._primary.cancel_order(primary_result.exchange_order_id)
        except Exception:
            # Cancellation best-effort; log upstream
            pass


