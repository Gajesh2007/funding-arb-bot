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

  constructor(private config: LighterConfig) {
    this.signerClient = new SignerClient({
      url: config.baseUrl ?? LIGHTER_BASE_URL,
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
    const response = await fetch(
      `${this.config.baseUrl ?? LIGHTER_BASE_URL}/api/v1/order_book_details?filter=all`
    );
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
      const symbol = market.symbol;
      mapping.set(symbol, {
        marketIndex: market.market_id,
        priceDecimals: market.supported_price_decimals,
        sizeDecimals: market.supported_size_decimals,
      });

      const [base, quote = "USDC"] = symbol.split("/");
      specs.push({
        symbol,
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
      const [base, quote = "USDC"] = symbol.split("/");
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

  async getFundingRates(symbols: string[]): Promise<FundingSnapshot[]> {
    // Fetch funding rates from Lighter API
    const response = await fetch(
      `${this.config.baseUrl ?? LIGHTER_BASE_URL}/api/v1/funding-rates`
    );
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
    await this.getSymbols(); // Ensure cache
    const meta = this.marketsCache!.get(symbol);
    if (!meta) {
      throw new Error(`Unknown symbol: ${symbol}`);
    }

    const response = await fetch(
      `${this.config.baseUrl ?? LIGHTER_BASE_URL}/api/v1/order_book?market_id=${meta.marketIndex}&limit=1`
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
      `${this.config.baseUrl ?? LIGHTER_BASE_URL}/api/v1/account?by=index&value=${this.config.accountIndex ?? 0}`
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
      return {
        symbol: pos.symbol,
        side: size >= 0 ? Side.BUY : Side.SELL,
        size: Math.abs(size),
        entryPrice: parseFloat(pos.entry_price),
        leverage: pos.max_leverage ?? 1,
      };
    });
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    await this.ensureInitialized();
    await this.getSymbols();

    const meta = this.marketsCache!.get(order.symbol);
    if (!meta) {
      throw new Error(`Unknown symbol: ${order.symbol}`);
    }

    const baseAmount = Math.round(
      order.size * Math.pow(10, meta.sizeDecimals)
    );
    const isAsk = order.side === Side.SELL;

    if (order.orderType === OrderType.LIMIT) {
      if (order.price === undefined) {
        throw new Error("Limit order requires price");
      }

      const price = Math.round(
        order.price * Math.pow(10, meta.priceDecimals)
      );

      const result = await this.signerClient.createUnifiedOrder({
        marketIndex: meta.marketIndex,
        clientOrderIndex: Date.now(),
        baseAmount,
        price,
        isAsk,
        orderType: LighterOrderType.LIMIT,
        orderExpiry: Date.now() + 60 * 60 * 1000, // 1hr
      });

      return {
        clientId: order.clientId,
        exchangeOrderId: result.mainOrder.hash ?? "0",
        status: result.success ? "submitted" : "failed",
        filledSize: 0, // Need to poll for fills
        averageFillPrice: undefined,
      };
    } else {
      // Market order
      const ticker = await this.getTicker(order.symbol);
      const idealPrice = Math.round(
        (isAsk ? ticker.bid : ticker.ask) * Math.pow(10, meta.priceDecimals)
      );

      const result = await this.signerClient.createUnifiedOrder({
        marketIndex: meta.marketIndex,
        clientOrderIndex: Date.now(),
        baseAmount,
        isAsk,
        orderType: LighterOrderType.MARKET,
        idealPrice,
        maxSlippage: 0.01, // 1% slippage
      });

      return {
        clientId: order.clientId,
        exchangeOrderId: result.mainOrder.hash ?? "0",
        status: result.success ? "submitted" : "failed",
        filledSize: 0,
        averageFillPrice: undefined,
      };
    }
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
}

