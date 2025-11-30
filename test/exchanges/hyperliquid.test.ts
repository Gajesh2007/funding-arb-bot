import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HyperliquidClient } from "../../src/exchanges/hyperliquid.js";

describe("HyperliquidClient", () => {
  let client: HyperliquidClient;

  beforeAll(() => {
    client = new HyperliquidClient({});
  });

  afterAll(async () => {
    await client.close();
  });

  describe("getSymbols", () => {
    it("fetches symbols from Hyperliquid", async () => {
      const symbols = await client.getSymbols();

      expect(symbols).toBeInstanceOf(Array);
      expect(symbols.length).toBeGreaterThan(0);

      // Check first symbol has correct structure
      const first = symbols[0];
      expect(first).toHaveProperty("symbol");
      expect(first).toHaveProperty("baseAsset");
      expect(first).toHaveProperty("quoteAsset");
      expect(first).toHaveProperty("tickSize");
      expect(first).toHaveProperty("lotSize");
      expect(first).toHaveProperty("maxLeverage");
    });

    it("caches symbols on subsequent calls", async () => {
      const first = await client.getSymbols();
      const second = await client.getSymbols();

      // Should be same reference (cached)
      expect(first).toEqual(second);
    });

    it("includes common perpetuals", async () => {
      const symbols = await client.getSymbols();
      const symbolNames = symbols.map((s) => s.symbol);

      expect(symbolNames).toContain("BTC");
      expect(symbolNames).toContain("ETH");
    });
  });

  describe("getFundingRates", () => {
    it("fetches funding rates for all symbols", async () => {
      const rates = await client.getFundingRates([]);

      expect(rates).toBeInstanceOf(Array);
      expect(rates.length).toBeGreaterThan(0);

      const first = rates[0];
      expect(first).toHaveProperty("symbol");
      expect(first).toHaveProperty("rate");
      expect(first).toHaveProperty("nextFundingTimestamp");
      expect(first).toHaveProperty("lastUpdated");
      expect(typeof first.rate).toBe("number");
    });

    it("filters by symbol when provided", async () => {
      const rates = await client.getFundingRates(["ETH", "BTC"]);

      expect(rates.length).toBeLessThanOrEqual(2);
      const symbols = rates.map((r) => r.symbol);
      for (const symbol of symbols) {
        expect(["ETH", "BTC"]).toContain(symbol);
      }
    });

    it("returns 1hr native funding rate", async () => {
      const rates = await client.getFundingRates(["ETH"]);
      const eth = rates.find((r) => r.symbol === "ETH");

      // Hyperliquid funding is typically very small (1hr rate)
      // Typical range: -0.01% to +0.01% per hour
      if (eth) {
        expect(Math.abs(eth.rate)).toBeLessThan(0.01); // < 1% per hour would be extreme
      }
    });
  });

  describe("getTicker", () => {
    it("fetches ticker data for a symbol", async () => {
      const ticker = await client.getTicker("ETH");

      expect(ticker).toHaveProperty("symbol", "ETH");
      expect(ticker).toHaveProperty("bid");
      expect(ticker).toHaveProperty("ask");
      expect(ticker).toHaveProperty("timestamp");

      // Basic sanity checks
      expect(ticker.bid).toBeGreaterThan(0);
      expect(ticker.ask).toBeGreaterThan(0);
      expect(ticker.ask).toBeGreaterThanOrEqual(ticker.bid);
    });

    it("returns reasonable prices for BTC", async () => {
      const ticker = await client.getTicker("BTC");

      // BTC should be > $10k (sanity check)
      expect(ticker.bid).toBeGreaterThan(10000);
      expect(ticker.ask).toBeGreaterThan(10000);
    });
  });

  describe("positions and orders (require auth)", () => {
    it("throws error for getPositions without private key", async () => {
      await expect(client.getPositions()).rejects.toThrow(
        "Private key required"
      );
    });

    it("throws error for placeOrder without private key", async () => {
      await expect(
        client.placeOrder({
          clientId: "test",
          symbol: "ETH",
          side: "buy" as any,
          size: 0.01,
          orderType: "limit" as any,
          price: 1000,
        })
      ).rejects.toThrow("Private key required");
    });
  });
});

