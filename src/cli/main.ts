#!/usr/bin/env node
/**
 * Funding Arbitrage Bot CLI
 *
 * Scans for funding rate arbitrage opportunities between Hyperliquid and Lighter
 */

import { Command } from "commander";
import chalk from "chalk";
import dotenv from "dotenv";
import { HyperliquidClient } from "../exchanges/hyperliquid.js";
import { LighterClient } from "../exchanges/lighter.js";

dotenv.config();

interface Opportunity {
  symbol: string;
  hlRate8hr: number;
  lighterRate8hr: number;
  edgeBps: number;
  apy: number;
  direction: string;
}

const program = new Command();

program
  .name("funding-arb")
  .description("Funding rate arbitrage bot for Hyperliquid and Lighter")
  .version("1.0.0");

program
  .command("spot")
  .description("Continuously spot funding arbitrage opportunities without trading")
  .option("-e, --min-edge <bps>", "Minimum funding rate edge in basis points", "20")
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

    console.log(
      chalk.cyan(`\n🔍 Scanning for funding arb opportunities (min edge: ${minEdgeBps} bps)...\n`)
    );
    console.log(
      chalk.dim(
        "Note: All rates normalized to 8hr for comparison (HL native=1hr, Lighter native=8hr)\n"
      )
    );

    printHeader();

    const hlClient = new HyperliquidClient({});
    const lighterPrivateKey = process.env.LIGHTER_PRIVATE_KEY || process.env.API_PRIVATE_KEY;

    // For spot-only mode, we don't need Lighter auth - just funding rates
    // But we'll use direct API calls for funding rates

    try {
      while (true) {
        const opportunities = await scanOpportunities(
          hlClient,
          symbols,
          minEdgeBps,
          verbose
        );

        if (opportunities.length > 0) {
          opportunities.sort((a, b) => Math.abs(b.edgeBps) - Math.abs(a.edgeBps));
          for (const opp of opportunities) {
            printOpportunity(opp);
          }
          console.log(
            chalk.green(
              `\n✅ Found ${opportunities.length} opportunities at ${new Date().toLocaleTimeString()}\n`
            )
          );
        } else {
          console.log(
            chalk.yellow(`No opportunities found at ${new Date().toLocaleTimeString()}`)
          );
        }

        if (runOnce) break;
        await sleep(interval);
      }
    } catch (error) {
      if ((error as Error).message !== "SIGINT") {
        console.error(chalk.red("\n❌ Error:"), error);
      }
    } finally {
      await hlClient.close();
      console.log(chalk.dim("\nStopped scanning."));
    }
  });

program
  .command("rates")
  .description("Show current funding rates from both exchanges")
  .option("-s, --symbols <symbols...>", "Symbols to show")
  .action(async (options) => {
    const symbols = options.symbols ?? [];

    console.log(chalk.cyan("\n📊 Current Funding Rates\n"));

    const hlClient = new HyperliquidClient({});

    try {
      // Fetch Hyperliquid rates
      console.log(chalk.bold("Hyperliquid (1hr rates):"));
      const hlRates = await hlClient.getFundingRates(symbols);
      for (const rate of hlRates.slice(0, 20)) {
        const pct = (rate.rate * 100).toFixed(6);
        const color = rate.rate > 0 ? chalk.green : rate.rate < 0 ? chalk.red : chalk.white;
        console.log(`  ${rate.symbol.padEnd(10)} ${color(pct.padStart(12))}%`);
      }

      console.log(chalk.bold("\nLighter (8hr rates):"));
      const lighterRates = await fetchLighterFundingRates(symbols);
      for (const rate of lighterRates.slice(0, 20)) {
        const pct = (rate.rate * 100).toFixed(6);
        const color = rate.rate > 0 ? chalk.green : rate.rate < 0 ? chalk.red : chalk.white;
        console.log(`  ${rate.symbol.padEnd(10)} ${color(pct.padStart(12))}%`);
      }
    } finally {
      await hlClient.close();
    }
  });

