/**
 * Strategy Engine
 *
 * Evaluates funding rate opportunities and makes entry/exit decisions.
 * Uses historical funding analysis to avoid entering on spikes.
 */

import type {
  FundingSnapshot,
  TradeDecision,
  TradeDirection,
  OpenPosition,
  StrategyConfig,
} from "./types.js";
import { FundingHistoryTracker } from "./funding-history.js";

export class StrategyEngine {
  private config: StrategyConfig;
  private historyTracker: FundingHistoryTracker;
  private positions: Map<string, OpenPosition> = new Map();

  constructor(config: StrategyConfig) {
    this.config = config;
    this.historyTracker = new FundingHistoryTracker({
      historyWindowHours: config.historyWindowHours,
      minHistorySamples: config.minHistorySamples,
      maxStdDevsForEntry: config.maxStdDevsForEntry,
    });
  }

  /**
   * Record new funding data and evaluate for opportunities
   */
  evaluate(snapshot: FundingSnapshot): TradeDecision {
    // Record in history
    this.historyTracker.record(snapshot);

    const existingPosition = this.positions.get(snapshot.symbol);

    if (existingPosition) {
      return this.evaluateExit(snapshot, existingPosition);
    } else {
      return this.evaluateEntry(snapshot);
    }
  }

  /**
   * Evaluate entry opportunity
   */
  private evaluateEntry(snapshot: FundingSnapshot): TradeDecision {
    const { symbol, edgeBps } = snapshot;
    const absEdge = Math.abs(edgeBps);

    // Determine direction
    const direction: TradeDirection =
      edgeBps > 0 ? "long_lighter_short_hl" : "long_hl_short_lighter";

    // Default hold decision
    const holdDecision: TradeDecision = {
      symbol,
      action: "hold",
      direction,
      edgeBps,
      sizeUsd: 0,
      reason: "",
    };

    // Check 1: Minimum edge threshold
    if (absEdge < this.config.minEdgeBps) {
      return { ...holdDecision, reason: `Edge ${absEdge.toFixed(1)} bps below minimum ${this.config.minEdgeBps} bps` };
    }

    // Check 2: Enough historical data
    if (!this.historyTracker.hasEnoughHistory(symbol)) {
      return { ...holdDecision, reason: "Insufficient funding history - warming up" };
    }

    // Check 3: Not a spike (within normal range)
    if (this.historyTracker.isSpike(symbol, edgeBps)) {
      const history = this.historyTracker.getHistory(symbol);
      return {
        ...holdDecision,
        reason: `Funding spike detected - edge ${edgeBps.toFixed(1)} bps vs mean ${history?.meanEdgeBps.toFixed(1)} bps (σ=${history?.stdDevBps.toFixed(1)})`,
      };
    }

    // Check 4: Not at max positions
    if (this.positions.size >= this.config.maxPositions) {
      return { ...holdDecision, reason: `Max positions (${this.config.maxPositions}) reached` };
    }

    // Check 5: Not exceeding total notional
    const currentNotional = this.getTotalNotional();
    if (currentNotional + this.config.orderNotionalUsd > this.config.maxTotalNotionalUsd) {
      return { ...holdDecision, reason: `Would exceed max total notional $${this.config.maxTotalNotionalUsd}` };
    }

    // Check 6: Trend analysis - prefer entering when edge is stable or increasing
    const trend = this.historyTracker.getEdgeTrend(symbol);
    if (trend === "decreasing") {
      return { ...holdDecision, reason: "Edge trending down - waiting for stability" };
    }

    // All checks passed - recommend entry
    return {
      symbol,
      action: "enter",
      direction,
      edgeBps,
      sizeUsd: this.config.orderNotionalUsd,
      reason: `Edge ${absEdge.toFixed(1)} bps > min ${this.config.minEdgeBps} bps, historically stable`,
    };
  }

  /**
   * Evaluate exit for existing position
   */
  private evaluateExit(snapshot: FundingSnapshot, position: OpenPosition): TradeDecision {
    const { symbol, edgeBps } = snapshot;

    // Exit if edge has collapsed
    const absEdge = Math.abs(edgeBps);
    if (absEdge < this.config.exitEdgeBps) {
      return {
        symbol,
        action: "exit",
        direction: position.direction,
        edgeBps,
        sizeUsd: position.notionalUsd,
        reason: `Edge collapsed to ${absEdge.toFixed(1)} bps < exit threshold ${this.config.exitEdgeBps} bps`,
      };
    }

    // Exit if direction flipped
    const currentDirection: TradeDirection =
      edgeBps > 0 ? "long_lighter_short_hl" : "long_hl_short_lighter";

    if (currentDirection !== position.direction) {
      return {
        symbol,
        action: "exit",
        direction: position.direction,
        edgeBps,
        sizeUsd: position.notionalUsd,
        reason: `Direction flipped from ${position.direction} to ${currentDirection}`,
      };
    }

    // Hold position
    return {
      symbol,
      action: "hold",
      direction: position.direction,
      edgeBps,
      sizeUsd: 0,
      reason: `Holding - edge ${absEdge.toFixed(1)} bps still above exit ${this.config.exitEdgeBps} bps`,
    };
  }

  /**
   * Register a new position (called after successful execution)
   */
  registerPosition(position: OpenPosition): void {
    this.positions.set(position.symbol, position);
  }

  /**
   * Close a position (called after successful exit)
   */
  closePosition(symbol: string): OpenPosition | undefined {
    const position = this.positions.get(symbol);
    this.positions.delete(symbol);
    return position;
  }

  /**
   * Get all open positions
   */
  getPositions(): OpenPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position for a symbol
   */
  getPosition(symbol: string): OpenPosition | undefined {
    return this.positions.get(symbol);
  }

  /**
   * Get total notional across all positions
   */
  getTotalNotional(): number {
    return Array.from(this.positions.values()).reduce((sum, p) => sum + p.notionalUsd, 0);
  }

  /**
   * Get funding history tracker (for external access)
   */
  getHistoryTracker(): FundingHistoryTracker {
    return this.historyTracker;
  }

  /**
   * Get config
   */
  getConfig(): StrategyConfig {
    return this.config;
  }

  /**
   * Export state for persistence
   */
  exportState(): { positions: OpenPosition[]; history: Record<string, FundingSnapshot[]> } {
    return {
      positions: Array.from(this.positions.values()),
      history: this.historyTracker.export(),
    };
  }

  /**
   * Import state from persistence
   */
  importState(state: { positions: OpenPosition[]; history: Record<string, FundingSnapshot[]> }): void {
    this.positions.clear();
    for (const position of state.positions) {
      this.positions.set(position.symbol, position);
    }
    this.historyTracker.import(state.history);
  }
}

