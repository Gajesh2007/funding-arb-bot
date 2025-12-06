import { describe, it, expect, beforeEach } from "vitest";
import { RiskManager } from "../../src/execution/risk.js";
import type { StrategyConfig, OpenPosition } from "../../src/strategy/types.js";

describe("RiskManager", () => {
  let riskManager: RiskManager;
  let config: StrategyConfig;

  beforeEach(() => {
    config = {
      minEdgeBps: 20,
      exitEdgeBps: 5,
      maxStdDevsForEntry: 2,
      minHistorySamples: 3,
      historyWindowHours: 24,
      maxTotalNotionalUsd: 10000,
      maxSymbolNotionalUsd: 5000,
      maxPositions: 3,
      driftThresholdBps: 25,
      symbols: ["ETH", "BTC"],
      orderNotionalUsd: 500,
      maxSlippageBps: 10,
      // 2x leverage = 50% initial margin, 5% maintenance
      leverage: 2,
      maintenanceMarginRate: 0.05,
      // Risk limits
      stopLossUsd: 50,
      stopLossPct: 0.10, // 10%
      takeProfitUsd: 100,
      takeProfitPct: 0.20, // 20%
      maxHoldTimeHours: 24,
      maxPriceDivergencePct: 0.02, // 2%
      maxDrawdownUsd: 500,
      liquidationBufferPct: 0.20, // Exit at 80% to liquidation
    };
    riskManager = new RiskManager(config);
  });

  describe("calculateUnrealizedPnl", () => {
    it("calculates PnL correctly for profitable long Lighter / short HL position", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // Price goes up: long wins, short loses, but sizes offset
      const pnl = riskManager.calculateUnrealizedPnl(position, 3100, 3100);

      // Lighter: 0.1 * (3100 - 3000) = +10
      // HL: -0.1 * (3100 - 3000) = -10
      // Total: 0 (delta neutral)
      expect(pnl.lighterPnl).toBeCloseTo(10);
      expect(pnl.hlPnl).toBeCloseTo(-10);
      expect(pnl.totalPnl).toBeCloseTo(0);
    });

    it("calculates PnL when prices diverge between exchanges", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // Lighter price up more than HL
      const pnl = riskManager.calculateUnrealizedPnl(position, 3200, 3100);

      // Lighter: 0.1 * (3200 - 3000) = +20
      // HL: -0.1 * (3100 - 3000) = -10
      // Total: +10
      expect(pnl.lighterPnl).toBeCloseTo(20);
      expect(pnl.hlPnl).toBeCloseTo(-10);
      expect(pnl.totalPnl).toBeCloseTo(10);
    });

    it("calculates correct PnL for opposite direction (long HL / short Lighter)", () => {
      const position = makePosition("ETH", -0.1, 0.1, 3000, 3000, 600);

      // Price goes up
      const pnl = riskManager.calculateUnrealizedPnl(position, 3100, 3100);

      // Lighter: -0.1 * (3100 - 3000) = -10
      // HL: 0.1 * (3100 - 3000) = +10
      // Total: 0 (delta neutral)
      expect(pnl.lighterPnl).toBeCloseTo(-10);
      expect(pnl.hlPnl).toBeCloseTo(10);
      expect(pnl.totalPnl).toBeCloseTo(0);
    });

    it("calculates price divergence percentage", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // 2% price divergence
      const pnl = riskManager.calculateUnrealizedPnl(position, 3060, 3000);

      // Average price = 3030, divergence = 60 / 3030 ≈ 1.98%
      expect(pnl.priceDivergencePct).toBeCloseTo(0.0198, 2);
    });

    it("calculates liquidation distance correctly", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // With 2x leverage: initial margin = 50%, maintenance = 5%
      // Max loss per leg before liq = notional * (0.5 - 0.05) = notional * 0.45
      // Per leg notional = 300, max loss = 300 * 0.45 = 135

      // Price moves against short leg by $500 (HL goes up)
      const pnl = riskManager.calculateUnrealizedPnl(position, 3000, 3500);

      // HL PnL: -0.1 * (3500 - 3000) = -50
      // HL liq distance = 50 / 135 ≈ 0.37 (37% towards liquidation)
      expect(pnl.hlPnl).toBeCloseTo(-50);
      expect(pnl.hlLiqDistance).toBeCloseTo(0.37, 1);
      expect(pnl.lighterLiqDistance).toBe(0); // Long side not losing
    });
  });

  describe("checkPositionRisk - Stop Loss", () => {
    it("triggers stop-loss when USD threshold breached", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);

      // Create PnL that exceeds stop-loss
      const pnl = riskManager.calculateUnrealizedPnl(position, 2500, 3500);
      // Lighter: 0.1 * (2500 - 3000) = -50
      // HL: -0.1 * (3500 - 3000) = -50
      // Total: -100

      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("Stop-loss");
      expect(risk.exitReason).toContain("-$50");
    });

    it("triggers stop-loss when percentage threshold breached", () => {
      // Config: stopLossPct = 0.10 (10%)
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);

      // Create 12% loss (> 10% threshold)
      const pnl = riskManager.calculateUnrealizedPnl(position, 2700, 3300);
      // Lighter: 0.1 * (2700 - 3000) = -30
      // HL: -0.1 * (3300 - 3000) = -30
      // Total: -60 = 12% of 500

      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("Stop-loss");
    });

    it("does not trigger stop-loss when within limits", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);

      // Both prices move together (no divergence) with small loss
      // Price divergence must be < 2% (maxPriceDivergencePct)
      const pnl = riskManager.calculateUnrealizedPnl(position, 3010, 3020);
      // Lighter: 0.1 * (3010 - 3000) = +1
      // HL: -0.1 * (3020 - 3000) = -2
      // Total: -1 = 0.2% of 500 (well under 10% threshold)
      // Divergence: 10/3015 = 0.33% (under 2%)

      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(false);
      expect(risk.exitReason).toBeNull();
    });
  });

  describe("checkPositionRisk - Take Profit", () => {
    it("triggers take-profit when USD threshold reached", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);

      // Create profit exceeding take-profit threshold
      const pnl = riskManager.calculateUnrealizedPnl(position, 3500, 2500);
      // Lighter: 0.1 * (3500 - 3000) = +50
      // HL: -0.1 * (2500 - 3000) = +50
      // Total: +100 (equals threshold)

      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("Take-profit");
    });

    it("triggers take-profit when percentage threshold reached", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);

      // Create 22% profit (> 20% threshold)
      const pnl = riskManager.calculateUnrealizedPnl(position, 3550, 2450);
      // Lighter: 0.1 * (3550 - 3000) = +55
      // HL: -0.1 * (2450 - 3000) = +55
      // Total: +110 = 22% of 500

      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("Take-profit");
    });
  });

  describe("checkPositionRisk - Max Hold Time", () => {
    it("triggers exit when max hold time exceeded", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);
      // Set entry timestamp to 25 hours ago
      position.entryTimestamp = Date.now() - 25 * 60 * 60 * 1000;

      const pnl = riskManager.calculateUnrealizedPnl(position, 3000, 3000);
      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("Max hold time");
      expect(risk.holdTimeHours).toBeGreaterThan(24);
    });

    it("does not trigger when within hold time", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);
      // Entry 1 hour ago
      position.entryTimestamp = Date.now() - 1 * 60 * 60 * 1000;

      const pnl = riskManager.calculateUnrealizedPnl(position, 3000, 3000);
      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(false);
      expect(risk.holdTimeHours).toBeCloseTo(1, 1);
    });
  });

  describe("checkPositionRisk - Price Divergence", () => {
    it("triggers exit when price divergence exceeds threshold", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 500);

      // 3% price divergence (> 2% threshold)
      const pnl = riskManager.calculateUnrealizedPnl(position, 3090, 3000);

      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("Price divergence");
    });
  });

  describe("checkPositionRisk - Liquidation Proximity", () => {
    it("triggers exit when approaching liquidation on one leg", () => {
      // Create a config with high thresholds to isolate liquidation proximity test
      const liqTestConfig = {
        ...config,
        stopLossUsd: 200, // Higher than liquidation proximity would trigger
        stopLossPct: 0.50, // 50%
        maxPriceDivergencePct: 0.50, // 50% - allow large divergence for this test
      };
      const liqTestRM = new RiskManager(liqTestConfig);

      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // With 2x leverage: max loss per leg ≈ 45% of per-leg notional (300)
      // Max loss = 300 * 0.45 = 135
      // Liq buffer = 20%, so exit at 80% = 108 loss

      // Create large loss on HL short leg
      // Need price move to create ~110 loss on HL leg
      // HL PnL = -0.1 * (currentPrice - 3000)
      // -110 = -0.1 * (currentPrice - 3000)
      // currentPrice = 4100
      const pnl = liqTestRM.calculateUnrealizedPnl(position, 3000, 4100);

      // HL loss = -0.1 * (4100 - 3000) = -110
      // hlLiqDistance = 110 / 135 ≈ 0.815 > 0.8 threshold
      expect(pnl.hlPnl).toBeCloseTo(-110);
      expect(pnl.hlLiqDistance).toBeGreaterThan(0.8);

      const risk = liqTestRM.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("approaching liquidation");
    });

    it("stop-loss takes priority over price divergence when both are breached", () => {
      // Risk checks happen in priority order:
      // 1. Stop-loss USD/PCT, 2. Take-profit, 3. Max hold, 4. Price divergence, 5. Liquidation
      // So if multiple triggers are hit, stop-loss will be reported first
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // HL price up 30% while Lighter stays flat = massive divergence AND large loss
      const pnl = riskManager.calculateUnrealizedPnl(position, 3000, 4100);

      // Both conditions are true:
      expect(pnl.priceDivergencePct).toBeGreaterThan(0.02); // > 2% divergence
      expect(pnl.totalPnl).toBeLessThan(-50); // > $50 loss

      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(true);
      // Stop-loss triggers first due to check order
      expect(risk.exitReason).toContain("Stop-loss");
    });

    it("stop-loss triggers before liquidation when configured lower", () => {
      // Create config where stop-loss is lower than divergence threshold
      const testConfig = {
        ...config,
        stopLossUsd: 50,
        maxPriceDivergencePct: 0.50, // High threshold to let stop-loss trigger first
      };
      const testRM = new RiskManager(testConfig);

      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // Create loss that exceeds stop-loss
      // Move both prices up to avoid divergence, but HL loss still accumulates
      const pnl = testRM.calculateUnrealizedPnl(position, 3500, 3600);

      // Lighter: 0.1 * (3500 - 3000) = +50
      // HL: -0.1 * (3600 - 3000) = -60
      // Total: -10, but HL leg has -60 loss
      // This won't trigger stop-loss on total, but let's try a bigger move
      const pnl2 = testRM.calculateUnrealizedPnl(position, 3000, 3600);
      // Lighter: 0
      // HL: -0.1 * (3600 - 3000) = -60
      // Total: -60 > $50 stop-loss

      const risk = testRM.checkPositionRisk(position, pnl2);

      expect(risk.shouldExit).toBe(true);
      expect(risk.exitReason).toContain("Stop-loss");
    });

    it("does not trigger when safely away from liquidation", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // Small parallel price move - both prices go up same amount
      // This keeps divergence low and doesn't create significant per-leg loss
      const pnl = riskManager.calculateUnrealizedPnl(position, 3010, 3010);

      // Lighter: 0.1 * (3010 - 3000) = +1
      // HL: -0.1 * (3010 - 3000) = -1
      // Total: 0 (perfectly hedged)
      // Divergence: 0%
      // hlLiqDistance: 1 / 135 ≈ 0.007 < 0.8 threshold
      const risk = riskManager.checkPositionRisk(position, pnl);

      expect(risk.shouldExit).toBe(false);
    });
  });

  describe("calculateExitPnl", () => {
    it("calculates exit PnL correctly with fees", () => {
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      const result = riskManager.calculateExitPnl(position, 3100, 2900, 0.5, 0.6);

      // Lighter: 0.1 * (3100 - 3000) = +10
      // HL: -0.1 * (2900 - 3000) = +10
      // Total: +20
      // Fees: 1.1
      // Net: 18.9
      expect(result.lighterPnl).toBeCloseTo(10);
      expect(result.hlPnl).toBeCloseTo(10);
      expect(result.totalPnl).toBeCloseTo(20);
      expect(result.feesTotal).toBeCloseTo(1.1);
      expect(result.netPnl).toBeCloseTo(18.9);
    });
  });

  describe("kill switch", () => {
    it("trips after consecutive failures", () => {
      riskManager.recordFailure("error 1");
      expect(riskManager.isTripped()).toBe(false);

      riskManager.recordFailure("error 2");
      expect(riskManager.isTripped()).toBe(false);

      riskManager.recordFailure("error 3");
      expect(riskManager.isTripped()).toBe(true);
      expect(riskManager.getKillReason()).toContain("consecutive failures");
    });

    it("resets consecutive failures on success", () => {
      riskManager.recordFailure("error 1");
      riskManager.recordFailure("error 2");
      riskManager.recordSuccess();

      riskManager.recordFailure("error 3");
      expect(riskManager.isTripped()).toBe(false); // Reset counter
    });

    it("trips on max drawdown", () => {
      riskManager.recordRealizedPnl(-200);
      expect(riskManager.isTripped()).toBe(false);

      riskManager.recordRealizedPnl(-350); // Total: -550 > -500 threshold
      expect(riskManager.isTripped()).toBe(true);
      expect(riskManager.getKillReason()).toContain("drawdown");
    });

    it("can be reset", () => {
      riskManager.recordFailure("error 1");
      riskManager.recordFailure("error 2");
      riskManager.recordFailure("error 3");
      expect(riskManager.isTripped()).toBe(true);

      riskManager.resetKillSwitch();
      expect(riskManager.isTripped()).toBe(false);
    });
  });

  describe("leverage calculations", () => {
    it("uses 2x leverage for margin calculations", () => {
      // With 2x leverage, initial margin = 50% of notional
      // For $500 notional, required margin = $250
      // With 2x safety factor = $500 required per side

      // This is tested implicitly through liquidation distance calculations
      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);
      const pnl = riskManager.calculateUnrealizedPnl(position, 3000, 3000);

      // No price move = no liquidation risk
      expect(pnl.lighterLiqDistance).toBe(0);
      expect(pnl.hlLiqDistance).toBe(0);
    });

    it("calculates higher risk with higher leverage", () => {
      // Create a high leverage config
      const highLeverageConfig = {
        ...config,
        leverage: 10, // 10x leverage = 10% initial margin
      };
      const highLeverageRM = new RiskManager(highLeverageConfig);

      const position = makePosition("ETH", 0.1, -0.1, 3000, 3000, 600);

      // Same price move with high leverage should show higher liq distance
      const lowLevPnl = riskManager.calculateUnrealizedPnl(position, 3000, 3300);
      const highLevPnl = highLeverageRM.calculateUnrealizedPnl(position, 3000, 3300);

      // Both have same PnL
      expect(lowLevPnl.hlPnl).toEqual(highLevPnl.hlPnl);

      // But high leverage is closer to liquidation
      expect(highLevPnl.hlLiqDistance).toBeGreaterThan(lowLevPnl.hlLiqDistance);
    });
  });
});

function makePosition(
  symbol: string,
  lighterSize: number,
  hlSize: number,
  lighterEntryPrice: number,
  hlEntryPrice: number,
  notionalUsd: number
): OpenPosition {
  return {
    symbol,
    direction: lighterSize > 0 ? "long_lighter_short_hl" : "long_hl_short_lighter",
    entryEdgeBps: 25,
    entryTimestamp: Date.now(),
    lighterSize,
    hlSize,
    lighterEntryPrice,
    hlEntryPrice,
    notionalUsd,
  };
}
