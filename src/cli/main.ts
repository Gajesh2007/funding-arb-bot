#!/usr/bin/env node
/**
 * Funding Arbitrage Bot CLI
 *
 * Commands for scanning opportunities and running the trading bot.
 */

import { Command } from "commander";
import dotenv from "dotenv";
import { HyperliquidClient } from "../exchanges/hyperliquid.js";
import { LighterClient } from "../exchanges/lighter.js";
import { fetchLighterFundingRates } from "../exchanges/lighter-api.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "../strategy/types.js";
import { PnLTracker } from "../infra/pnl-tracker.js";
import { RateLimiter } from "../infra/rate-limiter.js";
import { runBot, createBotContext, saveBotState, type BotCallbacks } from "../bot/runner.js";
import {
  log,
  logInfo,
  logSuccess,
  logWarning,
  logError,
  logDim,
  printOpportunityHeader,
  printOpportunity,
  printConfig,
  printRiskLimits,
  printPnlSummary,
  printSymbolPnl,
  printRecentTrades,
  printRecentFundingPayments,
  printStatus,
  type Opportunity,
} from "./display.js";

dotenv.config();

const program = new Command();

program
  .name("funding-arb")
  .description("Funding rate arbitrage bot for Hyperliquid and Lighter")
  .version("1.0.0");

// ============================================================================
// SPOT Command - Read-only opportunity scanning
// ============================================================================
program
  .command("spot")
  .description("Scan for funding arbitrage opportunities (read-only)")
  .option("-e, --min-edge <bps>", "Minimum edge in basis points", "20")
  .option("-s, --symbols <symbols...>", "Symbols to track (default: all common)")
  .option("-v, --verbose", "Show all compared symbols")
  .option("-i, --interval <seconds>", "Scan interval in seconds", "60")
  .option("--once", "Run scan once and exit")
  .action(async (options) => {
    const minEdgeBps = parseFloat(options.minEdge);
    const symbols = options.symbols ?? [];
    const verbose = options.verbose ?? false;
    const interval = parseInt(options.interval) * 1000;
    const runOnce = options.once ?? false;

    logInfo(`\n🔍 Scanning for funding arb opportunities (min edge: ${minEdgeBps} bps)...\n`);
    logDim("Note: All rates normalized to 8hr for comparison (HL native=1hr, Lighter native=8hr)\n");

    printOpportunityHeader();

    const hlClient = new HyperliquidClient({});
    const rateLimiter = new RateLimiter(100, 50);

    try {
      while (true) {
        await rateLimiter.throttle("scan");
        const opportunities = await scanOpportunities(hlClient, symbols, minEdgeBps, verbose);

        if (opportunities.length > 0) {
          opportunities.sort((a, b) => Math.abs(b.edgeBps) - Math.abs(a.edgeBps));
          for (const opp of opportunities) {
            printOpportunity(opp);
          }
          logSuccess(`\n✅ Found ${opportunities.length} opportunities at ${new Date().toLocaleTimeString()}\n`);
        } else {
          logWarning(`No opportunities found at ${new Date().toLocaleTimeString()}`);
        }

        if (runOnce) break;
        await sleep(interval);
      }
    } catch (error) {
      if ((error as Error).message !== "SIGINT") {
        logError(`Error: ${error}`);
      }
    } finally {
      await hlClient.close();
      logDim("\nStopped scanning.");
    }
  });

