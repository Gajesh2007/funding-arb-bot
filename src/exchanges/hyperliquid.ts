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

  constructor(private config: HyperliquidConfig = {}) {
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

  async getSymbols(): Promise<SymbolSpec[]> {
    if (this.symbolsCache) {
      return Array.from(this.symbolsCache.values());
    }

    const meta = await this.infoClient.meta();
    const mapping = new Map<string, SymbolSpec>();

    for (const asset of meta.universe) {
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
    }

    this.symbolsCache = mapping;
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
    if (!this.exchangeClient) {
      throw new Error("Private key required for positions");
    }

    // Need wallet address - extract from private key
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(this.config.privateKey!);

    const state = await this.infoClient.clearinghouseState({
      user: account.address,
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

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.exchangeClient) {
      throw new Error("Private key required for trading");
    }

    // Get asset index
    await this.getSymbols();
    const symbols = Array.from(this.symbolsCache!.keys());
    const assetIndex = symbols.indexOf(order.symbol);
    if (assetIndex === -1) {
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
        status: "resting" in status ? "open" : "filled",
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

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    if (!this.exchangeClient) {
      throw new Error("Private key required for cancellation");
    }

    // HL cancel requires asset index - need to track this in real implementation
    throw new Error("Cancel requires asset context - not implemented yet");
  }

  async close(): Promise<void> {
    // HTTP transport doesn't need explicit cleanup
  }
}

