import { describe, it, expect } from "vitest";
import { PnLTracker } from "../../src/infra/pnl-tracker.js";
import { existsSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";

describe("PnLTracker", () => {
  // Each test uses a truly unique file to ensure isolation
  function getUniquePath(): string {
    return `.test-pnl-${randomUUID()}.json`;
  }

  function cleanupFile(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  }

  it("records trades and updates fee totals", () => {
    const path = getUniquePath();
    try {
      const tracker = new PnLTracker(path);

      tracker.recordTrade({
        symbol: "ETH",
        exchange: "hyperliquid",
        side: "buy",
        size: 0.1,
        price: 3000,
        fee: 0.3,
        isEntry: true,
      });

      const summary = tracker.getSummary();
      expect(summary.tradeCount).toBe(1);
      expect(summary.feesPaid).toBe(0.3);
    } finally {
      cleanupFile(path);
    }
  });

  it("records position PnL on exit", () => {
    const path = getUniquePath();
    try {
      const tracker = new PnLTracker(path);

      tracker.recordTrade({
        symbol: "ETH",
        exchange: "hyperliquid",
        side: "sell",
        size: 0.1,
        price: 3100,
        fee: 0.31,
        isEntry: false,
        positionPnl: 10,
      });

      expect(tracker.getSummary().realizedPnl).toBe(10);
    } finally {
      cleanupFile(path);
    }
  });

  it("records funding payments", () => {
    const path = getUniquePath();
    try {
      const tracker = new PnLTracker(path);

      tracker.recordFundingPayment({
        symbol: "ETH",
        exchange: "hyperliquid",
        amount: 0.5,
      });

      const summary = tracker.getSummary();
      expect(summary.fundingPaymentCount).toBe(1);
      expect(summary.fundingEarned).toBe(0.5);
    } finally {
      cleanupFile(path);
    }
  });

  it("calculates net PnL correctly", () => {
    const path = getUniquePath();
    try {
      const tracker = new PnLTracker(path);

      tracker.recordTrade({
        symbol: "ETH",
        exchange: "hyperliquid",
        side: "sell",
        size: 0.1,
        price: 3100,
        fee: 1.0,
        isEntry: false,
        positionPnl: 50,
      });

      tracker.recordFundingPayment({
        symbol: "ETH",
        exchange: "hyperliquid",
        amount: 5.0,
      });

      const summary = tracker.getSummary();
      // Net = realizedPnl + funding - fees = 50 + 5 - 1 = 54
      expect(summary.netPnl).toBe(54);
    } finally {
      cleanupFile(path);
    }
  });

  it("persists state to disk", () => {
    const path = getUniquePath();
    try {
      const tracker1 = new PnLTracker(path);
      tracker1.recordTrade({
        symbol: "ETH",
        exchange: "hyperliquid",
        side: "buy",
        size: 0.1,
        price: 3000,
        fee: 0.5,
        isEntry: true,
      });

      // Create new tracker to reload
      const tracker2 = new PnLTracker(path);
      expect(tracker2.getSummary().tradeCount).toBe(1);
      expect(tracker2.getSummary().feesPaid).toBe(0.5);
    } finally {
      cleanupFile(path);
    }
  });

  it("resets all state", () => {
    const path = getUniquePath();
    try {
      const tracker = new PnLTracker(path);

      tracker.recordTrade({
        symbol: "ETH",
        exchange: "hyperliquid",
        side: "buy",
        size: 0.1,
        price: 3000,
        fee: 0.5,
        isEntry: true,
        positionPnl: 10,
      });

      tracker.reset();

      const summary = tracker.getSummary();
      expect(summary.tradeCount).toBe(0);
      expect(summary.realizedPnl).toBe(0);
      expect(summary.feesPaid).toBe(0);
    } finally {
      cleanupFile(path);
    }
  });
});