// ============================================================================
// RATES Command - Show current funding rates
// ============================================================================
program
  .command("rates")
  .description("Show current funding rates from both exchanges")
  .option("-s, --symbols <symbols...>", "Symbols to show")
  .action(async (options) => {
    const symbols = options.symbols ?? [];

    logInfo("\n📊 Current Funding Rates\n");

    const hlClient = new HyperliquidClient({});

    try {
      log("Hyperliquid (1hr rates):");
      const hlRates = await hlClient.getFundingRates(symbols);
      for (const rate of hlRates.slice(0, 20)) {
        const pct = (rate.rate * 100).toFixed(6);
        const prefix = rate.rate > 0 ? "+" : "";
        log(`  ${rate.symbol.padEnd(10)} ${prefix}${pct.padStart(11)}%`);
      }

      log("\nLighter (8hr rates):");
      const lighterRates = await fetchLighterFundingRates(symbols);
      for (const rate of lighterRates.slice(0, 20)) {
        const pct = (rate.rate * 100).toFixed(6);
        const prefix = rate.rate > 0 ? "+" : "";
        log(`  ${rate.symbol.padEnd(10)} ${prefix}${pct.padStart(11)}%`);
      }
    } finally {
      await hlClient.close();
    }
  });

// ============================================================================
// RUN Command - Live trading bot
// ============================================================================
program
  .command("run")
  .description("Start the live trading bot")
  // Strategy options
  .option("-e, --min-edge <bps>", "Minimum edge to enter (bps)", "20")
  .option("-x, --exit-edge <bps>", "Edge threshold to exit (bps)", "5")
  .option("-n, --notional <usd>", "Order notional size in USD", "500")
  .option("-m, --max-notional <usd>", "Max total notional", "10000")
  .option("-s, --symbols <symbols...>", "Symbols to trade (ignored if --auto)")
  .option("-a, --auto", "Auto-discover best opportunities (default)")
  .option("--max-symbols <n>", "Max symbols to track in auto mode", "5")
  .option("-i, --interval <seconds>", "Poll interval in seconds", "30")
  .option("-v, --verbose", "Show detailed status on each poll")
  .option("--dry-run", "Simulate trades without executing")
  // Leverage options
  .option("-l, --leverage <x>", "Target leverage (e.g., 2 = 2x)", String(DEFAULT_STRATEGY_CONFIG.leverage))
  // Risk limit options
  .option("--stop-loss <usd>", "Stop-loss per position in USD", String(DEFAULT_STRATEGY_CONFIG.stopLossUsd))
  .option("--stop-loss-pct <pct>", "Stop-loss as % of notional (e.g., 0.2 = 20%)", String(DEFAULT_STRATEGY_CONFIG.stopLossPct))
  .option("--take-profit <usd>", "Take-profit per position in USD", String(DEFAULT_STRATEGY_CONFIG.takeProfitUsd))
  .option("--take-profit-pct <pct>", "Take-profit as % of notional", String(DEFAULT_STRATEGY_CONFIG.takeProfitPct))
  .option("--max-hold <hours>", "Max hold time in hours (0 = disabled)", String(DEFAULT_STRATEGY_CONFIG.maxHoldTimeHours))
  .option("--max-divergence <pct>", "Max price divergence between exchanges", String(DEFAULT_STRATEGY_CONFIG.maxPriceDivergencePct))
  .option("--max-drawdown <usd>", "Max portfolio drawdown before kill switch", String(DEFAULT_STRATEGY_CONFIG.maxDrawdownUsd))
  .option("--liq-buffer <pct>", "Buffer before liquidation to exit (e.g., 0.2 = 20%)", String(DEFAULT_STRATEGY_CONFIG.liquidationBufferPct))
  .action(async (options) => {
    const hlPrivateKey = process.env.HYPERLIQUID_PRIVATE_KEY as `0x${string}` | undefined;
    const lighterPrivateKey = process.env.LIGHTER_PRIVATE_KEY;
    const dryRun = options.dryRun ?? false;

    if (!dryRun && (!hlPrivateKey || !lighterPrivateKey)) {
      logError("\nMissing credentials. Set HYPERLIQUID_PRIVATE_KEY and LIGHTER_PRIVATE_KEY in .env\n");
      process.exit(1);
    }

    const autoDiscover = options.auto ?? !options.symbols;
    const symbols = options.symbols ?? ["ETH", "BTC", "SOL"];

    const strategyConfig: StrategyConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      minEdgeBps: parseFloat(options.minEdge),
      exitEdgeBps: parseFloat(options.exitEdge),
      orderNotionalUsd: parseFloat(options.notional),
      maxTotalNotionalUsd: parseFloat(options.maxNotional),
      symbols,
      // Leverage
      leverage: parseFloat(options.leverage),
      // Risk limits
      stopLossUsd: parseFloat(options.stopLoss),
      stopLossPct: parseFloat(options.stopLossPct),
      takeProfitUsd: parseFloat(options.takeProfit),
      takeProfitPct: parseFloat(options.takeProfitPct),
      maxHoldTimeHours: parseFloat(options.maxHold),
      maxPriceDivergencePct: parseFloat(options.maxDivergence),
      maxDrawdownUsd: parseFloat(options.maxDrawdown),
      liquidationBufferPct: parseFloat(options.liqBuffer),
    };

    logInfo("\n🤖 Starting Funding Arbitrage Bot\n");
    
    printConfig({
      minEdgeBps: strategyConfig.minEdgeBps,
      exitEdgeBps: strategyConfig.exitEdgeBps,
      orderNotionalUsd: strategyConfig.orderNotionalUsd,
      maxTotalNotionalUsd: strategyConfig.maxTotalNotionalUsd,
      symbols: autoDiscover ? `AUTO (max ${options.maxSymbols})` : symbols.join(", "),
      pollIntervalMs: parseInt(options.interval) * 1000,
      mode: dryRun ? "DRY RUN (no real trades)" : "LIVE TRADING",
      leverage: strategyConfig.leverage,
    });

    printRiskLimits({
      leverage: strategyConfig.leverage,
      maintenanceMarginRate: strategyConfig.maintenanceMarginRate,
      stopLossUsd: strategyConfig.stopLossUsd,
      stopLossPct: strategyConfig.stopLossPct,
      takeProfitUsd: strategyConfig.takeProfitUsd,
      takeProfitPct: strategyConfig.takeProfitPct,
      maxHoldTimeHours: strategyConfig.maxHoldTimeHours,
      maxPriceDivergencePct: strategyConfig.maxPriceDivergencePct,
      maxDrawdownUsd: strategyConfig.maxDrawdownUsd,
      liquidationBufferPct: strategyConfig.liquidationBufferPct,
    });
    
    log("");

    if (!dryRun) {
      logWarning("LIVE TRADING MODE - Real money at risk!\n");
      await sleep(3000);
    }

    // Initialize clients
    const hlClient = new HyperliquidClient({
      privateKey: dryRun ? undefined : hlPrivateKey,
    });

    let lighterClient: LighterClient | null = null;
    if (!dryRun && lighterPrivateKey) {
      lighterClient = new LighterClient({
        privateKey: lighterPrivateKey,
        accountIndex: parseInt(process.env.LIGHTER_ACCOUNT_INDEX ?? "0"),
        apiKeyIndex: parseInt(process.env.LIGHTER_API_KEY_INDEX ?? "0"),
      });
    }

    // Create bot context
    const ctx = createBotContext(
      {
        strategy: strategyConfig,
        pollIntervalMs: parseInt(options.interval) * 1000,
        dryRun,
        verbose: options.verbose ?? false,
        autoDiscover,
        maxSymbols: parseInt(options.maxSymbols),
      },
      hlClient,
      lighterClient
    );

    // Set up abort controller for graceful shutdown
    const abortController = new AbortController();

    const shutdown = async () => {
      logDim("\n\nShutting down...");
      abortController.abort();

      saveBotState(ctx);
      logSuccess("💾 State saved to disk");

      const pnl = ctx.pnlTracker.getSummary();
      printPnlSummary(pnl);

      await hlClient.close();
      if (lighterClient) await lighterClient.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Callbacks for bot events
    const callbacks: BotCallbacks = {
      onLog: (msg) => log(msg),
      onWarn: (msg) => logWarning(msg),
      onError: (msg) => logError(msg),
      onStatusUpdate: (status) => {
        if (status.positionCount > 0 || options.verbose) {
          printStatus(status);
        }
      },
    };

    logDim("Starting main loop... (warming up funding history)\n");

    await runBot(
      {
        strategy: strategyConfig,
        pollIntervalMs: parseInt(options.interval) * 1000,
        dryRun,
        verbose: options.verbose ?? false,
        autoDiscover,
        maxSymbols: parseInt(options.maxSymbols),
      },
      ctx,
      callbacks,
      abortController.signal
    );

    await shutdown();
  });

