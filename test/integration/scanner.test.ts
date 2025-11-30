import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HyperliquidClient } from "../../src/exchanges/hyperliquid.js";

interface FundingRate {
  symbol: string;
  rate: number;
  exchange?: string;
}

interface Opportunity {
  symbol: string;
  hlRate8hr: number;
  lighterRate8hr: number;
  edgeBps: number;
  apy: number;
  direction: string;
}

async function fetchLighterRates(): Promise<Map<string, number>> {
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

  const map = new Map<string, number>();
  for (const rate of data.funding_rates) {
    if (rate.exchange === "lighter") {
      map.set(rate.symbol, rate.rate);
    }
  }
  return map;
}

function scanOpportunities(
  hlRates: FundingRate[],
  lighterRates: Map<string, number>,
  minEdgeBps: number
): Opportunity[] {
  const opportunities: Opportunity[] = [];

  const hlRateMap = new Map<string, number>();
  for (const rate of hlRates) {
    hlRateMap.set(rate.symbol, rate.rate);
  }

  // Find common symbols
  const commonSymbols = [...hlRateMap.keys()].filter((s) =>
    lighterRates.has(s)
  );

  for (const symbol of commonSymbols) {
    const hlRate1hr = hlRateMap.get(symbol)!;
    const lighterRate8hr = lighterRates.get(symbol)!;

    // Normalize HL to 8hr
    const hlRate8hr = hlRate1hr * 8;

    // Skip if both zero
    if (hlRate1hr === 0 && lighterRate8hr === 0) continue;

    const edgeBps = (hlRate8hr - lighterRate8hr) * 10000;
    const apy = (Math.abs(edgeBps) * 3 * 365) / 100;

    if (Math.abs(edgeBps) >= minEdgeBps) {
      const direction =
        edgeBps > 0
          ? "Long Lighter / Short Hyperliquid"
          : "Long Hyperliquid / Short Lighter";

      opportunities.push({
        symbol,
        hlRate8hr,
        lighterRate8hr,
        edgeBps,
        apy,
        direction,
      });
    }
  }

  return opportunities.sort((a, b) => Math.abs(b.edgeBps) - Math.abs(a.edgeBps));
}

describe("Opportunity Scanner Integration", () => {
  let hlClient: HyperliquidClient;
  let hlRates: FundingRate[];
  let lighterRates: Map<string, number>;

  beforeAll(async () => {
    hlClient = new HyperliquidClient({});

    // Fetch rates in parallel
    const [hl, lighter] = await Promise.all([
      hlClient.getFundingRates([]),
      fetchLighterRates(),
    ]);

    hlRates = hl;
    lighterRates = lighter;
  });

  afterAll(async () => {
    await hlClient.close();
  });

  it("fetches rates from both exchanges", () => {
    expect(hlRates.length).toBeGreaterThan(0);
    expect(lighterRates.size).toBeGreaterThan(0);
  });

  it("finds common symbols between exchanges", () => {
    const hlSymbols = new Set(hlRates.map((r) => r.symbol));
    const commonSymbols = [...hlSymbols].filter((s) => lighterRates.has(s));

    expect(commonSymbols.length).toBeGreaterThan(0);
    console.log(`Found ${commonSymbols.length} common symbols`);
  });

  it("scans for opportunities with 20 bps threshold", () => {
    const opportunities = scanOpportunities(hlRates, lighterRates, 20);

    // Just check it runs - may or may not find opportunities
    expect(opportunities).toBeInstanceOf(Array);

    if (opportunities.length > 0) {
      const best = opportunities[0];
      expect(Math.abs(best.edgeBps)).toBeGreaterThanOrEqual(20);
      expect(best.apy).toBeGreaterThan(0);
      expect(best.direction).toMatch(/Long (Lighter|Hyperliquid)/);

      console.log(
        `Best opportunity: ${best.symbol} @ ${best.edgeBps.toFixed(1)} bps (${best.apy.toFixed(0)}% APY)`
      );
    }
  });

  it("scans for opportunities with lower threshold", () => {
    const opportunities = scanOpportunities(hlRates, lighterRates, 5);

    expect(opportunities).toBeInstanceOf(Array);
    console.log(
      `Found ${opportunities.length} opportunities with 5 bps threshold`
    );
  });

  it("returns empty array when threshold is too high", () => {
    const opportunities = scanOpportunities(hlRates, lighterRates, 10000);

    expect(opportunities).toEqual([]);
  });

  it("sorts opportunities by absolute edge", () => {
    const opportunities = scanOpportunities(hlRates, lighterRates, 1);

    for (let i = 1; i < opportunities.length; i++) {
      expect(Math.abs(opportunities[i - 1].edgeBps)).toBeGreaterThanOrEqual(
        Math.abs(opportunities[i].edgeBps)
      );
    }
  });
});

