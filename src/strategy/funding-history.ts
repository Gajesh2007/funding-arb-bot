/**
 * Historical funding rate analyzer
 *
 * Tracks funding rates over time to detect spikes and ensure we only
 * enter positions when rates are sustainable (not anomalous).
 */

import type { FundingSnapshot, FundingHistory, StrategyConfig } from "./types.js";

export class FundingHistoryTracker {
  private history: Map<string, FundingSnapshot[]> = new Map();
  private windowMs: number;
  private minSamples: number;
  private maxStdDevs: number;

  constructor(config: Pick<StrategyConfig, "historyWindowHours" | "minHistorySamples" | "maxStdDevsForEntry">) {
    this.windowMs = config.historyWindowHours * 60 * 60 * 1000;
    this.minSamples = config.minHistorySamples;
    this.maxStdDevs = config.maxStdDevsForEntry;
  }

  /**
   * Record a new funding snapshot
   */
  record(snapshot: FundingSnapshot): void {
    const existing = this.history.get(snapshot.symbol) ?? [];
    existing.push(snapshot);

    // Prune old entries outside window
    const cutoff = Date.now() - this.windowMs;
    const pruned = existing.filter((s) => s.timestamp > cutoff);

    this.history.set(snapshot.symbol, pruned);
  }

  /**
   * Record multiple snapshots at once
   */
  recordBatch(snapshots: FundingSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.record(snapshot);
    }
  }

  /**
   * Get funding history analysis for a symbol
   */
  getHistory(symbol: string): FundingHistory | null {
    const snapshots = this.history.get(symbol);
    if (!snapshots || snapshots.length === 0) {
      return null;
    }

    const edges = snapshots.map((s) => s.edgeBps);
    const { mean, stdDev } = this.calculateStats(edges);
    const currentEdge = snapshots[snapshots.length - 1].edgeBps;

    // Check if current edge is within normal range
    const deviationsFromMean = stdDev > 0 ? Math.abs(currentEdge - mean) / stdDev : 0;
    const isStable = deviationsFromMean <= this.maxStdDevs;

    return {
      symbol,
      snapshots,
      meanEdgeBps: mean,
      stdDevBps: stdDev,
      isStable,
    };
  }

  /**
   * Check if we have enough history to make trading decisions
   */
  hasEnoughHistory(symbol: string): boolean {
    const snapshots = this.history.get(symbol);
    return !!snapshots && snapshots.length >= this.minSamples;
  }

  /**
   * Check if current funding rate is a spike (anomalous)
   */
  isSpike(symbol: string, currentEdgeBps: number): boolean {
    const history = this.getHistory(symbol);
    if (!history) return true; // No history = treat as spike (be conservative)

    if (history.snapshots.length < this.minSamples) {
      return true; // Not enough data = treat as spike
    }

    const { meanEdgeBps, stdDevBps } = history;
    if (stdDevBps === 0) return false; // No variance = not a spike

    const deviations = Math.abs(currentEdgeBps - meanEdgeBps) / stdDevBps;
    return deviations > this.maxStdDevs;
  }

  /**
   * Get the mean edge for a symbol
   */
  getMeanEdge(symbol: string): number | null {
    const history = this.getHistory(symbol);
    return history?.meanEdgeBps ?? null;
  }

  /**
   * Get recent edge trend (is it increasing or decreasing?)
   */
  getEdgeTrend(symbol: string, lookbackSamples: number = 6): "increasing" | "decreasing" | "stable" | null {
    const snapshots = this.history.get(symbol);
    if (!snapshots || snapshots.length < lookbackSamples) return null;

    const recent = snapshots.slice(-lookbackSamples);
    const firstHalf = recent.slice(0, Math.floor(lookbackSamples / 2));
    const secondHalf = recent.slice(Math.floor(lookbackSamples / 2));

    const firstAvg = this.average(firstHalf.map((s) => s.edgeBps));
    const secondAvg = this.average(secondHalf.map((s) => s.edgeBps));

    const diff = secondAvg - firstAvg;
    const threshold = 2; // 2 bps threshold for trend detection

    if (diff > threshold) return "increasing";
    if (diff < -threshold) return "decreasing";
    return "stable";
  }

  /**
   * Clear history for a symbol (e.g., after closing position)
   */
  clear(symbol: string): void {
    this.history.delete(symbol);
  }

  /**
   * Clear all history
   */
  clearAll(): void {
    this.history.clear();
  }

  /**
   * Export history for persistence
   */
  export(): Record<string, FundingSnapshot[]> {
    const result: Record<string, FundingSnapshot[]> = {};
    for (const [symbol, snapshots] of this.history) {
      result[symbol] = snapshots;
    }
    return result;
  }

  /**
   * Import history from persistence
   */
  import(data: Record<string, FundingSnapshot[]>): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [symbol, snapshots] of Object.entries(data)) {
      const pruned = snapshots.filter((s) => s.timestamp > cutoff);
      if (pruned.length > 0) {
        this.history.set(symbol, pruned);
      }
    }
  }

  private calculateStats(values: number[]): { mean: number; stdDev: number } {
    if (values.length === 0) return { mean: 0, stdDev: 0 };

    const mean = this.average(values);
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    const variance = this.average(squaredDiffs);
    const stdDev = Math.sqrt(variance);

    return { mean, stdDev };
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

