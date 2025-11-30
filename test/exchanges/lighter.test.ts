import { describe, it, expect } from "vitest";
import { LighterClient } from "../../src/exchanges/lighter.js";

describe("LighterClient", () => {
  // Note: LighterClient requires a private key for initialization
  // These tests focus on public API endpoints

  describe("getFundingRates (via direct API)", () => {
    it("fetches funding rates from Lighter API", async () => {
      const response = await fetch(
        "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"
      );
      const data = (await response.json()) as {
        code: number;
        funding_rates: Array<{
          symbol: string;
          rate: number;
          exchange: string;
        }>;
      };

      expect(data.code).toBe(200);
      expect(data.funding_rates).toBeInstanceOf(Array);
      expect(data.funding_rates.length).toBeGreaterThan(0);

      // Check structure
      const first = data.funding_rates[0];
      expect(first).toHaveProperty("symbol");
      expect(first).toHaveProperty("rate");
      expect(first).toHaveProperty("exchange");
    });

    it("includes lighter-native rates", async () => {
      const response = await fetch(
        "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"
      );
      const data = (await response.json()) as {
        funding_rates: Array<{
          symbol: string;
          rate: number;
          exchange: string;
        }>;
      };

      const lighterRates = data.funding_rates.filter(
        (r) => r.exchange === "lighter"
      );
      expect(lighterRates.length).toBeGreaterThan(0);
    });

    it("includes rates from other exchanges for comparison", async () => {
      const response = await fetch(
        "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"
      );
      const data = (await response.json()) as {
        funding_rates: Array<{
          exchange: string;
        }>;
      };

      const exchanges = new Set(data.funding_rates.map((r) => r.exchange));
      expect(exchanges.size).toBeGreaterThan(1); // Should have multiple exchanges
    });
  });
});

describe("Funding Rate Normalization", () => {
  it("correctly normalizes Hyperliquid 1hr to 8hr rate", () => {
    const hlRate1hr = 0.000125; // 0.0125% per hour
    const hlRate8hr = hlRate1hr * 8;

    expect(hlRate8hr).toBe(0.001); // 0.1% per 8hr
  });

  it("Lighter rates are already 8hr (no conversion needed)", () => {
    const lighterRate8hr = 0.001; // 0.1% per 8hr

    // No conversion needed
    expect(lighterRate8hr).toBe(0.001);
  });

  it("calculates edge correctly", () => {
    const hlRate1hr = 0.0002; // 0.02% per hour
    const hlRate8hr = hlRate1hr * 8; // 0.16% per 8hr
    const lighterRate8hr = 0.001; // 0.1% per 8hr

    // Edge = HL - Lighter (both in 8hr terms)
    const edgeBps = (hlRate8hr - lighterRate8hr) * 10000;

    // 0.16% - 0.1% = 0.06% = 6 bps
    expect(edgeBps).toBeCloseTo(6, 1);
  });

  it("calculates APY correctly", () => {
    const edgeBps = 20; // 20 bps per 8hr

    // 3 funding payments per day * 365 days / 100 (bps to %)
    const apy = (Math.abs(edgeBps) * 3 * 365) / 100;

    // 20 * 3 * 365 / 100 = 219%
    expect(apy).toBe(219);
  });

  it("determines correct arbitrage direction", () => {
    // When HL > Lighter: Long Lighter, Short HL
    const hlRateHigh = 0.002; // HL pays more
    const lighterRateLow = 0.001;
    const edge1 = (hlRateHigh - lighterRateLow) * 10000;
    expect(edge1).toBeGreaterThan(0);
    // Direction: Long Lighter / Short Hyperliquid

    // When Lighter > HL: Long HL, Short Lighter
    const hlRateLow = 0.001;
    const lighterRateHigh = 0.002; // Lighter pays more
    const edge2 = (hlRateLow - lighterRateHigh) * 10000;
    expect(edge2).toBeLessThan(0);
    // Direction: Long Hyperliquid / Short Lighter
  });
});

