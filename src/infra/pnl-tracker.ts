/**
 * PnL Tracking
 *
 * Tracks trades and funding payments with persistence.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

export interface Trade {
  timestamp: number;
  symbol: string;
  exchange: "lighter" | "hyperliquid";
  side: "buy" | "sell";
  size: number;
  price: number;
  fee: number;
  isEntry: boolean;
  positionPnl?: number;
}

export interface FundingPayment {
  timestamp: number;
  symbol: string;
  exchange: "lighter" | "hyperliquid";
  amount: number;
  rate?: number;
  positionSize?: number;
}

interface PnLState {
  trades: Trade[];
  fundingPayments: FundingPayment[];
  totalRealizedPnl: number;
  totalFundingEarned: number;
  totalFeesPaid: number;
  lastUpdated: number;
  lastFundingCheck: {
    lighter: number;
    hyperliquid: number;
  };
}

export interface PnLSummary {
  realizedPnl: number;
  fundingEarned: number;
  feesPaid: number;
  netPnl: number;
  tradeCount: number;
  fundingPaymentCount: number;
}

export interface SymbolPnL {
  trades: number;
  funding: number;
  fees: number;
  net: number;
}

function createDefaultState(): PnLState {
  return {
    trades: [],
    fundingPayments: [],
    totalRealizedPnl: 0,
    totalFundingEarned: 0,
    totalFeesPaid: 0,
    lastUpdated: Date.now(),
    lastFundingCheck: { lighter: 0, hyperliquid: 0 },
  };
}

export class PnLTracker {
  private state: PnLState;

  constructor(private readonly filePath: string = ".pnl-state.json") {
    this.state = this.load() ?? createDefaultState();
  }

  recordTrade(trade: Omit<Trade, "timestamp">): void {
    this.state.trades.push({ ...trade, timestamp: Date.now() });
    this.state.totalFeesPaid += trade.fee;
    if (trade.positionPnl !== undefined) {
      this.state.totalRealizedPnl += trade.positionPnl;
    }
    this.save();
  }

  recordFundingPayment(payment: Omit<FundingPayment, "timestamp">): void {
    this.state.fundingPayments.push({ ...payment, timestamp: Date.now() });
    this.state.totalFundingEarned += payment.amount;
    this.save();
  }

  /**
   * Record multiple funding payments from exchange API.
   * Returns total amount added.
   */
  recordFundingPayments(
    exchange: "lighter" | "hyperliquid",
    payments: Array<{
      symbol: string;
      amount: number;
      timestamp: number;
      rate?: number;
      positionSize?: number;
    }>
  ): number {
    const lastCheck = this.state.lastFundingCheck[exchange];
    const newPayments = payments.filter((p) => p.timestamp > lastCheck);

    let totalAdded = 0;
    for (const payment of newPayments) {
      this.state.fundingPayments.push({
        exchange,
        symbol: payment.symbol,
        amount: payment.amount,
        timestamp: payment.timestamp,
        rate: payment.rate,
        positionSize: payment.positionSize,
      });
      this.state.totalFundingEarned += payment.amount;
      totalAdded += payment.amount;
    }

    if (newPayments.length > 0) {
      this.state.lastFundingCheck[exchange] = Math.max(
        ...newPayments.map((p) => p.timestamp)
      );
      this.save();
    }

    return totalAdded;
  }

  getLastFundingCheck(exchange: "lighter" | "hyperliquid"): number {
    return this.state.lastFundingCheck[exchange];
  }

  getSummary(): PnLSummary {
    return {
      realizedPnl: this.state.totalRealizedPnl,
      fundingEarned: this.state.totalFundingEarned,
      feesPaid: this.state.totalFeesPaid,
      netPnl:
        this.state.totalRealizedPnl +
        this.state.totalFundingEarned -
        this.state.totalFeesPaid,
      tradeCount: this.state.trades.length,
      fundingPaymentCount: this.state.fundingPayments.length,
    };
  }

  getPnlBySymbol(): Map<string, SymbolPnL> {
    const bySymbol = new Map<string, SymbolPnL>();

    for (const trade of this.state.trades) {
      const existing = bySymbol.get(trade.symbol) ?? {
        trades: 0,
        funding: 0,
        fees: 0,
        net: 0,
      };
      existing.trades += trade.positionPnl ?? 0;
      existing.fees += trade.fee;
      existing.net = existing.trades + existing.funding - existing.fees;
      bySymbol.set(trade.symbol, existing);
    }

    for (const payment of this.state.fundingPayments) {
      const existing = bySymbol.get(payment.symbol) ?? {
        trades: 0,
        funding: 0,
        fees: 0,
        net: 0,
      };
      existing.funding += payment.amount;
      existing.net = existing.trades + existing.funding - existing.fees;
      bySymbol.set(payment.symbol, existing);
    }

    return bySymbol;
  }

  getRecentTrades(limit: number = 20): Trade[] {
    return this.state.trades.slice(-limit);
  }

  getRecentFundingPayments(limit: number = 20): FundingPayment[] {
    return this.state.fundingPayments.slice(-limit);
  }

  reset(): void {
    this.state = createDefaultState();
    this.save();
  }

  private save(): void {
    this.state.lastUpdated = Date.now();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  private load(): PnLState | null {
    if (!existsSync(this.filePath)) return null;

    try {
      const data = readFileSync(this.filePath, "utf-8");
      const state = JSON.parse(data) as PnLState;

      // Ensure backwards compatibility
      state.fundingPayments ??= [];
      state.lastFundingCheck ??= { lighter: 0, hyperliquid: 0 };

      return state;
    } catch (error) {
      console.error("Failed to load PnL state:", error);
      return null;
    }
  }
}

