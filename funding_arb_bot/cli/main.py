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
from funding_arb_bot.execution.price_coordination import calculate_limit_prices, get_coordinated_prices
from funding_arb_bot.execution.risk import check_balances
from funding_arb_bot.execution.router import DualLegIntent, ExecutionError, ExecutionResult, ExecutionRouter
from funding_arb_bot.execution.sizing import calculate_quantity
from funding_arb_bot.execution.rebalance import detect_drift, execute_rebalance, plan_rebalance
from funding_arb_bot.infra.killswitch import KillSwitch
from funding_arb_bot.infra.logging import setup_logging
from funding_arb_bot.infra.persistence import PositionStore
from funding_arb_bot.infra.pnl import PnLTracker
from funding_arb_bot.infra.reconnect import resilient_stream, retry_api_call
from funding_arb_bot.strategy import BotState, FundingSnapshot, StrategyContext, StrategyEngine
from funding_arb_bot.strategy.portfolio import PortfolioManager

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


@app.command(name="pnl")
def show_pnl() -> None:
    """Display current PnL summary and statistics."""
    pnl_tracker = PnLTracker(".pnl_state.json")
    total = pnl_tracker.get_total_pnl()
    
    print("\n=== PnL Summary ===")
    print(f"Realized PnL:     ${total['realized_pnl']:>12.2f}")
    print(f"Funding Earned:   ${total['total_funding']:>12.2f}")
    print(f"Fees Paid:        ${total['total_fees']:>12.2f}")
    print(f"{'='*40}")
    print(f"Net PnL:          ${total['net_pnl']:>12.2f}")
    print()


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

    router = ExecutionRouter(primary=lighter, hedge=hyperliquid, auto_reconcile=True)
    engine = StrategyEngine(settings.strategy.min_edge_bps, settings.strategy.exit_edge_bps)
    portfolio = PortfolioManager(
        max_total_notional=settings.risk.max_total_notional,
        max_symbol_notional=settings.risk.max_symbol_notional,
        max_positions=5,
    )
    context = StrategyContext()
    tracked_symbols = settings.strategy.tracked_symbols
    tif = tif_enum_map[execution_cfg.time_in_force]
    
    # Initialize safety systems
    killswitch = KillSwitch(max_consecutive_failures=3, max_total_failures_per_hour=10)
    position_store = PositionStore(".positions.json")
    pnl_tracker = PnLTracker(".pnl_state.json")
    
    # Restore positions from disk (crash recovery)
    persisted = position_store.load()
    if persisted:
        context.positions = persisted
        for sym, pos_data in persisted.items():
            if isinstance(pos_data, dict):
                portfolio.register_position(sym, pos_data.get("size", 0))
        log.info("positions_restored", extra={"count": len(persisted), "symbols": list(persisted.keys())})
    
    # Show initial PnL state
    total_pnl = pnl_tracker.get_total_pnl()
    log.info("bot.initialized", extra={"tracked_symbols": tracked_symbols, "pnl": total_pnl})

    async def poll_funding(symbol: str) -> FundingSnapshot:
        """Fetch funding rates with retry logic."""
        try:
            hl_rates = await retry_api_call(hyperliquid.funding_stream([symbol]).__anext__())
            lg_rates = await retry_api_call(lighter.funding_stream([symbol]).__anext__())
            return FundingSnapshot(
                symbol=symbol,
                hyperliquid_rate_bps=hl_rates.rate * 1e4,
                lighter_rate_bps=lg_rates.rate * 1e4,
                timestamp_ms=hl_rates.last_updated,
            )
        except Exception as e:
            log.error("funding_poll_failed", extra={"symbol": symbol, "error": str(e)})
            killswitch.record_failure(f"Funding poll: {e}")
            raise

    while True:
        # Check kill switch
        if killswitch.is_tripped:
            log.critical("bot_halted", extra={"reason": killswitch.trip_reason})
            break

        # Collect all opportunities across tracked symbols
        opportunities = []
        for symbol in tracked_symbols:
            try:
                snapshot = await poll_funding(symbol)
                decision = engine.evaluate(snapshot, execution_cfg.order_notional)
                if decision and decision.action == "enter":
                    opportunities.append(decision)
            except Exception as e:
                log.error("snapshot_failed", extra={"symbol": symbol, "error": str(e)})
                continue

        # Multi-symbol allocation
        if opportunities:
            allocations = portfolio.allocate(opportunities, execution_cfg.order_notional)
            log.info(
                "portfolio_allocation",
                extra={
                    "opportunities": len(opportunities),
                    "allocated": len(allocations),
                    "available_capacity": portfolio.get_available_capacity(),
                },
            )

            for allocation in allocations:
                # Find the decision for this symbol
                decision = next((o for o in opportunities if o.symbol == allocation.symbol), None)
                if not decision:
                    continue
                
                # Override notional with portfolio allocation
                decision.size = allocation.allocated_notional
                symbol = decision.symbol

                log.info(
                    "strategy.decision",
                    extra={
                        "symbol": decision.symbol,
                        "action": decision.action,
                        "edge_bps": decision.edge_bps,
                        "direction": decision.direction,
                        "allocated_notional": allocation.allocated_notional,
                    },
                )

                # Execute entry for this symbol
                await execute_entry(symbol, decision)

        # Check for exits across all open positions
        for symbol in list(context.positions.keys()):
            try:
                snapshot = await poll_funding(symbol)
                decision = engine.evaluate(snapshot, execution_cfg.order_notional)
                if decision and decision.action == "exit":
                    await execute_exit(symbol, decision)
            except Exception as e:
                log.error("exit_check_failed", extra={"symbol": symbol, "error": str(e)})

        # Active rebalancing check
        if context.positions:
            await check_and_rebalance()

        await asyncio.sleep(settings.strategy.rebalance_interval_seconds)

    async def check_and_rebalance() -> None:
        """Check all open positions for drift and rebalance if needed."""
        lighter_positions = await lighter.get_positions()
        hl_positions = await hyperliquid.get_positions()

        for symbol in portfolio.get_open_symbols():
            lighter_pos = next((p for p in lighter_positions if p.symbol == symbol), None)
            hl_pos = next((p for p in hl_positions if p.symbol == symbol), None)

            drift = detect_drift(symbol, lighter_pos, hl_pos, settings.risk.drift_threshold_bps)
            if drift and drift.needs_rebalance:
                log.warning(
                    "drift_detected",
                    extra={
                        "symbol": symbol,
                        "drift_bps": drift.drift_bps,
                        "drift_qty": drift.drift_quantity,
                    },
                )

                action = plan_rebalance(drift)
                try:
                    # Get current price for rebalance
                    coords = await get_coordinated_prices(symbol, lighter, hyperliquid, max_spread_bps=50)
                    rebalance_price = coords.hedge_price if action.exchange == "hyperliquid" else coords.primary_price

                    await execute_rebalance(action, lighter, hyperliquid, rebalance_price)
                    log.info("rebalance_executed", extra={"symbol": symbol, "exchange": action.exchange})
                except Exception as e:
                    log.error("rebalance_failed", extra={"symbol": symbol, "error": str(e)})

    async def execute_entry(symbol: str, decision) -> None:
        """Execute entry for a single symbol."""
        context.state = BotState.ENTERING
        
        # Pre-trade risk check
        risk_check = await check_balances(symbol, decision.size, lighter, hyperliquid, settings.risk)
        if not risk_check.approved:
            log.warning("risk_check_failed", extra={"symbol": symbol, "reason": risk_check.reason})
            killswitch.record_failure(f"Risk check: {risk_check.reason}")
            return
            
        # Get coordinated prices from both exchanges
        try:
            coords = await get_coordinated_prices(
                symbol, lighter, hyperliquid, max_spread_bps=execution_cfg.slippage_bps * 2
            )
            if not coords.is_acceptable:
                log.warning(
                    "price_spread_too_wide",
                    extra={"symbol": symbol, "spread_bps": coords.mid_spread_bps},
                )
                return
        except Exception as e:
            log.error("price_fetch_failed", extra={"symbol": symbol, "error": str(e)})
            killswitch.record_failure(f"Price fetch: {e}")
            return

        # Get symbol specs for sizing
        lighter_specs = await lighter.get_symbols()
        hl_specs = await hyperliquid.get_symbols()
        lighter_spec = next((s for s in lighter_specs if s.symbol == symbol), None)
        hl_spec = next((s for s in hl_specs if s.symbol == symbol), None)
        
        if not lighter_spec or not hl_spec:
            log.error("symbol_spec_missing", extra={"symbol": symbol})
            return

        # Calculate quantities using USD notional and current prices
        lighter_qty = calculate_quantity(decision.size, coords.primary_price, lighter_spec)
        hl_qty = calculate_quantity(decision.size, coords.hedge_price, hl_spec)

        # Determine sides and limit prices
        primary_side = Side.BUY if decision.direction == "long_lighter_short_hl" else Side.SELL
        hedge_side = Side.SELL if primary_side == Side.BUY else Side.BUY
        
        lighter_limit, hl_limit = calculate_limit_prices(
            coords,
            is_buy_primary=(primary_side == Side.BUY),
            is_buy_hedge=(hedge_side == Side.BUY),
            slippage_bps=execution_cfg.slippage_bps,
        )

        intent = DualLegIntent(
            leg_a=OrderRequest(
                client_id=f"lighter:{symbol}:{int(time.time())}",
                symbol=symbol,
                side=primary_side,
                size=lighter_qty,
                order_type=OrderType.LIMIT,
                price=lighter_limit,
                reduce_only=False,
                time_in_force=OrderTimeInForce.IOC,
            ),
            leg_b=OrderRequest(
                client_id=f"hyperliquid:{symbol}:{int(time.time())}",
                symbol=symbol,
                side=hedge_side,
                size=hl_qty,
                order_type=OrderType.LIMIT,
                price=hl_limit,
                reduce_only=False,
                time_in_force=OrderTimeInForce.IOC,
            ),
        )
        
        log.info(
            "execution.intent",
            extra={
                "symbol": symbol,
                "lighter_qty": lighter_qty,
                "hl_qty": hl_qty,
                "lighter_price": lighter_limit,
                "hl_price": hl_limit,
                "spread_bps": coords.mid_spread_bps,
            },
        )

        try:
            result: ExecutionResult = await router.execute(intent)
            context.state = BotState.HEDGED
            
            # Record trades for PnL tracking
            lighter_fee = result.primary.filled_size * lighter_limit * 0.0003
            hl_fee = result.hedge.filled_size * hl_limit * 0.0003
            
            pnl_tracker.record_trade(
                symbol=symbol,
                exchange="lighter",
                side=primary_side.value,
                quantity=result.primary.filled_size,
                price=result.primary.average_fill_price or lighter_limit,
                fee=lighter_fee,
                is_entry=True,
            )
            pnl_tracker.record_trade(
                symbol=symbol,
                exchange="hyperliquid",
                side=hedge_side.value,
                quantity=result.hedge.filled_size,
                price=result.hedge.average_fill_price or hl_limit,
                fee=hl_fee,
                is_entry=True,
            )
            
            context.positions[symbol] = {
                "size": decision.size,
                "direction": decision.direction,
                "lighter_filled": result.primary.filled_size,
                "hl_filled": result.hedge.filled_size,
                "lighter_entry_px": result.primary.average_fill_price or lighter_limit,
                "hl_entry_px": result.hedge.average_fill_price or hl_limit,
                "is_balanced": result.is_balanced,
            }
            portfolio.register_position(symbol, decision.size)
            position_store.save(context.positions)
            killswitch.record_success()
            
            log.info(
                "position_opened",
                extra={
                    "symbol": symbol,
                    "lighter_filled": result.primary.filled_size,
                    "hl_filled": result.hedge.filled_size,
                    "balanced": result.is_balanced,
                    "imbalance": result.imbalance,
                },
            )
        except ExecutionError as exc:
            log.error("execution.failed", extra={"symbol": symbol, "leg": exc.leg, "error": str(exc)})
            killswitch.record_failure(f"Execution failed: {exc.leg}")

    async def execute_exit(symbol: str, decision) -> None:
        """Execute exit for a single symbol."""
        if symbol not in context.positions:
            return
        
        context.state = BotState.EXITING
        pos_data = context.positions.pop(symbol)
        stored_direction = pos_data.get("direction") if isinstance(pos_data, dict) else decision.direction
        
        # Fetch current positions to get actual quantities
        lighter_positions = await lighter.get_positions()
        hl_positions = await hyperliquid.get_positions()
        
        lighter_pos = next((p for p in lighter_positions if p.symbol == symbol), None)
        hl_pos = next((p for p in hl_positions if p.symbol == symbol), None)
        
        if not lighter_pos or not hl_pos:
            log.warning("exit_no_positions", extra={"symbol": symbol})
            return
        
        # Get current prices for exit
        try:
            exit_coords = await get_coordinated_prices(symbol, lighter, hyperliquid, max_spread_bps=100)
            lighter_exit_px, hl_exit_px = calculate_limit_prices(
                exit_coords,
                is_buy_primary=(lighter_pos.side == Side.SELL),
                is_buy_hedge=(hl_pos.side == Side.SELL),
                slippage_bps=execution_cfg.slippage_bps * 2,  # More aggressive on exit
            )
        except Exception as e:
            log.error("exit_price_fetch_failed", extra={"symbol": symbol, "error": str(e)})
            # Fallback to market orders if can't get prices
            lighter_exit_px = None
            hl_exit_px = None
        
        # Try limit orders first, with fallback to market
        order_type = OrderType.LIMIT if lighter_exit_px and hl_exit_px else OrderType.MARKET
        
        intent = DualLegIntent(
            leg_a=OrderRequest(
                client_id=f"lighter-exit:{symbol}:{int(time.time())}",
                symbol=symbol,
                side=Side.SELL if lighter_pos.side == Side.BUY else Side.BUY,
                size=lighter_pos.size,
                order_type=order_type,
                price=lighter_exit_px,
                reduce_only=True,
                time_in_force=OrderTimeInForce.IOC,
            ),
            leg_b=OrderRequest(
                client_id=f"hyperliquid-exit:{symbol}:{int(time.time())}",
                symbol=symbol,
                side=Side.SELL if hl_pos.side == Side.BUY else Side.BUY,
                size=hl_pos.size,
                order_type=order_type,
                price=hl_exit_px,
                reduce_only=True,
                time_in_force=OrderTimeInForce.IOC,
            ),
        )
        try:
            exit_result: ExecutionResult = await router.execute(intent)
            context.state = BotState.IDLE
            
            # Record exit trades for PnL
            exit_lighter_fee = exit_result.primary.filled_size * (lighter_exit_px or 0) * 0.0003
            exit_hl_fee = exit_result.hedge.filled_size * (hl_exit_px or 0) * 0.0003
            
            pnl_tracker.record_trade(
                symbol=symbol,
                exchange="lighter",
                side="sell" if lighter_pos.side == Side.BUY else "buy",
                quantity=exit_result.primary.filled_size,
                price=exit_result.primary.average_fill_price or lighter_exit_px or 0,
                fee=exit_lighter_fee,
                is_entry=False,
            )
            pnl_tracker.record_trade(
                symbol=symbol,
                exchange="hyperliquid",
                side="sell" if hl_pos.side == Side.BUY else "buy",
                quantity=exit_result.hedge.filled_size,
                price=exit_result.hedge.average_fill_price or hl_exit_px or 0,
                fee=exit_hl_fee,
                is_entry=False,
            )
            
            portfolio.close_position(symbol)
            position_store.save(context.positions)
            killswitch.record_success()
            
            # Log PnL summary
            total_pnl = pnl_tracker.get_total_pnl()
            log.info(
                "position_closed",
                extra={
                    "symbol": symbol,
                    "lighter_closed": exit_result.primary.filled_size,
                    "hl_closed": exit_result.hedge.filled_size,
                    "total_pnl": total_pnl,
                },
            )
        except ExecutionError as exc:
            log.error("exit.failed", extra={"symbol": symbol, "error": str(exc)})
            killswitch.record_failure(f"Exit failed: {exc}")

        await asyncio.sleep(settings.strategy.rebalance_interval_seconds)


def main() -> None:
    """CLI entry point."""
    app()


if __name__ == "__main__":
    main()


