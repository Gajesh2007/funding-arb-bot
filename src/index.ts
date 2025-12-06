/**
 * Funding Arbitrage Bot
 *
 * TypeScript implementation for funding rate arbitrage between Hyperliquid and Lighter
 */

// Exchange clients and types
export * from "./exchanges/index.js";

// Strategy (use alias to avoid FundingSnapshot conflict)
export {
  StrategyEngine,
  FundingHistoryTracker,
  SymbolDiscoveryService,
  discoverOpportunities,
  discoverTopSymbols,
  DEFAULT_STRATEGY_CONFIG,
  type FundingSnapshot as StrategyFundingSnapshot,
  type FundingHistory,
  type TradeDecision,
  type TradeDirection,
  type OpenPosition,
  type StrategyConfig,
} from "./strategy/index.js";

// Execution
export {
  ExecutionRouter,
  RiskManager,
  type DualLegOrder,
  type LegResult,
  type ExecutionResult as RouterExecutionResult,
  type ReconciliationResult,
  type RiskCheck,
  type DriftInfo,
  type MarginStatus,
} from "./execution/index.js";

// Infrastructure
export * from "./infra/index.js";

// Bot
export {
  runBot,
  createBotContext,
  saveBotState,
  executeDryRunEntry,
  executeDryRunExit,
  executeLiveEntry,
  executeLiveExit,
  type BotConfig,
  type BotContext,
  type BotCallbacks,
  type BotStatus,
  type EntryParams,
  type ExecutionResult as BotExecutionResult,
} from "./bot/index.js";
