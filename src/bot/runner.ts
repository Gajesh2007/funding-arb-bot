/**
 * Bot Runner
 *
 * Main bot loop that orchestrates strategy evaluation, execution, and monitoring.
 */

import type { HyperliquidClient } from "../exchanges/hyperliquid.js";
import type { LighterClient } from "../exchanges/lighter.js";
import { fetchLighterFundingRates } from "../exchanges/lighter-api.js";
import { ExecutionRouter } from "../execution/router.js";
import { RiskManager, type PositionRisk } from "../execution/risk.js";
import { StrategyEngine } from "../strategy/engine.js";
import { SymbolDiscoveryService } from "../strategy/discovery.js";
import type { StrategyConfig, FundingSnapshot } from "../strategy/types.js";
import { StateStore } from "../infra/state-store.js";
import { PnLTracker } from "../infra/pnl-tracker.js";
import { RateLimiter } from "../infra/rate-limiter.js";
import { justPassedFunding, minutesUntilFunding } from "../infra/funding-times.js";
import {
  executeDryRunEntry,
  executeDryRunExit,
  executeLiveEntry,
  executeLiveExit,
  type EntryParams,
} from "./executor.js";

export interface BotConfig {
  strategy: StrategyConfig;
  pollIntervalMs: number;
  dryRun: boolean;
  verbose: boolean;
  autoDiscover: boolean;
  maxSymbols: number;
}

export interface BotContext {
  hlClient: HyperliquidClient;
  lighterClient: LighterClient | null;
  engine: StrategyEngine;
  riskManager: RiskManager;
  router: ExecutionRouter | null;
  stateStore: StateStore;
  pnlTracker: PnLTracker;
  rateLimiter: RateLimiter;
  discoveryService: SymbolDiscoveryService | null;
}

export interface BotCallbacks {
  onLog: (message: string) => void;
  onWarn: (message: string) => void;
  onError: (message: string) => void;
  onStatusUpdate: (status: BotStatus) => void;
}

export interface BotStatus {
  running: boolean;
  warmupComplete: boolean;
  warmupSamples: number;
  activeSymbols: string[];
  positionCount: number;
  totalNotional: number;
  minutesToFunding: number;
  totalRealizedPnl: number;
}

/**
 * Create bot context with all dependencies.
 */
export function createBotContext(
  config: BotConfig,
  hlClient: HyperliquidClient,
  lighterClient: LighterClient | null
): BotContext {
  const engine = new StrategyEngine(config.strategy);
  const riskManager = new RiskManager(config.strategy);
  const stateStore = new StateStore();
  const pnlTracker = new PnLTracker();
  const rateLimiter = new RateLimiter(100, 50);

  let router: ExecutionRouter | null = null;
  if (!config.dryRun && lighterClient) {
    router = new ExecutionRouter(lighterClient, hlClient);
  }

  let discoveryService: SymbolDiscoveryService | null = null;
  if (config.autoDiscover) {
    discoveryService = new SymbolDiscoveryService(
      hlClient,
      {
        minEdgeBps: config.strategy.minEdgeBps,
        maxSymbols: config.maxSymbols,
      },
      5 * 60 * 1000
    );
  }

  return {
    hlClient,
    lighterClient,
    engine,
    riskManager,
    router,
    stateStore,
    pnlTracker,
    rateLimiter,
    discoveryService,
  };
}

/**
 * Run the main bot loop.
 */
