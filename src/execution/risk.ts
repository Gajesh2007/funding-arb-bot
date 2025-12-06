/**
 * Risk Management
 *
 * Handles position limits, margin checks, stop-loss, take-profit,
 * drift detection, and kill switch functionality.
 */

import type { HyperliquidClient } from "../exchanges/hyperliquid.js";
import type { LighterClient } from "../exchanges/lighter.js";
import type { OpenPosition, StrategyConfig } from "../strategy/types.js";

export interface RiskCheck {
  approved: boolean;
  reason: string;
  details?: {
    lighterFreeMargin?: number;
    hlFreeMargin?: number;
    requiredMargin?: number;
  };
}

export interface DriftInfo {
  symbol: string;
  lighterSize: number;
  hlSize: number;
  expectedLighterSize: number;
  expectedHlSize: number;
  driftBps: number;
  needsRebalance: boolean;
}

export interface MarginStatus {
  lighter: { balance: number; marginUsed: number; freeMargin: number };
  hyperliquid: { balance: number; marginUsed: number; freeMargin: number };
  totalFreeMargin: number;
}

// ============================================================================
// Position Risk Types
// ============================================================================

export interface UnrealizedPnL {
  symbol: string;
  lighterPnl: number;
  hlPnl: number;
  totalPnl: number;
  pnlPct: number; // As percentage of notional
  lighterPrice: number;
  hlPrice: number;
  priceDivergencePct: number;
  // Liquidation info per leg
  lighterLiqDistance: number; // % distance to liquidation (1.0 = at liq, 0 = safe)
  hlLiqDistance: number;
}

export interface PositionRisk {
  position: OpenPosition;
  unrealizedPnl: UnrealizedPnL;
  holdTimeHours: number;
  shouldExit: boolean;
  exitReason: string | null;
}

export type ExitTrigger =
  | "stop_loss_usd"
  | "stop_loss_pct"
  | "take_profit_usd"
  | "take_profit_pct"
  | "max_hold_time"
  | "price_divergence"
  | "none";

// ============================================================================
// Risk Manager
// ============================================================================

export class RiskManager {
  private config: StrategyConfig;
  private consecutiveFailures: number = 0;
  private totalFailuresThisHour: number = 0;
  private failureResetTime: number = Date.now();
  private isKilled: boolean = false;
  private killReason: string = "";
  private totalRealizedPnl: number = 0;

  private readonly maxConsecutiveFailures = 3;
  private readonly maxFailuresPerHour = 10;
  private readonly marginSafetyFactor = 2.0;

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  // ==========================================================================
  // Unrealized PnL Calculation
  // ==========================================================================

  /**
   * Calculate unrealized PnL for a position given current prices.
   */
  calculateUnrealizedPnl(
    position: OpenPosition,
    lighterPrice: number,
    hlPrice: number
  ): UnrealizedPnL {
    // PnL for each leg: size * (current_price - entry_price)
    // Sizes are signed (positive = long, negative = short)
    const lighterPnl = position.lighterSize * (lighterPrice - position.lighterEntryPrice);
    const hlPnl = position.hlSize * (hlPrice - position.hlEntryPrice);
    const totalPnl = lighterPnl + hlPnl;
    const pnlPct = position.notionalUsd > 0 ? totalPnl / position.notionalUsd : 0;

    // Price divergence: how much prices differ between exchanges
    const avgPrice = (lighterPrice + hlPrice) / 2;
    const priceDivergencePct = avgPrice > 0 ? Math.abs(lighterPrice - hlPrice) / avgPrice : 0;

    // Calculate distance to liquidation for each leg
    // Liquidation occurs when: loss >= initial_margin - maintenance_margin
    // initial_margin = notional / leverage
    // max_loss_before_liq = notional * (1/leverage - maintenance_rate)
    const initialMarginRate = 1 / this.config.leverage;
    const maxLossRate = initialMarginRate - this.config.maintenanceMarginRate;
    
    // Per-leg notional (half of total for delta-neutral)
    const perLegNotional = position.notionalUsd / 2;
    const maxLossPerLeg = perLegNotional * maxLossRate;

    // Distance to liquidation: current_loss / max_loss (1.0 = liquidated, 0 = no loss)
    const lighterLiqDistance = maxLossPerLeg > 0 ? Math.max(0, -lighterPnl / maxLossPerLeg) : 0;
    const hlLiqDistance = maxLossPerLeg > 0 ? Math.max(0, -hlPnl / maxLossPerLeg) : 0;

    return {
      symbol: position.symbol,
      lighterPnl,
      hlPnl,
      totalPnl,
      pnlPct,
      lighterPrice,
      hlPrice,
      priceDivergencePct,
      lighterLiqDistance,
      hlLiqDistance,
    };
  }

