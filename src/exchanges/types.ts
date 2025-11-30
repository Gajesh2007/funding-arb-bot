/**
 * Core types for exchange connectors
 */

export enum Side {
  BUY = "buy",
  SELL = "sell",
}

export enum OrderType {
  MARKET = "market",
  LIMIT = "limit",
}

export enum OrderTimeInForce {
  IOC = "ioc",
  GTC = "gtc",
  POST_ONLY = "post_only",
}

export interface SymbolSpec {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  lotSize: number;
  maxLeverage: number;
}

export interface FundingSnapshot {
  symbol: string;
  /** Funding rate (decimal, e.g., 0.0001 = 0.01%) */
  rate: number;
  /** Next funding timestamp in ms */
  nextFundingTimestamp: number;
  /** Last update timestamp in ms */
  lastUpdated: number;
}

export interface Ticker {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface Position {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  leverage: number;
}

export interface OrderRequest {
  clientId: string;
  symbol: string;
  side: Side;
  size: number;
  orderType: OrderType;
  price?: number;
  reduceOnly?: boolean;
  timeInForce?: OrderTimeInForce;
}

export interface OrderResult {
  clientId: string;
  exchangeOrderId: string;
  status: string;
  filledSize: number;
  averageFillPrice?: number;
}

/**
 * Common interface for exchange connectors
 */
export interface ExchangeClient {
  readonly name: string;

  /** Get all tradable symbol specifications */
  getSymbols(): Promise<SymbolSpec[]>;

  /** Get current funding rates for symbols */
  getFundingRates(symbols: string[]): Promise<FundingSnapshot[]>;

  /** Get current ticker data */
  getTicker(symbol: string): Promise<Ticker>;

  /** Get current open positions */
  getPositions(): Promise<Position[]>;

  /** Place an order */
  placeOrder(order: OrderRequest): Promise<OrderResult>;

  /** Cancel an order */
  cancelOrder(exchangeOrderId: string): Promise<void>;

  /** Clean up resources */
  close(): Promise<void>;
}

