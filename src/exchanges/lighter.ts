/**
 * Lighter exchange connector using lighter-ts-sdk
 */

import { SignerClient, OrderType as LighterOrderType } from "lighter-ts-sdk";
import type {
  ExchangeClient,
  FundingSnapshot,
  OrderRequest,
  OrderResult,
  Position,
  SymbolSpec,
  Ticker,
} from "./types.js";
import { Side, OrderType, OrderTimeInForce } from "./types.js";

const LIGHTER_BASE_URL = "https://mainnet.zklighter.elliot.ai";

// Market metadata - Lighter uses market indices
interface MarketMeta {
  marketIndex: number;
  priceDecimals: number;
  sizeDecimals: number;
  symbol: string;
}

interface LighterFill {
  orderId: string;
  fillSize: number;
  fillPrice: number;
  fee: number;
  timestamp: number;
}

export interface LighterConfig {
  privateKey: string;
  accountIndex?: number;
  apiKeyIndex?: number;
  baseUrl?: string;
}

export class LighterClient implements ExchangeClient {
  readonly name = "lighter";

  private signerClient: SignerClient;
  private initialized = false;
  private marketsCache?: Map<string, MarketMeta>;
  private accountAddress?: string;
  private config: LighterConfig;
  private baseUrl: string;

  constructor(config: LighterConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? LIGHTER_BASE_URL;
    this.signerClient = new SignerClient({
      url: this.baseUrl,
      privateKey: config.privateKey,
      accountIndex: config.accountIndex ?? 0,
      apiKeyIndex: config.apiKeyIndex ?? 0,
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.signerClient.initialize();
    await this.signerClient.ensureWasmClient();
    this.initialized = true;
  }

  async getSymbols(): Promise<SymbolSpec[]> {
    if (this.marketsCache) {
      return this.symbolsFromCache();
    }

    await this.ensureInitialized();

    // Fetch market info from Lighter API
    const response = await fetch(`${this.baseUrl}/api/v1/order_book_details?filter=all`);
    const data = (await response.json()) as {
      order_book_details: Array<{
        symbol: string;
        market_id: number;
        supported_price_decimals: number;
        supported_size_decimals: number;
      }>;
    };

    const mapping = new Map<string, MarketMeta>();
    const specs: SymbolSpec[] = [];

    for (const market of data.order_book_details) {
      // Lighter uses formats like "ETH/USDC" - normalize to just "ETH"
      const rawSymbol = market.symbol;
      const normalizedSymbol = rawSymbol.split("/")[0];
      
      mapping.set(normalizedSymbol, {
        marketIndex: market.market_id,
        priceDecimals: market.supported_price_decimals,
        sizeDecimals: market.supported_size_decimals,
        symbol: rawSymbol,
      });

      const [base, quote = "USDC"] = rawSymbol.split("/");
      specs.push({
        symbol: normalizedSymbol,
        baseAsset: base,
        quoteAsset: quote,
        tickSize: Math.pow(10, -market.supported_price_decimals),
        lotSize: Math.pow(10, -market.supported_size_decimals),
        maxLeverage: 10, // Default
      });
    }

    this.marketsCache = mapping;
    return specs;
  }

  private symbolsFromCache(): SymbolSpec[] {
    const specs: SymbolSpec[] = [];
    for (const [symbol, meta] of this.marketsCache!) {
      const [base, quote = "USDC"] = meta.symbol.split("/");
      specs.push({
        symbol,
        baseAsset: base,
        quoteAsset: quote,
        tickSize: Math.pow(10, -meta.priceDecimals),
        lotSize: Math.pow(10, -meta.sizeDecimals),
        maxLeverage: 10,
      });
    }
    return specs;
  }

  /**
   * Get market metadata for a symbol (handles both "ETH" and "ETH/USDC" formats)
   */
  private async getMarketMeta(symbol: string): Promise<MarketMeta> {
    await this.getSymbols(); // Ensure cache
    
    // Try normalized symbol first, then raw
    let meta = this.marketsCache!.get(symbol);
    if (!meta) {
      // Try with /USDC suffix
      meta = this.marketsCache!.get(symbol.replace("/USDC", ""));
    }
    if (!meta) {
      throw new Error(`Unknown symbol: ${symbol}`);
    }
    return meta;
  }

  async getFundingRates(symbols: string[]): Promise<FundingSnapshot[]> {
    // Fetch funding rates from Lighter API
    const response = await fetch(`${this.baseUrl}/api/v1/funding-rates`);
    const data = (await response.json()) as {
      funding_rates: Array<{
        symbol: string;
        rate: string;
        exchange: string;
      }>;
    };

    const symbolSet = new Set(symbols);
    const now = Date.now();
    const results: FundingSnapshot[] = [];

    for (const rate of data.funding_rates) {
      // Only include Lighter-native rates
      if (rate.exchange !== "lighter") continue;
      if (symbolSet.size > 0 && !symbolSet.has(rate.symbol)) continue;

      // Lighter funding is 8hr rate
      results.push({
        symbol: rate.symbol,
        rate: parseFloat(rate.rate),
        nextFundingTimestamp: now + 8 * 60 * 60 * 1000, // 8hr
        lastUpdated: now,
      });
    }

    return results;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const meta = await this.getMarketMeta(symbol);

    const response = await fetch(
      `${this.baseUrl}/api/v1/order_book?market_id=${meta.marketIndex}&limit=1`
    );
    const data = (await response.json()) as {
      bids: Array<{ price: string }>;
      asks: Array<{ price: string }>;
    };

    return {
      symbol,
      bid: data.bids[0] ? parseFloat(data.bids[0].price) : 0,
      ask: data.asks[0] ? parseFloat(data.asks[0].price) : 0,
      timestamp: Date.now(),
    };
  }

  async getPositions(): Promise<Position[]> {
    await this.ensureInitialized();

    // Fetch account info from API
    const response = await fetch(
      `${this.baseUrl}/api/v1/account?by=index&value=${this.config.accountIndex ?? 0}`
    );
    const data = (await response.json()) as {
      positions?: Array<{
        symbol: string;
        size: string;
        entry_price: string;
        max_leverage?: number;
      }>;
    };

    if (!data.positions) return [];

    return data.positions.map((pos) => {
      const size = parseFloat(pos.size);
      // Normalize symbol
      const symbol = pos.symbol.split("/")[0];
      return {
        symbol,
        side: size >= 0 ? Side.BUY : Side.SELL,
        size: Math.abs(size),
        entryPrice: parseFloat(pos.entry_price),
        leverage: pos.max_leverage ?? 1,
      };
    });
  }

  /**
   * Get account balance and margin info
   */
  async getAccountInfo(): Promise<{
    balance: number;
    marginUsed: number;
    freeMargin: number;
  }> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/account?by=index&value=${this.config.accountIndex ?? 0}`
    );
    const data = (await response.json()) as {
      balance?: string;
      margin_used?: string;
      free_collateral?: string;
    };

    return {
      balance: parseFloat(data.balance ?? "0"),
      marginUsed: parseFloat(data.margin_used ?? "0"),
      freeMargin: parseFloat(data.free_collateral ?? "0"),
    };
  }

  /**
   * Get recent trades/fills for the account
   */
  async getRecentFills(symbol?: string, limit: number = 50): Promise<LighterFill[]> {
    let url = `${this.baseUrl}/api/v1/trades?account_index=${this.config.accountIndex ?? 0}&limit=${limit}`;
    
    if (symbol) {
      const meta = await this.getMarketMeta(symbol);
      url += `&market_id=${meta.marketIndex}`;
    }

    const response = await fetch(url);
    const data = (await response.json()) as {
      trades?: Array<{
        order_id: string;
        size: string;
        price: string;
        fee: string;
        timestamp: number;
      }>;
    };

    if (!data.trades) return [];

    return data.trades.map((t) => ({
      orderId: t.order_id,
      fillSize: parseFloat(t.size),
      fillPrice: parseFloat(t.price),
      fee: parseFloat(t.fee),
      timestamp: t.timestamp,
    }));
  }

  /**
   * Get funding payments received
   */
  async getFundingPayments(since?: number): Promise<Array<{
    symbol: string;
    amount: number;
    timestamp: number;
  }>> {
    let url = `${this.baseUrl}/api/v1/funding_payments?account_index=${this.config.accountIndex ?? 0}&limit=100`;
    
    const response = await fetch(url);
    const data = (await response.json()) as {
      funding_payments?: Array<{
        symbol: string;
        amount: string;
        timestamp: number;
      }>;
    };

    if (!data.funding_payments) return [];

    const payments = data.funding_payments.map((p) => ({
      symbol: p.symbol.split("/")[0],
      amount: parseFloat(p.amount),
      timestamp: p.timestamp,
    }));

    if (since) {
      return payments.filter((p) => p.timestamp > since);
    }
    return payments;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    await this.ensureInitialized();
    const meta = await this.getMarketMeta(order.symbol);

    const baseAmount = Math.round(order.size * Math.pow(10, meta.sizeDecimals));
    const isAsk = order.side === Side.SELL;

    // Store position before order to detect fills
    const positionsBefore = await this.getPositions();
    const posBefore = positionsBefore.find((p) => p.symbol === order.symbol);
    const sizeBefore = posBefore ? (posBefore.side === Side.BUY ? posBefore.size : -posBefore.size) : 0;

    let result;
    let submittedAt = Date.now();

    if (order.orderType === OrderType.LIMIT) {
      if (order.price === undefined) {
        throw new Error("Limit order requires price");
      }

      const price = Math.round(order.price * Math.pow(10, meta.priceDecimals));

      result = await this.signerClient.createUnifiedOrder({
        marketIndex: meta.marketIndex,
        clientOrderIndex: Date.now(),
        baseAmount,
        price,
        isAsk,
        orderType: LighterOrderType.LIMIT,
        orderExpiry: Date.now() + 60 * 60 * 1000, // 1hr
      });
    } else {
      // Market order
      const ticker = await this.getTicker(order.symbol);
      const idealPrice = Math.round(
        (isAsk ? ticker.bid : ticker.ask) * Math.pow(10, meta.priceDecimals)
      );

      result = await this.signerClient.createUnifiedOrder({
        marketIndex: meta.marketIndex,
        clientOrderIndex: Date.now(),
        baseAmount,
        isAsk,
        orderType: LighterOrderType.MARKET,
        idealPrice,
        maxSlippage: 0.01, // 1% slippage
      });
    }

    // Wait a moment for the order to process
    await this.sleep(300);

    // Check position after to detect fill
    const positionsAfter = await this.getPositions();
    const posAfter = positionsAfter.find((p) => p.symbol === order.symbol);
    const sizeAfter = posAfter ? (posAfter.side === Side.BUY ? posAfter.size : -posAfter.size) : 0;

    // Calculate filled size from position change
    const sizeChange = Math.abs(sizeAfter - sizeBefore);
    const filled = sizeChange > 0;

    // Try to get actual fill price from recent trades
    let avgFillPrice = order.price;
    if (filled) {
      try {
        const fills = await this.getRecentFills(order.symbol, 5);
        const recentFill = fills.find((f) => f.timestamp >= submittedAt - 1000);
        if (recentFill) {
          avgFillPrice = recentFill.fillPrice;
        } else if (posAfter) {
          avgFillPrice = posAfter.entryPrice;
        }
      } catch {
        // Use position entry price as fallback
        if (posAfter) {
          avgFillPrice = posAfter.entryPrice;
        }
      }
    }

    return {
      clientId: order.clientId,
      exchangeOrderId: result.mainOrder.hash ?? "0",
      status: filled ? "filled" : result.success ? "submitted" : "failed",
      filledSize: filled ? sizeChange : 0,
      averageFillPrice: avgFillPrice,
    };
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    await this.ensureInitialized();

    const [marketIndex, orderIndex] = exchangeOrderId.split(":").map(Number);
    await this.signerClient.cancelOrder({
      marketIndex,
      orderIndex,
    });
  }

  async close(): Promise<void> {
    if (this.initialized) {
      await this.signerClient.close();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
