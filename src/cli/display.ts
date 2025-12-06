/**
 * Console Display Helpers
 *
 * Formatting functions for CLI output.
 */

import chalk from "chalk";

// ============================================================================
// Logging
// ============================================================================

export function log(message: string): void {
  console.log(message);
}

export function logInfo(message: string): void {
  console.log(chalk.cyan(message));
}

export function logSuccess(message: string): void {
  console.log(chalk.green(message));
}

export function logWarning(message: string): void {
  console.log(chalk.yellow(`⚠️  ${message}`));
}

export function logError(message: string): void {
  console.error(chalk.red(`❌ ${message}`));
}

export function logDim(message: string): void {
  console.log(chalk.dim(message));
}

// ============================================================================
// Opportunity Table
// ============================================================================

export interface Opportunity {
  symbol: string;
  hlRate8hr: number;
  lighterRate8hr: number;
  edgeBps: number;
  apy: number;
  direction: string;
}

export function printOpportunityHeader(): void {
  const header = [
    chalk.bold("Symbol".padEnd(10)),
    chalk.bold("HL 8hr %".padStart(12)),
    chalk.bold("Ltr 8hr %".padStart(12)),
    chalk.bold("Edge".padStart(10)),
    chalk.bold("APY %".padStart(10)),
    chalk.bold("Direction".padEnd(35)),
  ].join(" ");

  console.log(header);
  console.log("=".repeat(100));
}

export function printOpportunity(opp: Opportunity): void {
  const edgeColor = opp.edgeBps > 0 ? chalk.green : chalk.red;
  const apyColor = opp.apy > 100 ? chalk.yellow : chalk.white;

  const row = [
    opp.symbol.padEnd(10),
    (opp.hlRate8hr * 100).toFixed(6).padStart(11),
    (opp.lighterRate8hr * 100).toFixed(6).padStart(11),
    edgeColor(opp.edgeBps.toFixed(2).padStart(9)),
    apyColor(opp.apy.toFixed(1).padStart(9)),
    opp.direction.padEnd(35),
  ].join(" ");

  console.log(row);
}

// ============================================================================
// Config Display
// ============================================================================

export function printConfig(config: {
  minEdgeBps: number;
  exitEdgeBps: number;
  orderNotionalUsd: number;
  maxTotalNotionalUsd: number;
  symbols: string[] | string;
  pollIntervalMs: number;
  mode: string;
  leverage: number;
}): void {
  logDim("Strategy Config:");
  logDim(`  Min Edge: ${config.minEdgeBps} bps`);
  logDim(`  Exit Edge: ${config.exitEdgeBps} bps`);
  logDim(`  Order Size: $${config.orderNotionalUsd}`);
  logDim(`  Max Notional: $${config.maxTotalNotionalUsd}`);
  logDim(`  Leverage: ${config.leverage}x`);
  logDim(`  Symbols: ${Array.isArray(config.symbols) ? config.symbols.join(", ") : config.symbols}`);
  logDim(`  Poll Interval: ${config.pollIntervalMs / 1000}s`);
  logDim(`  Mode: ${config.mode}`);
}

export function printRiskLimits(limits: {
  leverage: number;
  maintenanceMarginRate: number;
  stopLossUsd: number;
  stopLossPct: number;
  takeProfitUsd: number;
  takeProfitPct: number;
  maxHoldTimeHours: number;
  maxPriceDivergencePct: number;
  maxDrawdownUsd: number;
  liquidationBufferPct: number;
}): void {
  // Calculate liquidation threshold for display
  const initialMarginRate = 1 / limits.leverage;
  const maxLossBeforeLiq = (initialMarginRate - limits.maintenanceMarginRate) * 100;
  
  logDim("\nRisk Limits:");
  logDim(`  Leverage: ${limits.leverage}x (${(initialMarginRate * 100).toFixed(0)}% initial margin)`);
  logDim(`  Liquidation: at ~${maxLossBeforeLiq.toFixed(0)}% loss per leg, exit at ${((1 - limits.liquidationBufferPct) * maxLossBeforeLiq).toFixed(0)}%`);
  logDim(`  Stop-Loss: $${limits.stopLossUsd} or ${(limits.stopLossPct * 100).toFixed(0)}% of notional`);
  logDim(`  Take-Profit: $${limits.takeProfitUsd} or ${(limits.takeProfitPct * 100).toFixed(0)}% of notional`);
  logDim(`  Max Hold Time: ${limits.maxHoldTimeHours > 0 ? `${limits.maxHoldTimeHours}h` : "disabled"}`);
  logDim(`  Max Price Divergence: ${(limits.maxPriceDivergencePct * 100).toFixed(1)}%`);
  logDim(`  Max Portfolio Drawdown: $${limits.maxDrawdownUsd}`);
}