export async function runBot(
  config: BotConfig,
  ctx: BotContext,
  callbacks: BotCallbacks,
  signal: AbortSignal
): Promise<void> {
  const { hlClient, lighterClient, engine, riskManager, router, pnlTracker, rateLimiter } = ctx;
  const { strategy, pollIntervalMs, dryRun, verbose } = config;

  let activeSymbols = [...strategy.symbols];
  let warmupComplete = false;
  let warmupSamples = 0;
  let lastDiscoveryRefresh = Date.now();
  let lastDriftCheck = 0;
  let lastFundingCheck = 0;
  let lastRiskCheck = 0;

  // Load persisted state
  const savedState = ctx.stateStore.load();
  if (savedState) {
    engine.importState({
      positions: savedState.positions,
      history: savedState.fundingHistory,
    });
    callbacks.onLog(`Restored ${savedState.positions.length} positions from disk`);
  }

  // Initial discovery
  if (ctx.discoveryService) {
    const opportunities = await ctx.discoveryService.refresh();
    if (opportunities.length > 0) {
      activeSymbols = opportunities.map((o) => o.symbol);
      callbacks.onLog(`Auto-discovered ${opportunities.length} opportunities: ${activeSymbols.join(", ")}`);
    }
  }

  // Main loop
  while (!signal.aborted) {
    try {
      // Check kill switch
      if (riskManager.isTripped()) {
        callbacks.onError(`Kill switch tripped: ${riskManager.getKillReason()}`);
        break;
      }

      // =====================================================================
      // POSITION RISK CHECK - Stop-loss, take-profit, max hold time
      // Check every iteration for fast reaction to price spikes
      // =====================================================================
      if (lighterClient && engine.getPositions().length > 0) {
        const riskExits = await checkPositionRisks(ctx, callbacks, dryRun, strategy);
        
        // Force exit any positions that hit risk limits
        for (const risk of riskExits) {
          if (!risk.shouldExit) continue;
          
          callbacks.onWarn(`🛑 RISK EXIT: ${risk.position.symbol} - ${risk.exitReason}`);
          callbacks.onLog(`   Unrealized PnL: $${risk.unrealizedPnl.totalPnl.toFixed(2)} (${(risk.unrealizedPnl.pnlPct * 100).toFixed(1)}%)`);
          callbacks.onLog(`   Hold time: ${risk.holdTimeHours.toFixed(1)}h`);
          callbacks.onLog(`   Price divergence: ${(risk.unrealizedPnl.priceDivergencePct * 100).toFixed(2)}%`);

          if (dryRun) {
            const result = await executeDryRunExit(
              risk.position,
              strategy,
              hlClient,
              engine,
              riskManager,
              pnlTracker
            );
            callbacks.onLog(`   ${result.success ? "✅" : "❌"} ${result.message}`);
          } else if (router) {
            const result = await executeLiveExit(
              risk.position,
              router,
              engine,
              riskManager,
              pnlTracker
            );
            callbacks.onLog(`   ${result.success ? "✅" : "❌"} ${result.message}`);
          }
        }
      }

      // =====================================================================
      // FUNDING PAYMENT CHECK - After funding times (00:00, 08:00, 16:00 UTC)
      // =====================================================================
      if (!dryRun && lighterClient && justPassedFunding(10) && Date.now() - lastFundingCheck > 10 * 60 * 1000) {
        lastFundingCheck = await checkFundingPayments(ctx, callbacks);
      }

      // =====================================================================
      // DRIFT DETECTION - Every 5 minutes
      // =====================================================================
      if (!dryRun && lighterClient && Date.now() - lastDriftCheck > 5 * 60 * 1000) {
        lastDriftCheck = await checkDrift(ctx, callbacks, strategy);
      }

      // =====================================================================
      // SYMBOL DISCOVERY REFRESH - Every 5 minutes
      // =====================================================================
      if (ctx.discoveryService && Date.now() - lastDiscoveryRefresh > 5 * 60 * 1000) {
        const newOpportunities = await ctx.discoveryService.refresh();
        const newSymbols = newOpportunities.map((o) => o.symbol);
        if (newSymbols.length > 0 && JSON.stringify(newSymbols) !== JSON.stringify(activeSymbols)) {
          activeSymbols = newSymbols;
          callbacks.onLog(`Updated symbol list: ${newSymbols.join(", ")}`);
        }
        lastDiscoveryRefresh = Date.now();
      }

      // =====================================================================
      // MAIN STRATEGY LOOP
      // =====================================================================
      await rateLimiter.throttle("funding");

      const [hlRates, lighterRates] = await Promise.all([
        hlClient.getFundingRates(activeSymbols),
        fetchLighterFundingRates(activeSymbols),
      ]);

      const lighterRateMap = new Map(lighterRates.map((r) => [r.symbol, r.rate]));

      for (const symbol of activeSymbols) {
        if (signal.aborted) break;

        const hlRate = hlRates.find((r) => r.symbol === symbol);
        const lighterRate8hr = lighterRateMap.get(symbol);
        if (!hlRate || lighterRate8hr === undefined) continue;

        const hlRate8hr = hlRate.rate * 8;
        const edgeBps = (hlRate8hr - lighterRate8hr) * 10000;

        const snapshot: FundingSnapshot = {
          symbol,
          hlRate8hr,
          lighterRate8hr,
          edgeBps,
          timestamp: Date.now(),
        };

        const decision = engine.evaluate(snapshot);

        // Log status
        const hasPosition = !!engine.getPosition(symbol);
        const history = engine.getHistoryTracker().getHistory(symbol);
        const historyInfo = history
          ? `μ=${history.meanEdgeBps.toFixed(1)} σ=${history.stdDevBps.toFixed(1)}`
          : "warming up";

        if (decision.action !== "hold" || verbose) {
          const prefix = hasPosition ? "📍" : "  ";
          callbacks.onLog(
            `${prefix} ${symbol.padEnd(6)} edge=${edgeBps.toFixed(1).padStart(6)}bps [${historyInfo}] → ${decision.action.toUpperCase()}`
          );
        }

        // Execute entry
        if (decision.action === "enter" && !engine.getPosition(symbol)) {
          if (engine.getPositions().length >= strategy.maxPositions) {
            if (verbose) callbacks.onWarn(`Max positions reached, skipping ${symbol}`);
            continue;
          }
          if (engine.getTotalNotional() + decision.sizeUsd > strategy.maxTotalNotionalUsd) {
            if (verbose) callbacks.onWarn(`Max notional reached, skipping ${symbol}`);
            continue;
          }

          const params: EntryParams = {
            symbol,
            direction: decision.direction,
            sizeUsd: decision.sizeUsd,
            edgeBps,
          };

          const result = dryRun
            ? await executeDryRunEntry(params, strategy, hlClient, engine, pnlTracker)
            : router && lighterClient
              ? await executeLiveEntry(params, strategy, hlClient, lighterClient, router, engine, riskManager, pnlTracker)
              : { success: false, message: "No router available" };

          if (result.success) {
            callbacks.onLog(`✅ ${result.message}`);
          } else {
            callbacks.onError(`❌ ${result.message}`);
          }
        }

        // Execute exit (strategy-based, not risk-based)
        if (decision.action === "exit") {
          const position = engine.getPosition(symbol);
          if (!position) continue;

          const result = dryRun
            ? await executeDryRunExit(position, strategy, hlClient, engine, riskManager, pnlTracker)
            : router
              ? await executeLiveExit(position, router, engine, riskManager, pnlTracker)
              : { success: false, message: "No router available" };

          if (result.success) {
            callbacks.onLog(`✅ ${result.message}`);
          } else {
            callbacks.onError(`❌ ${result.message}`);
          }
        }
      }

      // Warmup tracking
      warmupSamples++;
      if (!warmupComplete && warmupSamples >= strategy.minHistorySamples) {
        warmupComplete = true;
        callbacks.onLog("Warmup complete - trading enabled");
      }

      // Status update
      callbacks.onStatusUpdate({
        running: true,
        warmupComplete,
        warmupSamples,
        activeSymbols,
        positionCount: engine.getPositions().length,
        totalNotional: engine.getTotalNotional(),
        minutesToFunding: minutesUntilFunding(),
        totalRealizedPnl: riskManager.getTotalRealizedPnl(),
      });

      await sleep(pollIntervalMs);
    } catch (error) {
      callbacks.onError(`Error in main loop: ${error}`);
      riskManager.recordFailure(error instanceof Error ? error.message : String(error));
      await sleep(pollIntervalMs);
    }
  }
}