// ============================================================================
// PNL Command - Show PnL summary
// ============================================================================
program
  .command("pnl")
  .description("Show PnL summary")
  .option("--by-symbol", "Show breakdown by symbol")
  .action((options) => {
    const pnlTracker = new PnLTracker();
    const summary = pnlTracker.getSummary();

    printPnlSummary(summary);

    if (options.bySymbol) {
      printSymbolPnl(pnlTracker.getPnlBySymbol());
    }

    printRecentTrades(pnlTracker.getRecentTrades(10));
    printRecentFundingPayments(pnlTracker.getRecentFundingPayments(5));
  });

// ============================================================================
// Helper Functions
// ============================================================================

async function scanOpportunities(
  hlClient: HyperliquidClient,
  symbols: string[],
  minEdgeBps: number,
  verbose: boolean
): Promise<Opportunity[]> {
  const [hlRates, lighterRates] = await Promise.all([
    hlClient.getFundingRates([]),
    fetchLighterFundingRates(),
  ]);

  const hlRateMap = new Map(hlRates.map((r) => [r.symbol, r.rate]));
  const lighterRateMap = new Map(lighterRates.map((r) => [r.symbol, r.rate]));

  const symbolsToCheck =
    symbols.length > 0
      ? new Set(symbols)
      : new Set([...hlRateMap.keys()].filter((s) => lighterRateMap.has(s)));

  const opportunities: Opportunity[] = [];
  const compared: Array<{ symbol: string; hlRate8hr: number; lighterRate8hr: number; edgeBps: number }> = [];

  for (const symbol of symbolsToCheck) {
    const hlRate1hr = hlRateMap.get(symbol);
    const lighterRate8hr = lighterRateMap.get(symbol);

    if (hlRate1hr === undefined || lighterRate8hr === undefined) continue;
    if (hlRate1hr === 0 && lighterRate8hr === 0) continue;

    const hlRate8hr = hlRate1hr * 8;
    const edgeBps = (hlRate8hr - lighterRate8hr) * 10000;
    const apy = (Math.abs(edgeBps) * 3 * 365) / 100;

    compared.push({ symbol, hlRate8hr, lighterRate8hr, edgeBps });

    if (Math.abs(edgeBps) >= minEdgeBps) {
      opportunities.push({
        symbol,
        hlRate8hr,
        lighterRate8hr,
        edgeBps,
        apy,
        direction: edgeBps > 0 ? "Long Lighter / Short Hyperliquid" : "Long Hyperliquid / Short Lighter",
      });
    }
  }

  if (verbose && compared.length > 0) {
    logDim(`\nCompared ${compared.length} symbols available on both exchanges`);
    compared.sort((a, b) => Math.abs(b.edgeBps) - Math.abs(a.edgeBps));
    for (const c of compared.slice(0, 10)) {
      logDim(
        `  ${c.symbol.padEnd(10)} HL:${(c.hlRate8hr * 100).toFixed(4).padStart(8)}% ` +
          `Ltr:${(c.lighterRate8hr * 100).toFixed(4).padStart(8)}% Edge:${c.edgeBps.toFixed(2).padStart(7)}bps`
      );
    }
    log("");
  }

  return opportunities;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => {
  logDim("\n\nReceived SIGINT, shutting down...");
  process.exit(0);
});

program.parse();
