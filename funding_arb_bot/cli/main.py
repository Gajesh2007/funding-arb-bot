from __future__ import annotations

import asyncio
import logging
import time
from typing import List, Optional

import typer
from hyperliquid.info import Info
from lighter import ApiClient, Configuration, FundingApi

from funding_arb_bot.config import ExecutionConfig, TimeInForce, load_settings
from funding_arb_bot.exchanges.base import OrderRequest, OrderTimeInForce, OrderType, Side
from funding_arb_bot.exchanges.hyperliquid import HyperliquidClient
from funding_arb_bot.exchanges.lighter import LighterClient
from funding_arb_bot.execution.router import DualLegIntent, ExecutionError, ExecutionRouter
from funding_arb_bot.infra.logging import setup_logging
from funding_arb_bot.strategy import BotState, FundingSnapshot, StrategyContext, StrategyEngine

app = typer.Typer(add_completion=False)


@app.command(name="spot")
def spot_opportunities(
    min_edge_bps: float = typer.Option(20.0, help="Minimum funding rate edge in basis points"),
    symbols: List[str] = typer.Option([], "--symbol", "-s", help="Symbols to track (default: all common)"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show all compared symbols"),
    log_level: str = typer.Option("ERROR", help="Logging level"),
) -> None:
    """Continuously spot funding arbitrage opportunities without trading."""

    level = getattr(logging, log_level.upper(), logging.ERROR)
    setup_logging(level, json_format=False)

    async def scan_loop() -> None:
        lighter_client = ApiClient(Configuration(host="https://mainnet.zklighter.elliot.ai"))
        lighter_api = FundingApi(lighter_client)
        hl_info = Info()

        print(f"\nScanning for funding arb opportunities (min edge: {min_edge_bps} bps)...\n", flush=True)
        print(f"{'Symbol':<10} {'HL Rate %':<12} {'Ltr Rate %':<12} {'Edge':<10} {'APY %':<10} {'Direction':<35}", flush=True)
        print("=" * 100, flush=True)

        try:
            while True:
                lighter_rates_response = await lighter_api.funding_rates()
                hl_data = await asyncio.get_running_loop().run_in_executor(None, hl_info.meta_and_asset_ctxs)

                # Build maps: only include lighter-native rates
                lighter_rates = {}
                for rate in lighter_rates_response.funding_rates:
                    if rate.exchange == "lighter":
                        lighter_rates[rate.symbol] = float(rate.rate)

                # Build HL rates map from meta_and_asset_ctxs
                hl_meta, hl_ctxs = hl_data
                hl_rates = {}
                for idx, ctx in enumerate(hl_ctxs):
                    if idx < len(hl_meta["universe"]):
                        symbol = hl_meta["universe"][idx]["name"]
                        funding = ctx.get("funding")
                        if funding is not None:
                            hl_rates[symbol] = float(funding)

                # Only consider symbols that exist on BOTH exchanges
                symbols_to_check = set(symbols) if symbols else (set(lighter_rates.keys()) & set(hl_rates.keys()))

                opportunities = []
                compared = []
                for symbol in symbols_to_check:
                    if symbol not in lighter_rates or symbol not in hl_rates:
                        continue

                    hl_rate = hl_rates[symbol]
                    lg_rate = lighter_rates[symbol]

                    # Skip if BOTH sides are exactly zero (market likely doesn't exist on both)
                    if hl_rate == 0.0 and lg_rate == 0.0:
                        continue

                    edge_bps = (hl_rate - lg_rate) * 10000
                    apy = abs(edge_bps) * 3 * 365 / 100  # 3 payments/day, convert bps to %

                    compared.append((symbol, hl_rate, lg_rate, edge_bps))

                    if abs(edge_bps) >= min_edge_bps:
                        direction = "Long Lighter / Short Hyperliquid" if edge_bps > 0 else "Long Hyperliquid / Short Lighter"
                        opportunities.append((symbol, hl_rate, lg_rate, edge_bps, apy, direction))

                if verbose and compared:
                    print(f"\nCompared {len(compared)} symbols available on both exchanges", flush=True)
                    for sym, hl, lg, edge in sorted(compared, key=lambda x: abs(x[3]), reverse=True)[:10]:
                        print(f"  {sym:<10} HL:{hl*100:>8.4f}% Ltr:{lg*100:>8.4f}% Edge:{edge:>7.2f}bps", flush=True)
                    print()

                if opportunities:
                    opportunities.sort(key=lambda x: abs(x[3]), reverse=True)
                    for symbol, hl_rate, lg_rate, edge_bps, apy, direction in opportunities:
                        print(
                            f"{symbol:<10} {hl_rate*100:>11.6f} {lg_rate*100:>11.6f} {edge_bps:>9.2f} {apy:>9.1f} {direction:<35}",
                            flush=True,
                        )
                    print(f"\nFound {len(opportunities)} opportunities at {time.strftime('%H:%M:%S')}\n", flush=True)
                else:
                    print(f"No opportunities found at {time.strftime('%H:%M:%S')}", flush=True)

                await asyncio.sleep(60)

        except KeyboardInterrupt:
            print("\nStopped scanning.", flush=True)
        finally:
            await lighter_client.rest_client.close()

    asyncio.run(scan_loop())


@app.command()
def run(
    profile: Optional[str] = typer.Option(None, help="Config profile env override"),
    log_level: str = typer.Option("INFO", help="Logging level"),
):
    """Start the funding arbitrage bot."""

    level = getattr(logging, log_level.upper(), logging.INFO)
    setup_logging(level, json_format=True)

    settings = load_settings()
    log = logging.getLogger(__name__)
    log.info("bot.start", extra={"env": settings.environment})
    asyncio.run(main_loop())


@app.command(name="funding-scan")
def funding_scan(
    lighter_base_url: str = typer.Option(
        "https://mainnet.zklighter.elliot.ai", help="Lighter API base URL"
    ),
    hl_symbols: List[str] = typer.Option(
        [], "--hl-symbol", "-s", help="Hyperliquid symbols to query funding history for"
    ),
    hours: int = typer.Option(24, help="Hours back for Hyperliquid funding history window"),
    log_level: str = typer.Option("INFO", help="Logging level"),
):
    """Print current Lighter funding rates and recent Hyperliquid funding history."""

    print("Starting funding scan...", flush=True)

    level = getattr(logging, log_level.upper(), logging.ERROR)
    setup_logging(level, json_format=False)
    log = logging.getLogger(__name__)

    async def lighter_task() -> dict:
        client = ApiClient(Configuration(host=lighter_base_url))
        try:
            api = FundingApi(client)
            rates = await api.funding_rates()
            payload = rates.to_dict() if hasattr(rates, "to_dict") else str(rates)
            log.info("lighter.funding_rates", extra={"data": payload})
            return payload
        except Exception as exc:
            log.error("lighter.error", extra={"error": str(exc)})
            raise
        finally:
            try:
                await client.rest_client.close()
            except Exception:
                pass

    def hyperliquid_task() -> dict[str, list]:
        if not hl_symbols:
            return {}
        try:
            info = Info()
            end_ms = int(time.time() * 1000)
            start_ms = end_ms - hours * 3600 * 1000
            result: dict[str, list] = {}
            for sym in hl_symbols:
                try:
                    hist = info.funding_history(name=sym, startTime=start_ms, endTime=end_ms)
                    log.info("hl.funding_history", extra={"symbol": sym, "data": hist})
                    result[sym] = hist
                except Exception as e:
                    log.error("hl.error", extra={"symbol": sym, "error": str(e)})
            return result
        except Exception as exc:
            log.error("hl.init_error", extra={"error": str(exc)})
            raise

    async def main_inner() -> None:
        print("=== Lighter Funding Rates ===", flush=True)
        try:
            lighter_data = await lighter_task()
            for rate in lighter_data.get("funding_rates", []):
                print(f"  {rate['exchange']:12} {rate['symbol']:15} {rate['rate']:12.8f}", flush=True)
        except Exception as exc:
            print(f"Lighter error: {exc}", file=sys.stderr, flush=True)

        if hl_symbols:
            print("\n=== Hyperliquid Funding History ===", flush=True)
            loop = asyncio.get_running_loop()
            try:
                hl_data = await loop.run_in_executor(None, hyperliquid_task)
                for sym, hist in hl_data.items():
                    print(f"\n{sym}: {len(hist)} funding events", flush=True)
                    for entry in hist[-5:]:
                        print(f"  {entry['time']:15} {float(entry['fundingRate']):12.8f}", flush=True)
            except Exception as exc:
                print(f"Hyperliquid error: {exc}", file=sys.stderr, flush=True)

    asyncio.run(main_inner())


async def main_loop() -> None:
    settings = load_settings()
    log = logging.getLogger(__name__)

    execution_cfg: ExecutionConfig = settings.execution
    tif_enum_map = {
        TimeInForce.IOC: OrderTimeInForce.IOC,
        TimeInForce.GTT: OrderTimeInForce.GTT,
        TimeInForce.POST_ONLY: OrderTimeInForce.POST_ONLY,
    }

    lighter = LighterClient(settings.lighter.base_url, settings.lighter.credentials.private_key or "")
    hyperliquid = HyperliquidClient(settings.hyperliquid.base_url, settings.hyperliquid.credentials.private_key or "")

    router = ExecutionRouter(primary=lighter, hedge=hyperliquid)
    engine = StrategyEngine(settings.strategy.min_edge_bps, settings.strategy.exit_edge_bps)
    context = StrategyContext()
    tracked_symbols = settings.strategy.tracked_symbols
    tif = tif_enum_map[execution_cfg.time_in_force]

    async def poll_funding(symbol: str) -> FundingSnapshot:
        hl_rates = await hyperliquid.funding_stream([symbol]).__anext__()
        lg_rates = await lighter.funding_stream([symbol]).__anext__()
        return FundingSnapshot(
            symbol=symbol,
            hyperliquid_rate_bps=hl_rates.rate * 1e4,
            lighter_rate_bps=lg_rates.rate * 1e4,
            timestamp_ms=hl_rates.last_updated,
        )

    while True:
        for symbol in tracked_symbols:
            snapshot = await poll_funding(symbol)
            decision = engine.evaluate(snapshot, execution_cfg.order_notional)
            if decision is None:
                continue

            log.info(
                "strategy.decision",
                extra={
                    "symbol": decision.symbol,
                    "action": decision.action,
                    "edge_bps": decision.edge_bps,
                    "direction": decision.direction,
                },
            )

            if decision.action == "enter":
                context.state = BotState.ENTERING
                size = decision.size
                primary_side = Side.BUY if decision.direction == "long_lighter_short_hl" else Side.SELL
                hedge_side = Side.SELL if primary_side == Side.BUY else Side.BUY
                intent = DualLegIntent(
                    leg_a=OrderRequest(
                        client_id=f"lighter:{symbol}",
                        symbol=symbol,
                        side=primary_side,
                        size=size,
                        order_type=OrderType.MARKET,
                        reduce_only=False,
                        time_in_force=tif,
                    ),
                    leg_b=OrderRequest(
                        client_id=f"hyperliquid:{symbol}",
                        symbol=symbol,
                        side=hedge_side,
                        size=size,
                        order_type=OrderType.MARKET,
                        reduce_only=False,
                        time_in_force=OrderTimeInForce.IOC,
                    ),
                )
                try:
                    await router.execute(intent)
                    context.state = BotState.HEDGED
                    context.positions[symbol] = size
                except ExecutionError as exc:
                    log.error("execution.failed", extra={"symbol": symbol, "leg": exc.leg, "error": str(exc)})

            elif decision.action == "exit":
                if symbol not in context.positions:
                    continue
                context.state = BotState.EXITING
                size = context.positions.pop(symbol)
                intent = DualLegIntent(
                    leg_a=OrderRequest(
                        client_id=f"lighter-exit:{symbol}",
                        symbol=symbol,
                        side=Side.SELL if decision.direction == "long_lighter_short_hl" else Side.BUY,
                        size=size,
                        order_type=OrderType.MARKET,
                        reduce_only=True,
                        time_in_force=OrderTimeInForce.IOC,
                    ),
                    leg_b=OrderRequest(
                        client_id=f"hyperliquid-exit:{symbol}",
                        symbol=symbol,
                        side=Side.BUY if decision.direction == "long_lighter_short_hl" else Side.SELL,
                        size=size,
                        order_type=OrderType.MARKET,
                        reduce_only=True,
                        time_in_force=OrderTimeInForce.IOC,
                    ),
                )
                try:
                    await router.execute(intent)
                    context.state = BotState.IDLE
                except ExecutionError as exc:
                    log.error("exit.failed", extra={"symbol": symbol, "error": str(exc)})

        await asyncio.sleep(settings.strategy.rebalance_interval_seconds)


def main() -> None:
    """CLI entry point."""
    app()


if __name__ == "__main__":
    main()