  /**
   * Check if a position should be exited based on risk limits.
   */
  checkPositionRisk(position: OpenPosition, unrealizedPnl: UnrealizedPnL): PositionRisk {
    const holdTimeHours = (Date.now() - position.entryTimestamp) / (1000 * 60 * 60);
    let shouldExit = false;
    let exitReason: string | null = null;

    // Check stop-loss (USD)
    if (unrealizedPnl.totalPnl <= -this.config.stopLossUsd) {
      shouldExit = true;
      exitReason = `Stop-loss triggered: $${unrealizedPnl.totalPnl.toFixed(2)} <= -$${this.config.stopLossUsd}`;
    }

    // Check stop-loss (percentage)
    if (!shouldExit && unrealizedPnl.pnlPct <= -this.config.stopLossPct) {
      shouldExit = true;
      exitReason = `Stop-loss triggered: ${(unrealizedPnl.pnlPct * 100).toFixed(1)}% <= -${(this.config.stopLossPct * 100).toFixed(1)}%`;
    }

    // Check take-profit (USD)
    if (!shouldExit && unrealizedPnl.totalPnl >= this.config.takeProfitUsd) {
      shouldExit = true;
      exitReason = `Take-profit triggered: $${unrealizedPnl.totalPnl.toFixed(2)} >= $${this.config.takeProfitUsd}`;
    }

    // Check take-profit (percentage)
    if (!shouldExit && unrealizedPnl.pnlPct >= this.config.takeProfitPct) {
      shouldExit = true;
      exitReason = `Take-profit triggered: ${(unrealizedPnl.pnlPct * 100).toFixed(1)}% >= ${(this.config.takeProfitPct * 100).toFixed(1)}%`;
    }

    // Check max hold time
    if (!shouldExit && this.config.maxHoldTimeHours > 0 && holdTimeHours >= this.config.maxHoldTimeHours) {
      shouldExit = true;
      exitReason = `Max hold time exceeded: ${holdTimeHours.toFixed(1)}h >= ${this.config.maxHoldTimeHours}h`;
    }

    // Check price divergence
    if (!shouldExit && unrealizedPnl.priceDivergencePct >= this.config.maxPriceDivergencePct) {
      shouldExit = true;
      exitReason = `Price divergence: ${(unrealizedPnl.priceDivergencePct * 100).toFixed(2)}% >= ${(this.config.maxPriceDivergencePct * 100).toFixed(1)}%`;
    }

    // Check liquidation proximity (CRITICAL - prevents actual liquidation)
    // Exit when either leg is within buffer of liquidation
    const liqThreshold = 1 - this.config.liquidationBufferPct; // e.g., 0.8 = exit at 80% towards liq
    if (!shouldExit && unrealizedPnl.lighterLiqDistance >= liqThreshold) {
      shouldExit = true;
      exitReason = `Lighter leg approaching liquidation: ${(unrealizedPnl.lighterLiqDistance * 100).toFixed(1)}% (buffer: ${(this.config.liquidationBufferPct * 100).toFixed(0)}%)`;
    }
    if (!shouldExit && unrealizedPnl.hlLiqDistance >= liqThreshold) {
      shouldExit = true;
      exitReason = `HL leg approaching liquidation: ${(unrealizedPnl.hlLiqDistance * 100).toFixed(1)}% (buffer: ${(this.config.liquidationBufferPct * 100).toFixed(0)}%)`;
    }

    return {
      position,
      unrealizedPnl,
      holdTimeHours,
      shouldExit,
      exitReason,
    };
  }

  /**
   * Check all positions for risk triggers.
   * Returns positions that should be exited.
   */
  async checkAllPositionRisks(
    positions: OpenPosition[],
    lighter: LighterClient,
    hyperliquid: HyperliquidClient
  ): Promise<PositionRisk[]> {
    const risks: PositionRisk[] = [];

    for (const position of positions) {
      try {
        // Fetch current prices
        const [lighterTicker, hlTicker] = await Promise.all([
          lighter.getTicker(position.symbol),
          hyperliquid.getTicker(position.symbol),
        ]);

        const lighterMid = (lighterTicker.bid + lighterTicker.ask) / 2;
        const hlMid = (hlTicker.bid + hlTicker.ask) / 2;

        const unrealizedPnl = this.calculateUnrealizedPnl(position, lighterMid, hlMid);
        const risk = this.checkPositionRisk(position, unrealizedPnl);
        risks.push(risk);
      } catch (error) {
        // If we can't get prices, mark for exit (fail-safe)
        risks.push({
          position,
          unrealizedPnl: {
            symbol: position.symbol,
            lighterPnl: 0,
            hlPnl: 0,
            totalPnl: 0,
            pnlPct: 0,
            lighterPrice: 0,
            hlPrice: 0,
            priceDivergencePct: 1, // Assume max divergence
            lighterLiqDistance: 1, // Assume at liquidation
            hlLiqDistance: 1,
          },
          holdTimeHours: (Date.now() - position.entryTimestamp) / (1000 * 60 * 60),
          shouldExit: true,
          exitReason: `Failed to fetch prices: ${error}`,
        });
      }
    }

    return risks;
  }