/**
 * Check all positions for risk triggers (stop-loss, take-profit, etc.)
 */
async function checkPositionRisks(
  ctx: BotContext,
  callbacks: BotCallbacks,
  dryRun: boolean,
  config: StrategyConfig
): Promise<PositionRisk[]> {
  if (!ctx.lighterClient) return [];

  const positions = ctx.engine.getPositions();
  if (positions.length === 0) return [];

  try {
    const risks = await ctx.riskManager.checkAllPositionRisks(
      positions,
      ctx.lighterClient,
      ctx.hlClient
    );

    // Log positions with concerning PnL (even if not triggering exit)
    for (const risk of risks) {
      const { unrealizedPnl, holdTimeHours } = risk;
      
      // Log warning if position is approaching limits (50% of threshold)
      if (unrealizedPnl.totalPnl <= -config.stopLossUsd * 0.5 && !risk.shouldExit) {
        callbacks.onWarn(
          `⚠️ ${risk.position.symbol} approaching stop-loss: $${unrealizedPnl.totalPnl.toFixed(2)} (limit: -$${config.stopLossUsd})`
        );
      }
      
      if (holdTimeHours >= config.maxHoldTimeHours * 0.75 && !risk.shouldExit) {
        callbacks.onWarn(
          `⚠️ ${risk.position.symbol} approaching max hold time: ${holdTimeHours.toFixed(1)}h (limit: ${config.maxHoldTimeHours}h)`
        );
      }
    }

    return risks;
  } catch (error) {
    callbacks.onError(`Failed to check position risks: ${error}`);
    return [];
  }
}

