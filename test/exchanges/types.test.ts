import { describe, it, expect } from "vitest";
import {
  Side,
  OrderType,
  OrderTimeInForce,
  type FundingSnapshot,
  type Ticker,
  type Position,
  type OrderRequest,
  type OrderResult,
  type SymbolSpec,
} from "../../src/exchanges/types.js";

describe("Exchange Types", () => {
  describe("Enums", () => {
    it("Side enum has correct values", () => {
      expect(Side.BUY).toBe("buy");
      expect(Side.SELL).toBe("sell");
    });

    it("OrderType enum has correct values", () => {
      expect(OrderType.MARKET).toBe("market");
      expect(OrderType.LIMIT).toBe("limit");
    });

    it("OrderTimeInForce enum has correct values", () => {
      expect(OrderTimeInForce.IOC).toBe("ioc");
      expect(OrderTimeInForce.GTC).toBe("gtc");
      expect(OrderTimeInForce.POST_ONLY).toBe("post_only");
    });
  });

  describe("Type Structures", () => {
    it("SymbolSpec has correct shape", () => {
      const spec: SymbolSpec = {
        symbol: "ETH",
        baseAsset: "ETH",
        quoteAsset: "USDC",
        tickSize: 0.01,
        lotSize: 0.001,
        maxLeverage: 50,
      };

      expect(spec.symbol).toBe("ETH");
      expect(spec.maxLeverage).toBe(50);
    });

    it("FundingSnapshot has correct shape", () => {
      const snapshot: FundingSnapshot = {
        symbol: "ETH",
        rate: 0.0001,
        nextFundingTimestamp: Date.now() + 3600000,
        lastUpdated: Date.now(),
      };

      expect(snapshot.symbol).toBe("ETH");
      expect(snapshot.rate).toBe(0.0001);
    });

    it("Ticker has correct shape", () => {
      const ticker: Ticker = {
        symbol: "ETH",
        bid: 3999.5,
        ask: 4000.5,
        timestamp: Date.now(),
      };

      expect(ticker.bid).toBeLessThan(ticker.ask);
    });

    it("Position has correct shape", () => {
      const position: Position = {
        symbol: "ETH",
        side: Side.BUY,
        size: 1.5,
        entryPrice: 4000,
        leverage: 10,
      };

      expect(position.side).toBe(Side.BUY);
      expect(position.size).toBe(1.5);
    });

    it("OrderRequest has correct shape", () => {
      const order: OrderRequest = {
        clientId: "test-123",
        symbol: "ETH",
        side: Side.BUY,
        size: 0.1,
        orderType: OrderType.LIMIT,
        price: 4000,
        reduceOnly: false,
        timeInForce: OrderTimeInForce.GTC,
      };

      expect(order.clientId).toBe("test-123");
      expect(order.orderType).toBe(OrderType.LIMIT);
    });

    it("OrderResult has correct shape", () => {
      const result: OrderResult = {
        clientId: "test-123",
        exchangeOrderId: "ex-456",
        status: "filled",
        filledSize: 0.1,
        averageFillPrice: 3999,
      };

      expect(result.status).toBe("filled");
      expect(result.filledSize).toBe(0.1);
    });
  });
});

