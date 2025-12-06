/**
 * Hyperliquid exchange connector using @nktkas/hyperliquid SDK
 */

import * as hl from "@nktkas/hyperliquid";
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

const HL_TIF_MAP: Record<OrderTimeInForce, "Gtc" | "Ioc" | "Alo"> = {
  [OrderTimeInForce.GTC]: "Gtc",
  [OrderTimeInForce.IOC]: "Ioc",
  [OrderTimeInForce.POST_ONLY]: "Alo",
};

export interface HyperliquidConfig {
  privateKey?: `0x${string}`;
  isTestnet?: boolean;
}

export class HyperliquidClient implements ExchangeClient {
  readonly name = "hyperliquid";

  private transport: hl.HttpTransport;
  private infoClient: hl.InfoClient;
  private exchangeClient?: hl.ExchangeClient;
  private symbolsCache?: Map<string, SymbolSpec>;
  private assetIndexMap?: Map<string, number>;
  private config: HyperliquidConfig;
  private walletAddress?: string;

  constructor(config: HyperliquidConfig = {}) {
    this.config = config;
    this.transport = new hl.HttpTransport({
      isTestnet: config.isTestnet ?? false,
    });
    this.infoClient = new hl.InfoClient({ transport: this.transport });

    if (config.privateKey) {
      this.exchangeClient = new hl.ExchangeClient({
        wallet: config.privateKey,
        transport: this.transport,
      });
    }
  }

  private async ensureWalletAddress(): Promise<string> {
    if (this.walletAddress) return this.walletAddress;
    if (!this.config.privateKey) throw new Error("Private key required");

    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(this.config.privateKey);
    this.walletAddress = account.address;
    return this.walletAddress;
  }

  async getSymbols(): Promise<SymbolSpec[]> {
    if (this.symbolsCache) {
      return Array.from(this.symbolsCache.values());
    }

    const meta = await this.infoClient.meta();
    const mapping = new Map<string, SymbolSpec>();
    const indexMap = new Map<string, number>();

    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i];
      const symbol = asset.name;
      const pxDecimals = asset.szDecimals ?? 4;
      const szDecimals = asset.szDecimals ?? 3;

      mapping.set(symbol, {
        symbol,
        baseAsset: symbol,
        quoteAsset: "USDC",
        tickSize: Math.pow(10, -pxDecimals),
        lotSize: Math.pow(10, -szDecimals),
        maxLeverage: asset.maxLeverage ?? 10,
      });