// ============================================================================
// PnL Display
// ============================================================================

export interface PnLSummary {
  realizedPnl: number;
  fundingEarned: number;
  feesPaid: number;
  netPnl: number;
  tradeCount: number;
  fundingPaymentCount: number;
}

export function printPnlSummary(summary: PnLSummary): void {
  logInfo("\n📊 PnL Summary\n");
  log(`  Realized PnL:    $${summary.realizedPnl.toFixed(2)}`);
  log(`  Funding Earned:  $${summary.fundingEarned.toFixed(2)}`);
  log(`  Fees Paid:       -$${summary.feesPaid.toFixed(2)}`);
  log(chalk.bold(`  Net PnL:         $${summary.netPnl.toFixed(2)}`));
  log(`  Total Trades:    ${summary.tradeCount}`);
  log(`  Funding Payments: ${summary.fundingPaymentCount}\n`);
}

export function printSymbolPnl(
  bySymbol: Map<string, { trades: number; funding: number; fees: number; net: number }>
): void {
  if (bySymbol.size === 0) return;

  logDim("PnL by Symbol:");
  for (const [symbol, data] of bySymbol) {
    const color = data.net >= 0 ? chalk.green : chalk.red;
    log(
      `  ${symbol.padEnd(8)} Trades: ${color(`$${data.trades.toFixed(2)}`)} | ` +
        `Funding: $${data.funding.toFixed(2)} | Fees: -$${data.fees.toFixed(2)} | ` +
        `Net: ${color(`$${data.net.toFixed(2)}`)}`
    );
  }
  log("");
}

// ============================================================================
// Trade Display
// ============================================================================

export interface Trade {
  timestamp: number;
  symbol: string;
  exchange: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  positionPnl?: number;
}

export function printRecentTrades(trades: Trade[]): void {
  if (trades.length === 0) return;

  logDim("Recent trades:");
  for (const trade of trades) {
    const time = new Date(trade.timestamp).toLocaleString();
    const side = trade.side === "buy" ? chalk.green("BUY") : chalk.red("SELL");
    const pnl = trade.positionPnl !== undefined ? chalk.dim(` PnL: $${trade.positionPnl.toFixed(2)}`) : "";
    log(
      `  ${time} ${trade.exchange.padEnd(12)} ${trade.symbol.padEnd(6)} ${side} ` +
        `${trade.size.toFixed(4)} @ $${trade.price.toFixed(2)}${pnl}`
    );
  }
}

export interface FundingPayment {
  timestamp: number;
  symbol: string;
  exchange: string;
  amount: number;
}

export function printRecentFundingPayments(payments: FundingPayment[]): void {
  if (payments.length === 0) return;

  logDim("\nRecent funding payments:");
  for (const payment of payments) {
    const time = new Date(payment.timestamp).toLocaleString();
    const color = payment.amount >= 0 ? chalk.green : chalk.red;
    log(`  ${time} ${payment.exchange.padEnd(12)} ${payment.symbol.padEnd(6)} ${color(`$${payment.amount.toFixed(4)}`)}`);
  }
}

// ============================================================================
// Status Display
// ============================================================================

export function printStatus(status: {
  positionCount: number;
  totalNotional: number;
  minutesToFunding: number;
  totalRealizedPnl?: number;
}): void {
  let statusLine = `\n📊 Positions: ${status.positionCount} | ` +
    `Notional: $${status.totalNotional.toFixed(0)} | ` +
    `Next funding: ${status.minutesToFunding}m`;

  if (status.totalRealizedPnl !== undefined) {
    const pnlColor = status.totalRealizedPnl >= 0 ? chalk.green : chalk.red;
    statusLine += ` | Realized: ${pnlColor(`$${status.totalRealizedPnl.toFixed(2)}`)}`;
  }

  logDim(statusLine);
}

// ============================================================================
// Discovery Display
// ============================================================================

export interface DiscoveredOpportunity {
  symbol: string;
  edgeBps: number;
  apy: number;
  direction: string;
}

export function printDiscoveredOpportunities(opportunities: DiscoveredOpportunity[]): void {
  logSuccess(`\n✅ Found ${opportunities.length} opportunities:\n`);
  for (const opp of opportunities.slice(0, 5)) {
    const dir = opp.direction === "long_lighter_short_hl" ? "L→S" : "S→L";
    logDim(
      `   ${opp.symbol.padEnd(8)} ${opp.edgeBps.toFixed(1).padStart(6)} bps  ` +
        `${opp.apy.toFixed(0).padStart(4)}% APY  ${dir}`
    );
  }
  log("");
}