/**
 * Check for funding payments after funding times.
 */
async function checkFundingPayments(ctx: BotContext, callbacks: BotCallbacks): Promise<number> {
  if (!ctx.lighterClient) return Date.now();

  callbacks.onLog("Checking for funding payments...");

  try {
    const [hlPayments, lighterPayments] = await Promise.all([
      ctx.hlClient.getFundingPayments(ctx.pnlTracker.getLastFundingCheck("hyperliquid")),
      ctx.lighterClient.getFundingPayments(ctx.pnlTracker.getLastFundingCheck("lighter")),
    ]);

    const hlTotal = ctx.pnlTracker.recordFundingPayments("hyperliquid", hlPayments);
    const lighterTotal = ctx.pnlTracker.recordFundingPayments("lighter", lighterPayments);

    if (hlTotal !== 0 || lighterTotal !== 0) {
      callbacks.onLog(`Funding received: HL $${hlTotal.toFixed(2)} | Lighter $${lighterTotal.toFixed(2)}`);
    }
  } catch (err) {
    callbacks.onWarn(`Failed to fetch funding: ${err}`);
  }

  return Date.now();
}

/**
 * Check for position drift.
 */
async function checkDrift(
  ctx: BotContext,
  callbacks: BotCallbacks,
  config: StrategyConfig
): Promise<number> {
  if (!ctx.lighterClient) return Date.now();

  const positions = ctx.engine.getPositions();
  if (positions.length === 0) return Date.now();

  const driftInfos = await ctx.riskManager.checkAllDrift(positions, ctx.lighterClient, ctx.hlClient);

  for (const drift of driftInfos) {
    if (!drift.needsRebalance) continue;

    callbacks.onWarn(
      `${drift.symbol}: Drift ${drift.driftBps.toFixed(1)} bps > threshold ${config.driftThresholdBps} bps`
    );

    if (ctx.router) {
      const lighterDelta = drift.expectedLighterSize - drift.lighterSize;
      const hlDelta = drift.expectedHlSize - drift.hlSize;

      const result = await ctx.router.reconcile(
        drift.symbol,
        lighterDelta,
        hlDelta,
        config.maxSlippageBps * 2
      );

      if (result.lighterResult?.success || result.hlResult?.success) {
        callbacks.onLog(`Rebalanced ${drift.symbol}`);
      } else {
        callbacks.onError(`Rebalance failed for ${drift.symbol}`);
      }
    }
  }

  return Date.now();
}

/**
 * Save bot state to disk.
 */
export function saveBotState(ctx: BotContext): void {
  const state = ctx.engine.exportState();
  ctx.stateStore.save({
    positions: state.positions,
    fundingHistory: state.history,
    lastUpdated: Date.now(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
