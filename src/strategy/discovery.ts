/**
 * Symbol Discovery
 *
 * Automatically discovers and ranks arbitrage opportunities across all
 * symbols available on both exchanges.
 */

import type { HyperliquidClient } from "../exchanges/hyperliquid.js";

export interface SymbolOpportunity {
  symbol: string;
  hlRate1hr: number;
  hlRate8hr: number;
  lighterRate8hr: number;
  edgeBps: number;
  absEdgeBps: number;
  apy: number;
  direction: "long_lighter_short_hl" | "long_hl_short_lighter";
}

export interface DiscoveryConfig {
  /** Minimum edge to consider (bps) */
  minEdgeBps: number;
  /** Maximum symbols to return */
  maxSymbols: number;
  /** Symbols to exclude */
  excludeSymbols?: string[];
  /** Only include these symbols (if set) */
  includeOnly?: string[];
}

const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  minEdgeBps: 10,
  maxSymbols: 10,
  excludeSymbols: [],
};

/**
 * Fetch Lighter funding rates directly from API
 */
async function fetchLighterRates(): Promise<Map<string, number>> {
  const response = await fetch(
    "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"
  );
  const data = (await response.json()) as {
    funding_rates: Array<{
      symbol: string;
      rate: string;
      exchange: string;
    }>;
  };

  const map = new Map<string, number>();
  for (const rate of data.funding_rates) {
    if (rate.exchange === "lighter") {
      map.set(rate.symbol, parseFloat(rate.rate));
    }
  }
  return map;
}

/**
 * Discover top arbitrage opportunities across all symbols
 */
export async function discoverOpportunities(
  hlClient: HyperliquidClient,
  config: Partial<DiscoveryConfig> = {}
): Promise<SymbolOpportunity[]> {
  const cfg = { ...DEFAULT_DISCOVERY_CONFIG, ...config };

  // Fetch rates from both exchanges in parallel
  const [hlRates, lighterRates] = await Promise.all([
    hlClient.getFundingRates([]),
    fetchLighterRates(),
  ]);

  // Build HL rate map
  const hlRateMap = new Map<string, number>();
  for (const rate of hlRates) {
    hlRateMap.set(rate.symbol, rate.rate);
  }

  // Find common symbols
  const commonSymbols = [...hlRateMap.keys()].filter((s) => lighterRates.has(s));

  // Apply filters
  let filteredSymbols = commonSymbols;

  if (cfg.excludeSymbols && cfg.excludeSymbols.length > 0) {
    const excludeSet = new Set(cfg.excludeSymbols);
    filteredSymbols = filteredSymbols.filter((s) => !excludeSet.has(s));
  }

  if (cfg.includeOnly && cfg.includeOnly.length > 0) {
    const includeSet = new Set(cfg.includeOnly);
    filteredSymbols = filteredSymbols.filter((s) => includeSet.has(s));
  }

  // Calculate opportunities
  const opportunities: SymbolOpportunity[] = [];

  for (const symbol of filteredSymbols) {
    const hlRate1hr = hlRateMap.get(symbol)!;
    const lighterRate8hr = lighterRates.get(symbol)!;

    // Normalize HL to 8hr
    const hlRate8hr = hlRate1hr * 8;

    // Skip if both are zero
    if (hlRate1hr === 0 && lighterRate8hr === 0) continue;

    const edgeBps = (hlRate8hr - lighterRate8hr) * 10000;
    const absEdgeBps = Math.abs(edgeBps);

    // Skip if below minimum
    if (absEdgeBps < cfg.minEdgeBps) continue;

    const apy = (absEdgeBps * 3 * 365) / 100;
    const direction =
      edgeBps > 0 ? "long_lighter_short_hl" : "long_hl_short_lighter";

    opportunities.push({
      symbol,
      hlRate1hr,
      hlRate8hr,
      lighterRate8hr,
      edgeBps,
      absEdgeBps,
      apy,
      direction,
    });
  }

  // Sort by absolute edge (best first)
  opportunities.sort((a, b) => b.absEdgeBps - a.absEdgeBps);

  // Return top N
  return opportunities.slice(0, cfg.maxSymbols);
}

/**
 * Get just the symbol names of top opportunities
 */
export async function discoverTopSymbols(
  hlClient: HyperliquidClient,
  config: Partial<DiscoveryConfig> = {}
): Promise<string[]> {
  const opportunities = await discoverOpportunities(hlClient, config);
  return opportunities.map((o) => o.symbol);
}

/**
 * Continuously discover and update symbol list
 */
export class SymbolDiscoveryService {
  private hlClient: HyperliquidClient;
  private config: DiscoveryConfig;
  private currentSymbols: string[] = [];
  private lastDiscovery: number = 0;
  private discoveryIntervalMs: number;

  constructor(
    hlClient: HyperliquidClient,
    config: Partial<DiscoveryConfig> = {},
    discoveryIntervalMs: number = 5 * 60 * 1000 // 5 minutes default
  ) {
    this.hlClient = hlClient;
    this.config = { ...DEFAULT_DISCOVERY_CONFIG, ...config };
    this.discoveryIntervalMs = discoveryIntervalMs;
  }

  /**
   * Get current symbols, refreshing if stale
   */
  async getSymbols(): Promise<string[]> {
    const now = Date.now();
    if (now - this.lastDiscovery > this.discoveryIntervalMs || this.currentSymbols.length === 0) {
      await this.refresh();
    }
    return this.currentSymbols;
  }

  /**
   * Force refresh symbol list
   */
  async refresh(): Promise<SymbolOpportunity[]> {
    const opportunities = await discoverOpportunities(this.hlClient, this.config);
    this.currentSymbols = opportunities.map((o) => o.symbol);
    this.lastDiscovery = Date.now();
    return opportunities;
  }

  /**
   * Get full opportunity data for current symbols
   */
  async getOpportunities(): Promise<SymbolOpportunity[]> {
    return discoverOpportunities(this.hlClient, this.config);
  }
}


