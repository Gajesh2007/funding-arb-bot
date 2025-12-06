/**
 * Trade Executor
 *
 * Handles entry and exit execution for both dry run and live trading.
 */

import type { HyperliquidClient } from "../exchanges/hyperliquid.js";
import type { LighterClient } from "../exchanges/lighter.js";
import { fetchLighterTicker } from "../exchanges/lighter-api.js";
import type { ExecutionRouter } from "../execution/router.js";
import type { RiskManager } from "../execution/risk.js";
import type { StrategyEngine } from "../strategy/engine.js";
import type { StrategyConfig, OpenPosition, TradeDirection } from "../strategy/types.js";
import type { PnLTracker } from "../infra/pnl-tracker.js";

// Fee rates (could be fetched from exchange in the future)
const LIGHTER_FEE_RATE = 0.0003; // 0.03%
const HL_FEE_RATE = 0.00035; // 0.035%

export interface EntryParams {
  symbol: string;
  direction: TradeDirection;
  sizeUsd: number;
  edgeBps: number;
}

export interface ExecutionResult {
  success: boolean;
  message: string;
  position?: OpenPosition;
}

/**
 * Execute a dry run entry (simulated with real prices).
 */
export async function executeDryRunEntry(
  params: EntryParams,
  config: StrategyConfig,
  hlClient: HyperliquidClient,
  engine: StrategyEngine,
  pnlTracker: PnLTracker
): Promise<ExecutionResult> {
  const { symbol, direction, sizeUsd, edgeBps } = params;

  try {
    const [lighterTicker, hlTicker] = await Promise.all([
      fetchLighterTicker(symbol),
      hlClient.getTicker(symbol),
    ]);

    const lighterMid = (lighterTicker.bid + lighterTicker.ask) / 2;
    const hlMid = (hlTicker.bid + hlTicker.ask) / 2;
    const avgPrice = (lighterMid + hlMid) / 2;
    const size = sizeUsd / avgPrice;

    const lighterSide = direction === "long_lighter_short_hl" ? "buy" : "sell";
    const hlSide = direction === "long_lighter_short_hl" ? "sell" : "buy";

    const slippage = config.maxSlippageBps / 10000;
    const lighterFillPrice =
      lighterSide === "buy"
        ? lighterTicker.ask * (1 + slippage)
        : lighterTicker.bid * (1 - slippage);
    const hlFillPrice =
      hlSide === "buy"
        ? hlTicker.ask * (1 + slippage)
        : hlTicker.bid * (1 - slippage);

    const lighterFee = size * lighterFillPrice * LIGHTER_FEE_RATE;
    const hlFee = size * hlFillPrice * HL_FEE_RATE;

    const position: OpenPosition = {
      symbol,
      direction,
      entryEdgeBps: edgeBps,
      entryTimestamp: Date.now(),
      lighterSize: lighterSide === "buy" ? size : -size,
      hlSize: hlSide === "buy" ? size : -size,
      lighterEntryPrice: lighterFillPrice,
      hlEntryPrice: hlFillPrice,
      notionalUsd: sizeUsd,
    };

    engine.registerPosition(position);

    pnlTracker.recordTrade({
      symbol,
      exchange: "lighter",
      side: lighterSide,
      size,
      price: lighterFillPrice,
      fee: lighterFee,
      isEntry: true,
    });
    pnlTracker.recordTrade({
      symbol,
      exchange: "hyperliquid",
      side: hlSide,
      size,
      price: hlFillPrice,
      fee: hlFee,
      isEntry: true,
    });

    const apy = ((Math.abs(edgeBps) * 3 * 365) / 100).toFixed(0);
    return {
      success: true,
      message: `Simulated ENTRY: ${symbol} ${size.toFixed(4)} @ edge ${edgeBps.toFixed(1)} bps (${apy}% APY)`,
      position,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to simulate ${symbol}: ${err}`,
    };
  }
}

/**
 * Execute a live entry.
 */
export async function executeLiveEntry(
  params: EntryParams,
  config: StrategyConfig,
  hlClient: HyperliquidClient,
  lighterClient: LighterClient,
  router: ExecutionRouter,
  engine: StrategyEngine,
  riskManager: RiskManager,
  pnlTracker: PnLTracker
): Promise<ExecutionResult> {
  const { symbol, direction, sizeUsd, edgeBps } = params;

  // Pre-trade risk check
  const riskCheck = await riskManager.checkEntry(
    symbol,
    sizeUsd,
    engine.getTotalNotional(),
    engine.getPositions().length,
    lighterClient,
    hlClient
  );

  if (!riskCheck.approved) {
    return { success: false, message: `Risk check failed: ${riskCheck.reason}` };
  }

  // Execute dual-leg order
  const result = await router.executeEntry({
    symbol,
    direction,
    notionalUsd: sizeUsd,
    maxSlippageBps: config.maxSlippageBps,
  });

  if (result.wasReconciled) {
    console.warn(`  ⚠️ Reconciliation: ${result.reconciliation?.message}`);
  }

  if (!result.success || !result.position) {
    riskManager.recordFailure(`Entry failed for ${symbol}`);
    return {
      success: false,
      message: `Entry failed: Lighter=${result.lighterLeg.error ?? "ok"} HL=${result.hlLeg.error ?? "ok"}`,
    };
  }

  result.position.entryEdgeBps = edgeBps;
  engine.registerPosition(result.position);
  riskManager.recordSuccess();

  // Record trades
  const lighterFee = Math.abs(
    result.lighterLeg.actualSize * result.lighterLeg.actualPrice * LIGHTER_FEE_RATE
  );
  const hlFee = Math.abs(result.hlLeg.actualSize * result.hlLeg.actualPrice * HL_FEE_RATE);

  pnlTracker.recordTrade({
    symbol,
    exchange: "lighter",
    side: result.lighterLeg.side === "buy" ? "buy" : "sell",
    size: Math.abs(result.lighterLeg.actualSize),
    price: result.lighterLeg.actualPrice,
    fee: lighterFee,
    isEntry: true,
  });
  pnlTracker.recordTrade({
    symbol,
    exchange: "hyperliquid",
    side: result.hlLeg.side === "buy" ? "buy" : "sell",
    size: Math.abs(result.hlLeg.actualSize),
    price: result.hlLeg.actualPrice,
    fee: hlFee,
    isEntry: true,
  });

  return {
    success: true,
    message: `Position opened: ${symbol} @ ${edgeBps.toFixed(1)} bps edge`,
    position: result.position,
  };
}

/**
 * Execute a dry run exit.
 */
export async function executeDryRunExit(
  position: OpenPosition,
  config: StrategyConfig,
  hlClient: HyperliquidClient,
  engine: StrategyEngine,
  riskManager: RiskManager,
  pnlTracker: PnLTracker
): Promise<ExecutionResult> {
  const { symbol } = position;

  try {
    const [lighterTicker, hlTicker] = await Promise.all([
      fetchLighterTicker(symbol),
      hlClient.getTicker(symbol),
    ]);

    const lighterExitSide = position.lighterSize > 0 ? "sell" : "buy";
    const hlExitSide = position.hlSize > 0 ? "sell" : "buy";

    const slippage = config.maxSlippageBps / 10000;
    const lighterExitPrice =
      lighterExitSide === "buy"
        ? lighterTicker.ask * (1 + slippage)
        : lighterTicker.bid * (1 - slippage);
    const hlExitPrice =
      hlExitSide === "buy"
        ? hlTicker.ask * (1 + slippage)
        : hlTicker.bid * (1 - slippage);

    const lighterFee = Math.abs(position.lighterSize) * lighterExitPrice * LIGHTER_FEE_RATE;
    const hlFee = Math.abs(position.hlSize) * hlExitPrice * HL_FEE_RATE;

    const pnlCalc = riskManager.calculateExitPnl(
      position,
      lighterExitPrice,
      hlExitPrice,
      lighterFee,
      hlFee
    );

    engine.closePosition(symbol);

    pnlTracker.recordTrade({
      symbol,
      exchange: "lighter",
      side: lighterExitSide,
      size: Math.abs(position.lighterSize),
      price: lighterExitPrice,
      fee: lighterFee,
      isEntry: false,
      positionPnl: pnlCalc.netPnl,
    });

    return {
      success: true,
      message: `Simulated EXIT: ${symbol} | Net PnL: $${pnlCalc.netPnl.toFixed(2)} (Fees: $${pnlCalc.feesTotal.toFixed(2)})`,
    };
  } catch (err) {
    return { success: false, message: `Failed to simulate exit for ${symbol}: ${err}` };
  }
}

/**
 * Execute a live exit.
 */
export async function executeLiveExit(
  position: OpenPosition,
  router: ExecutionRouter,
  engine: StrategyEngine,
  riskManager: RiskManager,
  pnlTracker: PnLTracker
): Promise<ExecutionResult> {
  const { symbol } = position;

  const result = await router.executeExit(position);

  if (result.wasReconciled) {
    console.warn(`  ⚠️ Reconciliation: ${result.reconciliation?.message}`);
  }

  if (!result.success) {
    riskManager.recordFailure(`Exit failed for ${symbol}`);
    return { success: false, message: `Exit failed - MANUAL INTERVENTION REQUIRED` };
  }

  const lighterFee = Math.abs(
    result.lighterLeg.actualSize * result.lighterLeg.actualPrice * LIGHTER_FEE_RATE
  );
  const hlFee = Math.abs(result.hlLeg.actualSize * result.hlLeg.actualPrice * HL_FEE_RATE);

  const pnlCalc = riskManager.calculateExitPnl(
    position,
    result.lighterLeg.actualPrice,
    result.hlLeg.actualPrice,
    lighterFee,
    hlFee
  );

  engine.closePosition(symbol);
  riskManager.recordSuccess();

  pnlTracker.recordTrade({
    symbol,
    exchange: "lighter",
    side: result.lighterLeg.side === "buy" ? "buy" : "sell",
    size: Math.abs(result.lighterLeg.actualSize),
    price: result.lighterLeg.actualPrice,
    fee: lighterFee,
    isEntry: false,
    positionPnl: pnlCalc.netPnl,
  });
  pnlTracker.recordTrade({
    symbol,
    exchange: "hyperliquid",
    side: result.hlLeg.side === "buy" ? "buy" : "sell",
    size: Math.abs(result.hlLeg.actualSize),
    price: result.hlLeg.actualPrice,
    fee: hlFee,
    isEntry: false,
  });

  return {
    success: true,
    message: `Position closed: ${symbol} | Net PnL: $${pnlCalc.netPnl.toFixed(2)}`,
  };
}