  /**
   * Update total realized PnL and check drawdown limit.
   */
  recordRealizedPnl(pnl: number): void {
    this.totalRealizedPnl += pnl;

    // Check drawdown kill switch
    if (this.totalRealizedPnl <= -this.config.maxDrawdownUsd) {
      this.tripKillSwitch(
        `Max drawdown exceeded: $${this.totalRealizedPnl.toFixed(2)} <= -$${this.config.maxDrawdownUsd}`
      );
    }
  }

  getTotalRealizedPnl(): number {
    return this.totalRealizedPnl;
  }

  // ==========================================================================
  // Margin & Entry Checks
  // ==========================================================================

  async getMarginStatus(lighter: LighterClient, hyperliquid: HyperliquidClient): Promise<MarginStatus> {
    const [lighterInfo, hlInfo] = await Promise.all([
      lighter.getAccountInfo(),
      hyperliquid.getAccountInfo(),
    ]);

    return {
      lighter: {
        balance: lighterInfo.balance,
        marginUsed: lighterInfo.marginUsed,
        freeMargin: lighterInfo.freeMargin,
      },
      hyperliquid: {
        balance: hlInfo.balance,
        marginUsed: hlInfo.marginUsed,
        freeMargin: hlInfo.freeMargin,
      },
      totalFreeMargin: lighterInfo.freeMargin + hlInfo.freeMargin,
    };
  }

