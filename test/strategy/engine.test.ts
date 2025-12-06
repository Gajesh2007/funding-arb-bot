import { describe, it, expect, beforeEach } from "vitest";
import { StrategyEngine } from "../../src/strategy/engine.js";
import type { StrategyConfig, FundingSnapshot, OpenPosition } from "../../src/strategy/types.js";

describe("StrategyEngine", () => {
  let engine: StrategyEngine;
  let config: StrategyConfig;

  beforeEach(() => {
    config = {
      minEdgeBps: 20,
      exitEdgeBps: 5,
      maxStdDevsForEntry: 2,
      minHistorySamples: 3, // Low for testing
      historyWindowHours: 24,
      maxTotalNotionalUsd: 10000,
      maxSymbolNotionalUsd: 5000,
      maxPositions: 3,
      driftThresholdBps: 25,
      symbols: ["ETH", "BTC"],
      orderNotionalUsd: 500,
      maxSlippageBps: 10,
      leverage: 2,
      maintenanceMarginRate: 0.05,
      stopLossUsd: 100,
      stopLossPct: 0.2,
      takeProfitUsd: 150,
      takeProfitPct: 0.3,
      maxHoldTimeHours: 48,
      maxPriceDivergencePct: 0.02,
      maxDrawdownUsd: 500,
      liquidationBufferPct: 0.2,
    };
    engine = new StrategyEngine(config);
  });

  describe("entry decisions", () => {
    it("holds when edge is below minimum", () => {
      warmup(engine, "ETH", 10);

      const decision = engine.evaluate(makeSnapshot("ETH", 10));
      expect(decision.action).toBe("hold");
      expect(decision.reason).toContain("below minimum");
    });

    it("holds during warmup period", () => {
      const decision = engine.evaluate(makeSnapshot("ETH", 50));
      expect(decision.action).toBe("hold");
      expect(decision.reason).toContain("warming up");
    });

    it("holds when funding is spiking", () => {
      // Build stable history around 20 bps
      warmup(engine, "ETH", 20);

      // Now try to enter at 200 bps - should be detected as spike
      const decision = engine.evaluate(makeSnapshot("ETH", 200));
      expect(decision.action).toBe("hold");
      expect(decision.reason).toContain("spike");
    });

    it("recommends entry when edge is sufficient and stable", () => {
      // Build stable history at 25 bps
      warmup(engine, "ETH", 25);

      // Continue at same level - should enter
      const decision = engine.evaluate(makeSnapshot("ETH", 25));
      expect(decision.action).toBe("enter");
      expect(decision.direction).toBe("long_lighter_short_hl");
    });

    it("determines correct direction based on edge sign", () => {
      warmup(engine, "ETH", 25);
      const positiveEdge = engine.evaluate(makeSnapshot("ETH", 25));
      expect(positiveEdge.direction).toBe("long_lighter_short_hl");

      // Reset and test negative edge
      engine = new StrategyEngine(config);
      warmup(engine, "BTC", -25);
      const negativeEdge = engine.evaluate(makeSnapshot("BTC", -25));
      expect(negativeEdge.direction).toBe("long_hl_short_lighter");
    });

    it("respects max positions limit", () => {
      // Fill up positions
      warmup(engine, "ETH", 25);
      const ethDecision = engine.evaluate(makeSnapshot("ETH", 25));
      expect(ethDecision.action).toBe("enter");
      registerMockPosition(engine, "ETH");

      warmup(engine, "BTC", 25);
      const btcDecision = engine.evaluate(makeSnapshot("BTC", 25));
      expect(btcDecision.action).toBe("enter");
      registerMockPosition(engine, "BTC");

      warmup(engine, "SOL", 25);
      const solDecision = engine.evaluate(makeSnapshot("SOL", 25));
      expect(solDecision.action).toBe("enter");
      registerMockPosition(engine, "SOL");

      // 4th position should be blocked
      warmup(engine, "DOGE", 25);
      const dogeDecision = engine.evaluate(makeSnapshot("DOGE", 25));
      expect(dogeDecision.action).toBe("hold");
      expect(dogeDecision.reason).toContain("Max positions");
    });
  });

  describe("exit decisions", () => {
    it("recommends exit when edge collapses", () => {
      warmup(engine, "ETH", 25);
      engine.evaluate(makeSnapshot("ETH", 25)); // Should enter
      registerMockPosition(engine, "ETH", 25);

      // Edge collapses to 3 bps (below exit threshold of 5)
      const exitDecision = engine.evaluate(makeSnapshot("ETH", 3));
      expect(exitDecision.action).toBe("exit");
      expect(exitDecision.reason).toContain("collapsed");
    });

    it("recommends exit when direction flips", () => {
      warmup(engine, "ETH", 25);
      engine.evaluate(makeSnapshot("ETH", 25));
      registerMockPosition(engine, "ETH", 25);

      // Edge flips negative
      const exitDecision = engine.evaluate(makeSnapshot("ETH", -25));
      expect(exitDecision.action).toBe("exit");
      expect(exitDecision.reason).toContain("flipped");
    });

    it("holds when edge is still favorable", () => {
      warmup(engine, "ETH", 25);
      engine.evaluate(makeSnapshot("ETH", 25));
      registerMockPosition(engine, "ETH", 25);

      // Edge drops but still above exit threshold
      const holdDecision = engine.evaluate(makeSnapshot("ETH", 15));
      expect(holdDecision.action).toBe("hold");
    });
  });

  describe("position management", () => {
    it("tracks registered positions", () => {
      const position: OpenPosition = {
        symbol: "ETH",
        direction: "long_lighter_short_hl",
        entryEdgeBps: 25,
        entryTimestamp: Date.now(),
        lighterSize: 0.1,
        hlSize: -0.1,
        lighterEntryPrice: 4000,
        hlEntryPrice: 4000,
        notionalUsd: 400,
      };

      engine.registerPosition(position);
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getPosition("ETH")).toEqual(position);
    });

    it("calculates total notional correctly", () => {
      registerMockPosition(engine, "ETH", 25, 500);
      registerMockPosition(engine, "BTC", 25, 1000);

      expect(engine.getTotalNotional()).toBe(1500);
    });

    it("removes positions on close", () => {
      registerMockPosition(engine, "ETH", 25);
      expect(engine.getPositions()).toHaveLength(1);

      engine.closePosition("ETH");
      expect(engine.getPositions()).toHaveLength(0);
    });
  });

  describe("state persistence", () => {
    it("exports and imports state correctly", () => {
      warmup(engine, "ETH", 20);
      registerMockPosition(engine, "ETH", 20);

      const state = engine.exportState();
      expect(state.positions).toHaveLength(1);
      expect(Object.keys(state.history)).toContain("ETH");

      // Create new engine and import
      const newEngine = new StrategyEngine(config);
      newEngine.importState(state);

      expect(newEngine.getPositions()).toHaveLength(1);
      expect(newEngine.getHistoryTracker().hasEnoughHistory("ETH")).toBe(true);
    });
  });
});

function warmup(engine: StrategyEngine, symbol: string, edgeBps: number): void {
  // Add enough samples to pass warmup
  for (let i = 0; i < 5; i++) {
    engine.evaluate(makeSnapshot(symbol, edgeBps, Date.now() - (5 - i) * 60000));
  }
}

function makeSnapshot(symbol: string, edgeBps: number, timestamp?: number): FundingSnapshot {
  return {
    symbol,
    hlRate8hr: edgeBps > 0 ? edgeBps / 10000 : 0,
    lighterRate8hr: edgeBps < 0 ? Math.abs(edgeBps) / 10000 : 0,
    edgeBps,
    timestamp: timestamp ?? Date.now(),
  };
}

function registerMockPosition(
  engine: StrategyEngine,
  symbol: string,
  edgeBps: number = 25,
  notionalUsd: number = 500
): void {
  engine.registerPosition({
    symbol,
    direction: edgeBps > 0 ? "long_lighter_short_hl" : "long_hl_short_lighter",
    entryEdgeBps: edgeBps,
    entryTimestamp: Date.now(),
    lighterSize: 0.1,
    hlSize: -0.1,
    lighterEntryPrice: 4000,
    hlEntryPrice: 4000,
    notionalUsd,
  });
}

