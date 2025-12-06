/**
 * Lighter REST API
 *
 * Direct REST API calls to Lighter that don't require authentication.
 * Used for public data like funding rates and order book.
 */

const BASE_URL = "https://mainnet.zklighter.elliot.ai";

// Market ID cache
const marketIds = new Map<string, number>();

export interface LighterFundingRate {
  symbol: string;
  rate: number;
  marketId: number;
}

export interface LighterTicker {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: number;
}

/**
 * Fetch funding rates from Lighter API.
 * Returns 8hr rates (Lighter's native period).
 */
export async function fetchLighterFundingRates(
  symbols?: string[]
): Promise<LighterFundingRate[]> {
  const response = await fetch(`${BASE_URL}/api/v1/funding-rates`);
  const data = (await response.json()) as {
    funding_rates: Array<{
      symbol: string;
      rate: string;
      exchange: string;
      market_id: number;
    }>;
  };

  const symbolSet = symbols?.length ? new Set(symbols) : null;
  const results: LighterFundingRate[] = [];

  for (const rate of data.funding_rates) {
    if (rate.exchange !== "lighter") continue;
    if (symbolSet && !symbolSet.has(rate.symbol)) continue;

    // Cache market IDs while we're at it
    marketIds.set(rate.symbol, rate.market_id);

    results.push({
      symbol: rate.symbol,
      rate: parseFloat(rate.rate),
      marketId: rate.market_id,
    });
  }

  return results;
}

/**
 * Get market ID for a symbol.
 * Fetches from API if not cached.
 */
async function getMarketId(symbol: string): Promise<number> {
  if (marketIds.has(symbol)) {
    return marketIds.get(symbol)!;
  }

  // Fetch all funding rates to populate cache
  await fetchLighterFundingRates();

  const id = marketIds.get(symbol);
  if (id === undefined) {
    throw new Error(`Unknown Lighter market: ${symbol}`);
  }
  return id;
}

/**
 * Fetch ticker (best bid/ask) from Lighter API.
 */
export async function fetchLighterTicker(symbol: string): Promise<LighterTicker> {
  const marketId = await getMarketId(symbol);

  const response = await fetch(
    `${BASE_URL}/api/v1/orderBookOrders?market_id=${marketId}&limit=1`
  );
  const data = (await response.json()) as {
    bids: Array<{ price: string }>;
    asks: Array<{ price: string }>;
  };

  return {
    symbol,
    bid: data.bids?.[0] ? parseFloat(data.bids[0].price) : 0,
    ask: data.asks?.[0] ? parseFloat(data.asks[0].price) : 0,
    timestamp: Date.now(),
  };
}

/**
 * Fetch order book depth from Lighter API.
 */
export async function fetchLighterOrderBook(
  symbol: string,
  limit: number = 10
): Promise<{
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}> {
  const marketId = await getMarketId(symbol);

  const response = await fetch(
    `${BASE_URL}/api/v1/orderBookOrders?market_id=${marketId}&limit=${limit}`
  );
  const data = (await response.json()) as {
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  };

  return {
    bids: (data.bids ?? []).map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    })),
    asks: (data.asks ?? []).map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    })),
  };
}

/**
 * Get all available symbols on Lighter.
 */
export async function fetchLighterSymbols(): Promise<string[]> {
  const rates = await fetchLighterFundingRates();
  return rates.map((r) => r.symbol);
}