// Helper to fetch Lighter funding rates directly (no auth needed)
async function fetchLighterFundingRates(
  symbols: string[]
): Promise<Array<{ symbol: string; rate: number }>> {
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

  const symbolSet = new Set(symbols);
  const results: Array<{ symbol: string; rate: number }> = [];

  for (const rate of data.funding_rates) {
    if (rate.exchange !== "lighter") continue;
    if (symbolSet.size > 0 && !symbolSet.has(rate.symbol)) continue;
    results.push({
      symbol: rate.symbol,
      rate: parseFloat(rate.rate),
    });
  }

  return results;
}

async function scanOpportunities(
  hlClient: HyperliquidClient,
  symbols: string[],
  minEdgeBps: number,
  verbose: boolean
): Promise<Opportunity[]> {
  // Fetch both rates in parallel
  const [hlRates, lighterRatesRaw] = await Promise.all([
    hlClient.getFundingRates([]),
    fetchLighterFundingRates([]),
  ]);

  // Build rate maps
  const hlRateMap = new Map<string, number>();
  for (const rate of hlRates) {
    hlRateMap.set(rate.symbol, rate.rate);
  }

  const lighterRateMap = new Map<string, number>();
  for (const rate of lighterRatesRaw) {
    lighterRateMap.set(rate.symbol, rate.rate);
  }

  // Find common symbols
  const symbolsToCheck =
    symbols.length > 0
      ? new Set(symbols)
      : new Set([...hlRateMap.keys()].filter((s) => lighterRateMap.has(s)));

  const opportunities: Opportunity[] = [];
  const compared: Array<{
    symbol: string;
    hlRate8hr: number;
    lighterRate8hr: number;
    edgeBps: number;
  }> = [];

  for (const symbol of symbolsToCheck) {
    const hlRate1hr = hlRateMap.get(symbol);
    const lighterRate8hr = lighterRateMap.get(symbol);

    if (hlRate1hr === undefined || lighterRate8hr === undefined) continue;

    // CRITICAL: Normalize both to 8hr rates
    // Hyperliquid is 1hr, Lighter is 8hr
    const hlRate8hr = hlRate1hr * 8;

    // Skip if both are zero
    if (hlRate1hr === 0 && lighterRate8hr === 0) continue;

    // Edge in basis points
    const edgeBps = (hlRate8hr - lighterRate8hr) * 10000;
    // APY: 3 funding payments per day (8hr), convert bps to %
    const apy = (Math.abs(edgeBps) * 3 * 365) / 100;

    compared.push({ symbol, hlRate8hr, lighterRate8hr, edgeBps });

    if (Math.abs(edgeBps) >= minEdgeBps) {
      const direction =
        edgeBps > 0
          ? "Long Lighter / Short Hyperliquid"
          : "Long Hyperliquid / Short Lighter";

      opportunities.push({
        symbol,
        hlRate8hr,
        lighterRate8hr,
        edgeBps,
        apy,
        direction,
      });
    }
  }

  if (verbose && compared.length > 0) {
    console.log(
      chalk.dim(`\nCompared ${compared.length} symbols available on both exchanges`)
    );
    compared.sort((a, b) => Math.abs(b.edgeBps) - Math.abs(a.edgeBps));
    for (const c of compared.slice(0, 10)) {
      console.log(
        chalk.dim(
          `  ${c.symbol.padEnd(10)} HL:${(c.hlRate8hr * 100).toFixed(4).padStart(8)}% ` +
            `Ltr:${(c.lighterRate8hr * 100).toFixed(4).padStart(8)}% Edge:${c.edgeBps.toFixed(2).padStart(7)}bps`
        )
      );
    }
    console.log();
  }

  return opportunities;
}

function printHeader(): void {
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

function printOpportunity(opp: Opportunity): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log(chalk.dim("\n\nReceived SIGINT, shutting down..."));
  process.exit(0);
});

program.parse();

