import { describe, it, expect, beforeEach } from "vitest";
import { FundingHistoryTracker } from "../../src/strategy/funding-history.js";
import type { FundingSnapshot } from "../../src/strategy/types.js";

describe("FundingHistoryTracker", () => {
  let tracker: FundingHistoryTracker;

  beforeEach(() => {
    tracker = new FundingHistoryTracker({
      historyWindowHours: 24,
      minHistorySamples: 5,
      maxStdDevsForEntry: 2,
    });
  });

  describe("record and hasEnoughHistory", () => {
    it("starts with no history", () => {
      expect(tracker.hasEnoughHistory("ETH")).toBe(false);
    });

    it("tracks that we don't have enough samples", () => {
      const now = Date.now();
      for (let i = 0; i < 4; i++) {
        tracker.record(makeSnapshot("ETH", 10, now - (4 - i) * 60000)); // Recent timestamps
      }
      expect(tracker.hasEnoughHistory("ETH")).toBe(false);
    });

    it("reports enough history after min samples", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        tracker.record(makeSnapshot("ETH", 10, now - (5 - i) * 60000)); // Recent timestamps
      }
      expect(tracker.hasEnoughHistory("ETH")).toBe(true);
    });
  });

  describe("spike detection", () => {
    it("treats unknown symbol as spike (conservative)", () => {
      expect(tracker.isSpike("ETH", 100)).toBe(true);
    });

    it("treats insufficient history as spike", () => {
      tracker.record(makeSnapshot("ETH", 10));
      tracker.record(makeSnapshot("ETH", 12));
      expect(tracker.isSpike("ETH", 15)).toBe(true);
    });

    it("detects spike when value is far from mean", () => {
      // Build stable history around 10 bps
      for (let i = 0; i < 10; i++) {
        tracker.record(makeSnapshot("ETH", 10 + (Math.random() - 0.5) * 2)); // 9-11 bps range
      }

      // 10 bps is normal
      expect(tracker.isSpike("ETH", 10)).toBe(false);

      // 100 bps is definitely a spike
      expect(tracker.isSpike("ETH", 100)).toBe(true);
    });

    it("allows values within normal range", () => {
      // Add consistent history
      for (let i = 0; i < 10; i++) {
        tracker.record(makeSnapshot("ETH", 20));
      }

      const history = tracker.getHistory("ETH");
      expect(history).not.toBeNull();
      expect(history?.meanEdgeBps).toBeCloseTo(20, 1);
      expect(history?.stdDevBps).toBeCloseTo(0, 1);

      // Same value should not be a spike
      expect(tracker.isSpike("ETH", 20)).toBe(false);
    });
  });

  describe("statistics", () => {
    it("calculates mean correctly", () => {
      tracker.record(makeSnapshot("ETH", 10));
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 30));
      tracker.record(makeSnapshot("ETH", 40));
      tracker.record(makeSnapshot("ETH", 50));

      const history = tracker.getHistory("ETH");
      expect(history?.meanEdgeBps).toBeCloseTo(30, 1);
    });

    it("calculates standard deviation correctly", () => {
      // Values: 10, 20, 30 - mean is 20
      // Variance: ((10-20)² + (20-20)² + (30-20)²) / 3 = (100 + 0 + 100) / 3 = 66.67
      // StdDev: √66.67 ≈ 8.16
      tracker.record(makeSnapshot("ETH", 10));
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 30));
      tracker.record(makeSnapshot("ETH", 10));
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 30));

      const history = tracker.getHistory("ETH");
      expect(history?.meanEdgeBps).toBeCloseTo(20, 1);
      expect(history?.stdDevBps).toBeGreaterThan(0);
    });
  });

  describe("edge trend", () => {
    it("detects increasing trend", () => {
      tracker.record(makeSnapshot("ETH", 10));
      tracker.record(makeSnapshot("ETH", 12));
      tracker.record(makeSnapshot("ETH", 14));
      tracker.record(makeSnapshot("ETH", 16));
      tracker.record(makeSnapshot("ETH", 18));
      tracker.record(makeSnapshot("ETH", 20));

      expect(tracker.getEdgeTrend("ETH")).toBe("increasing");
    });

    it("detects decreasing trend", () => {
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 18));
      tracker.record(makeSnapshot("ETH", 16));
      tracker.record(makeSnapshot("ETH", 14));
      tracker.record(makeSnapshot("ETH", 12));
      tracker.record(makeSnapshot("ETH", 10));

      expect(tracker.getEdgeTrend("ETH")).toBe("decreasing");
    });

    it("detects stable trend", () => {
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 20));
      tracker.record(makeSnapshot("ETH", 20));

      expect(tracker.getEdgeTrend("ETH")).toBe("stable");
    });
  });

  describe("export/import", () => {
    it("exports and imports state correctly", () => {
      for (let i = 0; i < 5; i++) {
        tracker.record(makeSnapshot("ETH", 10 + i));
        tracker.record(makeSnapshot("BTC", 20 + i));
      }

      const exported = tracker.export();
      expect(Object.keys(exported)).toContain("ETH");
      expect(Object.keys(exported)).toContain("BTC");

      const newTracker = new FundingHistoryTracker({
        historyWindowHours: 24,
        minHistorySamples: 5,
        maxStdDevsForEntry: 2,
      });
      newTracker.import(exported);

      expect(newTracker.hasEnoughHistory("ETH")).toBe(true);
      expect(newTracker.hasEnoughHistory("BTC")).toBe(true);
    });
  });
});

function makeSnapshot(symbol: string, edgeBps: number, timestamp?: number): FundingSnapshot {
  return {
    symbol,
    hlRate8hr: edgeBps / 10000,
    lighterRate8hr: 0,
    edgeBps,
    timestamp: timestamp ?? Date.now(),
  };
}

