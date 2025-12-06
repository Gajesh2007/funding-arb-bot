/**
 * Strategy types and interfaces
 */

export interface FundingSnapshot {
  symbol: string;
  /** Hyperliquid 8hr normalized rate */
  hlRate8hr: number;
  /** Lighter 8hr rate (native) */
  lighterRate8hr: number;
  /** Edge in basis points (HL - Lighter) */
  edgeBps: number;
  /** Timestamp */
  timestamp: number;
}

export interface FundingHistory {
  symbol: string;
  /** Recent snapshots (rolling window) */
  snapshots: FundingSnapshot[];
  /** Mean edge over window */
  meanEdgeBps: number;
  /** Standard deviation of edge */
  stdDevBps: number;
  /** Is current rate within normal range? */
  isStable: boolean;
}

export type TradeDirection = "long_lighter_short_hl" | "long_hl_short_lighter";

export interface TradeDecision {
  symbol: string;
  action: "enter" | "exit" | "hold";
  direction: TradeDirection;
  edgeBps: number;
  /** Notional size in USD */
  sizeUsd: number;
  /** Reason for decision */
  reason: string;
}

export interface OpenPosition {
  symbol: string;
  direction: TradeDirection;
  /** Entry edge when position was opened */
  entryEdgeBps: number;
  /** Entry timestamp */
  entryTimestamp: number;
  /** Size on Lighter (positive = long) */
  lighterSize: number;
  /** Size on Hyperliquid (positive = long) */
  hlSize: number;
  /** Entry prices */
  lighterEntryPrice: number;
  hlEntryPrice: number;
  /** Notional value at entry */
  notionalUsd: number;
}

export interface StrategyConfig {
  /** Minimum edge to enter (bps) */
  minEdgeBps: number;
  /** Edge threshold to exit (bps) */
  exitEdgeBps: number;
  /** Standard deviations for spike detection */
  maxStdDevsForEntry: number;
  /** Minimum history samples before trading */
  minHistorySamples: number;
  /** History window in hours */
  historyWindowHours: number;
  /** Max total notional across all positions */
  maxTotalNotionalUsd: number;
  /** Max notional per symbol */
  maxSymbolNotionalUsd: number;
  /** Max number of concurrent positions */
  maxPositions: number;
  /** Drift threshold before rebalancing (bps) */
  driftThresholdBps: number;
  /** Symbols to track */
  symbols: string[];
  /** Order notional size */
  orderNotionalUsd: number;
  /** Max slippage (bps) */
  maxSlippageBps: number;

  // =========================================================================
  // LEVERAGE & MARGIN
  // =========================================================================

  /** Target leverage (e.g., 2 = 2x leverage). Lower = safer, further from liquidation */
  leverage: number;
  /** Maintenance margin rate (e.g., 0.05 = 5%). Used to calculate liquidation distance */
  maintenanceMarginRate: number;

  // =========================================================================
  // RISK LIMITS - Stop-loss & Take-profit
  // =========================================================================

  /** Stop-loss: Max unrealized loss per position in USD (e.g., -50 = exit if losing $50) */
  stopLossUsd: number;
  /** Stop-loss: Max unrealized loss as percentage of notional (e.g., 0.05 = 5%) */
  stopLossPct: number;
  /** Take-profit: Unrealized profit target in USD to lock in gains */
  takeProfitUsd: number;
  /** Take-profit: Unrealized profit as percentage of notional */
  takeProfitPct: number;
  /** Max hold time in hours before forced exit (0 = disabled) */
  maxHoldTimeHours: number;
  /** Max price divergence between exchanges in percentage (e.g., 0.02 = 2%) */
  maxPriceDivergencePct: number;
  /** Max total portfolio drawdown before kill switch (USD) */
  maxDrawdownUsd: number;
  /** Buffer before liquidation to trigger stop-loss (e.g., 0.2 = exit at 20% before liquidation) */
  liquidationBufferPct: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  minEdgeBps: 20,
  exitEdgeBps: 5,
  maxStdDevsForEntry: 2,
  minHistorySamples: 12,
  historyWindowHours: 24,
  maxTotalNotionalUsd: 10000,
  maxSymbolNotionalUsd: 5000,
  maxPositions: 5,
  driftThresholdBps: 25,
  symbols: ["ETH", "BTC", "SOL"],
  orderNotionalUsd: 500,
  maxSlippageBps: 10,

  // Leverage - conservative 2x (50% initial margin)
  leverage: 2,
  maintenanceMarginRate: 0.05, // 5% maintenance margin

  // Risk limits - conservative defaults
  // With 2x leverage: initial margin = 50%, maintenance = 5%
  // Liquidation at ~45% loss on notional
  // Stop-loss at 20% = well before liquidation
  stopLossUsd: 100, // Exit if losing $100 on a position
  stopLossPct: 0.20, // Or 20% of notional (with 2x, this is 40% of margin)
  takeProfitUsd: 150, // Take profit at $150
  takeProfitPct: 0.30, // Or 30% of notional
  maxHoldTimeHours: 48, // Force exit after 48 hours
  maxPriceDivergencePct: 0.02, // Alert/exit if prices differ by 2%
  maxDrawdownUsd: 500, // Kill switch at $500 total drawdown
  liquidationBufferPct: 0.20, // Exit at 20% before liquidation price
};