  async checkEntry(
    symbol: string,
    notionalUsd: number,
    currentTotalNotional: number,
    currentPositionCount: number,
    lighter: LighterClient,
    hyperliquid: HyperliquidClient
  ): Promise<RiskCheck> {
    if (this.isKilled) {
      return { approved: false, reason: `Kill switch tripped: ${this.killReason}` };
    }

    if (currentPositionCount >= this.config.maxPositions) {
      return { approved: false, reason: `Max positions (${this.config.maxPositions}) reached` };
    }

    if (notionalUsd > this.config.maxSymbolNotionalUsd) {
      return {
        approved: false,
        reason: `Notional $${notionalUsd} exceeds per-symbol max $${this.config.maxSymbolNotionalUsd}`,
      };
    }

    if (currentTotalNotional + notionalUsd > this.config.maxTotalNotionalUsd) {
      return {
        approved: false,
        reason: `Would exceed max total notional $${this.config.maxTotalNotionalUsd}`,
      };
    }

    try {
      const marginStatus = await this.getMarginStatus(lighter, hyperliquid);
      // Required margin = notional / leverage, with safety factor
      const requiredMarginPerSide = (notionalUsd / this.config.leverage) * this.marginSafetyFactor;

      if (marginStatus.lighter.freeMargin < requiredMarginPerSide) {
        return {
          approved: false,
          reason: `Insufficient Lighter margin: $${marginStatus.lighter.freeMargin.toFixed(2)} < required $${requiredMarginPerSide.toFixed(2)}`,
          details: { lighterFreeMargin: marginStatus.lighter.freeMargin, requiredMargin: requiredMarginPerSide },
        };
      }

      if (marginStatus.hyperliquid.freeMargin < requiredMarginPerSide) {
        return {
          approved: false,
          reason: `Insufficient HL margin: $${marginStatus.hyperliquid.freeMargin.toFixed(2)} < required $${requiredMarginPerSide.toFixed(2)}`,
          details: { hlFreeMargin: marginStatus.hyperliquid.freeMargin, requiredMargin: requiredMarginPerSide },
        };
      }

      return {
        approved: true,
        reason: "All checks passed",
        details: {
          lighterFreeMargin: marginStatus.lighter.freeMargin,
          hlFreeMargin: marginStatus.hyperliquid.freeMargin,
          requiredMargin: requiredMarginPerSide,
        },
      };
    } catch (error) {
      return {
        approved: false,
        reason: `Failed to verify exchange state: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ==========================================================================
  // Drift Detection
  // ==========================================================================

  async detectDrift(
    position: OpenPosition,
    lighter: LighterClient,
    hyperliquid: HyperliquidClient
  ): Promise<DriftInfo> {
    const { symbol, lighterSize, hlSize } = position;

    const [lighterPositions, hlPositions] = await Promise.all([
      lighter.getPositions(),
      hyperliquid.getPositions(),
    ]);

    const lighterPos = lighterPositions.find((p) => p.symbol === symbol);
    const hlPos = hlPositions.find((p) => p.symbol === symbol);

    const actualLighterSize = lighterPos ? (lighterPos.side === "buy" ? 1 : -1) * lighterPos.size : 0;
    const actualHlSize = hlPos ? (hlPos.side === "buy" ? 1 : -1) * hlPos.size : 0;

    const lighterDrift = Math.abs(actualLighterSize - lighterSize);
    const hlDrift = Math.abs(actualHlSize - hlSize);

    const expectedNotional =
      Math.abs(lighterSize) * (lighterPos?.entryPrice ?? position.lighterEntryPrice) +
      Math.abs(hlSize) * (hlPos?.entryPrice ?? position.hlEntryPrice);

    const driftNotional =
      lighterDrift * (lighterPos?.entryPrice ?? position.lighterEntryPrice) +
      hlDrift * (hlPos?.entryPrice ?? position.hlEntryPrice);

    const driftBps = expectedNotional > 0 ? (driftNotional / expectedNotional) * 10000 : 0;

    return {
      symbol,
      lighterSize: actualLighterSize,
      hlSize: actualHlSize,
      expectedLighterSize: lighterSize,
      expectedHlSize: hlSize,
      driftBps,
      needsRebalance: driftBps > this.config.driftThresholdBps,
    };
  }

  async checkAllDrift(
    positions: OpenPosition[],
    lighter: LighterClient,
    hyperliquid: HyperliquidClient
  ): Promise<DriftInfo[]> {
    const driftInfos: DriftInfo[] = [];
    for (const position of positions) {
      const drift = await this.detectDrift(position, lighter, hyperliquid);
      driftInfos.push(drift);
    }
    return driftInfos;
  }

  // ==========================================================================
  // Exit PnL Calculation
  // ==========================================================================

  calculateExitPnl(
    position: OpenPosition,
    lighterExitPrice: number,
    hlExitPrice: number,
    lighterFee: number,
    hlFee: number
  ): {
    lighterPnl: number;
    hlPnl: number;
    totalPnl: number;
    feesTotal: number;
    netPnl: number;
  } {
    const lighterPnl = position.lighterSize * (lighterExitPrice - position.lighterEntryPrice);
    const hlPnl = position.hlSize * (hlExitPrice - position.hlEntryPrice);
    const totalPnl = lighterPnl + hlPnl;
    const feesTotal = lighterFee + hlFee;
    const netPnl = totalPnl - feesTotal;

    return { lighterPnl, hlPnl, totalPnl, feesTotal, netPnl };
  }

  // ==========================================================================
  // Failure Tracking & Kill Switch
  // ==========================================================================

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(reason: string): void {
    this.consecutiveFailures++;
    this.totalFailuresThisHour++;

    if (Date.now() - this.failureResetTime > 60 * 60 * 1000) {
      this.totalFailuresThisHour = 1;
      this.failureResetTime = Date.now();
    }

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.tripKillSwitch(`${this.maxConsecutiveFailures} consecutive failures: ${reason}`);
    }

    if (this.totalFailuresThisHour >= this.maxFailuresPerHour) {
      this.tripKillSwitch(`${this.maxFailuresPerHour} failures in the past hour`);
    }
  }

  tripKillSwitch(reason: string): void {
    this.isKilled = true;
    this.killReason = reason;
  }

  resetKillSwitch(): void {
    this.isKilled = false;
    this.killReason = "";
    this.consecutiveFailures = 0;
    this.totalFailuresThisHour = 0;
    this.failureResetTime = Date.now();
  }

  isTripped(): boolean {
    return this.isKilled;
  }

  getKillReason(): string {
    return this.killReason;
  }

  getStats(): {
    consecutiveFailures: number;
    totalFailuresThisHour: number;
    isKilled: boolean;
    killReason: string;
    totalRealizedPnl: number;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      totalFailuresThisHour: this.totalFailuresThisHour,
      isKilled: this.isKilled,
      killReason: this.killReason,
      totalRealizedPnl: this.totalRealizedPnl,
    };
  }
}