      indexMap.set(symbol, i);
    }

    this.symbolsCache = mapping;
    this.assetIndexMap = indexMap;
    return Array.from(mapping.values());
  }

  async getFundingRates(symbols: string[]): Promise<FundingSnapshot[]> {
    const data = await this.infoClient.metaAndAssetCtxs();
    const [meta, ctxs] = data;
    const symbolSet = new Set(symbols);
    const results: FundingSnapshot[] = [];
    const now = Date.now();

    for (let i = 0; i < ctxs.length; i++) {
      if (i >= meta.universe.length) break;

      const symbol = meta.universe[i].name;
      if (symbolSet.size > 0 && !symbolSet.has(symbol)) continue;

      const ctx = ctxs[i];
      const funding = ctx.funding;
      if (funding !== undefined) {
        // HL funding is 1hr rate
        results.push({
          symbol,
          rate: parseFloat(funding),
          nextFundingTimestamp: now + 60 * 60 * 1000, // 1hr
          lastUpdated: now,
        });
      }
    }

    return results;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const book = await this.infoClient.l2Book({ coin: symbol });
    const now = Date.now();

    const bestBid = book?.levels?.[0]?.[0];
    const bestAsk = book?.levels?.[1]?.[0];

    return {
      symbol,
      bid: bestBid ? parseFloat(bestBid.px) : 0,
      ask: bestAsk ? parseFloat(bestAsk.px) : 0,
      timestamp: now,
    };
  }

  async getPositions(): Promise<Position[]> {
    const address = await this.ensureWalletAddress();

    const state = await this.infoClient.clearinghouseState({
      user: address,
    });

    return state.assetPositions.map((ap) => {
      const pos = ap.position;
      const size = parseFloat(pos.szi);
      return {
        symbol: pos.coin,
        side: size > 0 ? Side.BUY : Side.SELL,
        size: Math.abs(size),
        entryPrice: parseFloat(pos.entryPx ?? "0"),
        leverage: parseFloat(String(pos.leverage?.value ?? 1)),
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
    withdrawable: number;
  }> {
    const address = await this.ensureWalletAddress();

    const state = await this.infoClient.clearinghouseState({
      user: address,
    });

    const marginSummary = state.marginSummary;
    const accountValue = parseFloat(marginSummary.accountValue);
    const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed);

    return {
      balance: accountValue,
      marginUsed: totalMarginUsed,
      freeMargin: accountValue - totalMarginUsed,
      withdrawable: parseFloat(state.withdrawable),
    };
  }

  /**
   * Get funding payment history
   */
  async getFundingPayments(since?: number): Promise<Array<{
    symbol: string;
    amount: number;
    timestamp: number;
    rate: number;
    positionSize: number;
  }>> {
    const address = await this.ensureWalletAddress();

    const response = await this.infoClient.userFunding({
      user: address,
      startTime: since ?? Date.now() - 7 * 24 * 60 * 60 * 1000, // Last 7 days default
    });

    return response.map((f) => ({
      symbol: f.delta.coin,
      amount: parseFloat(f.delta.usdc),
      timestamp: f.time,
      rate: parseFloat(f.delta.fundingRate),
      positionSize: parseFloat(f.delta.szi),
    }));
  }

  /**
   * Get user's recent fills/trades
   */
  async getRecentFills(symbol?: string, limit: number = 50): Promise<Array<{
    symbol: string;
    side: Side;
    size: number;
    price: number;
    fee: number;
    timestamp: number;
    orderId: string;
  }>> {
    const address = await this.ensureWalletAddress();

    const fills = await this.infoClient.userFills({
      user: address,
    });

    let filtered = fills;
    if (symbol) {
      filtered = fills.filter((f) => f.coin === symbol);
    }

    return filtered.slice(0, limit).map((f) => ({
      symbol: f.coin,
      side: f.side === "B" ? Side.BUY : Side.SELL,
      size: parseFloat(f.sz),
      price: parseFloat(f.px),
      fee: parseFloat(f.fee),
      timestamp: f.time,
      orderId: String(f.oid),
    }));
  }

  /**
   * Get fee rate for the account
   */
  async getFeeRate(): Promise<{ maker: number; taker: number }> {
    // HL fee structure - could be fetched from API but using defaults
    // Standard taker: 0.035%, maker: 0.01%
    // These can vary based on volume tier
    return {
      maker: 0.0001, // 0.01%
      taker: 0.00035, // 0.035%
    };
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.exchangeClient) {
      throw new Error("Private key required for trading");
    }

    // Get asset index
    await this.getSymbols();
    const assetIndex = this.assetIndexMap!.get(order.symbol);
    if (assetIndex === undefined) {
      throw new Error(`Unknown symbol: ${order.symbol}`);
    }

    const isBuy = order.side === Side.BUY;
    const tif = HL_TIF_MAP[order.timeInForce ?? OrderTimeInForce.GTC];

    if (order.orderType === OrderType.LIMIT) {
      if (order.price === undefined) {
        throw new Error("Limit order requires price");
      }

      const result = await this.exchangeClient.order({
        orders: [
          {
            a: assetIndex,
            b: isBuy,
            p: order.price.toString(),
            s: order.size.toString(),
            r: order.reduceOnly ?? false,
            t: { limit: { tif } },
          },
        ],
        grouping: "na",
      });

      const status = result.response.data.statuses[0];
      const filled = "filled" in status ? status.filled : undefined;

      return {
        clientId: order.clientId,
        exchangeOrderId: "resting" in status ? String(status.resting.oid) : "0",
        status: filled ? "filled" : "resting" in status ? "open" : "failed",
        filledSize: filled?.totalSz ? parseFloat(filled.totalSz) : 0,
        averageFillPrice: filled?.avgPx ? parseFloat(filled.avgPx) : undefined,
      };
    } else {
      // Market order via IOC limit at aggressive price
      const ticker = await this.getTicker(order.symbol);
      const price = isBuy ? ticker.ask * 1.01 : ticker.bid * 0.99;

      const result = await this.exchangeClient.order({
        orders: [
          {
            a: assetIndex,
            b: isBuy,
            p: price.toString(),
            s: order.size.toString(),
            r: order.reduceOnly ?? false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      });

      const status = result.response.data.statuses[0];
      const filled = "filled" in status ? status.filled : undefined;

      return {
        clientId: order.clientId,
        exchangeOrderId: "0",
        status: filled ? "filled" : "cancelled",
        filledSize: filled?.totalSz ? parseFloat(filled.totalSz) : 0,
        averageFillPrice: filled?.avgPx ? parseFloat(filled.avgPx) : undefined,
      };
    }
  }

  async cancelOrder(exchangeOrderId: string, symbol?: string): Promise<void> {
    if (!this.exchangeClient) {
      throw new Error("Private key required for cancellation");
    }

    if (!symbol) {
      throw new Error("Symbol required for cancellation on Hyperliquid");
    }

    await this.getSymbols();
    const assetIndex = this.assetIndexMap!.get(symbol);
    if (assetIndex === undefined) {
      throw new Error(`Unknown symbol: ${symbol}`);
    }

    await this.exchangeClient.cancel({
      cancels: [
        {
          a: assetIndex,
          o: parseInt(exchangeOrderId),
        },
      ],
    });
  }

  async close(): Promise<void> {
    // HTTP transport doesn't need explicit cleanup
  }
}
