/**
 * Execution Router
 *
 * Coordinates dual-leg trades across Hyperliquid and Lighter.
 * Handles partial fills, emergency reconciliation, and atomic execution.
 */

import type { ExchangeClient, OrderRequest, OrderResult, Ticker, SymbolSpec } from "../exchanges/types.js";
import { Side, OrderType, OrderTimeInForce } from "../exchanges/types.js";
import type { TradeDirection, OpenPosition } from "../strategy/types.js";

export interface DualLegOrder {
  symbol: string;
  direction: TradeDirection;
  notionalUsd: number;
  maxSlippageBps: number;
}

export interface LegResult {
  success: boolean;
  orderResult?: OrderResult;
  error?: string;
  actualSize: number;
  actualPrice: number;
  side: Side;
}

export interface ExecutionResult {
  success: boolean;
  lighterLeg: LegResult;
  hlLeg: LegResult;
  /** Size imbalance between legs (as ratio, 0 = perfectly balanced) */
  imbalanceRatio: number;
  /** Is this balanced enough? */
  isBalanced: boolean;
  /** Created position if successful */
  position?: OpenPosition;
  /** Did we need to reconcile? */
  wasReconciled: boolean;
  /** Reconciliation details if applicable */
  reconciliation?: ReconciliationResult;
}

export interface ReconciliationResult {
  action: "unwound_success" | "unwound_partial" | "filled_lagging" | "failed";
  message: string;
  lighterDelta: number;
  hlDelta: number;
}

export class ExecutionRouter {
  private lighter: ExchangeClient;
  private hyperliquid: ExchangeClient;
  private maxImbalanceRatio: number;
  private symbolSpecs: Map<string, { lighter?: SymbolSpec; hl?: SymbolSpec }> = new Map();

  constructor(
    lighter: ExchangeClient,
    hyperliquid: ExchangeClient,
    maxImbalanceRatio: number = 0.02 // 2% max imbalance
  ) {
    this.lighter = lighter;
    this.hyperliquid = hyperliquid;
    this.maxImbalanceRatio = maxImbalanceRatio;
  }

  /**
   * Pre-fetch symbol specs for size normalization
   */
  async ensureSymbolSpecs(symbol: string): Promise<void> {
    if (this.symbolSpecs.has(symbol)) return;

    const [lighterSpecs, hlSpecs] = await Promise.all([
      this.lighter.getSymbols(),
      this.hyperliquid.getSymbols(),
    ]);

    const lighterSpec = lighterSpecs.find((s) => s.symbol === symbol || s.baseAsset === symbol);
    const hlSpec = hlSpecs.find((s) => s.symbol === symbol);

    this.symbolSpecs.set(symbol, { lighter: lighterSpec, hl: hlSpec });
  }

  /**
   * Normalize size to the coarser lot size between exchanges
   */
  normalizeSize(symbol: string, size: number): number {
    const specs = this.symbolSpecs.get(symbol);
    if (!specs) return size;

    const lighterLot = specs.lighter?.lotSize ?? 0.0001;
    const hlLot = specs.hl?.lotSize ?? 0.0001;
    const coarsestLot = Math.max(lighterLot, hlLot);

    // Round DOWN to coarsest lot size
    return Math.floor(size / coarsestLot) * coarsestLot;
  }

  /**
   * Execute a dual-leg entry trade with atomic execution guarantee
   */
  async executeEntry(order: DualLegOrder): Promise<ExecutionResult> {
    const { symbol, direction, notionalUsd, maxSlippageBps } = order;

    // Ensure we have symbol specs for size normalization
    await this.ensureSymbolSpecs(symbol);

    // Get current prices from both exchanges
    const [lighterTicker, hlTicker] = await Promise.all([
      this.lighter.getTicker(symbol),
      this.hyperliquid.getTicker(symbol),
    ]);

    // Calculate sizes based on notional and prices
    const lighterMid = (lighterTicker.bid + lighterTicker.ask) / 2;
    const hlMid = (hlTicker.bid + hlTicker.ask) / 2;

    // Calculate raw sizes then normalize to coarsest lot
    const rawLighterSize = notionalUsd / lighterMid;
    const rawHlSize = notionalUsd / hlMid;
    
    // Use the SAME normalized size for both legs to ensure balance
    const avgPrice = (lighterMid + hlMid) / 2;
    const targetSize = this.normalizeSize(symbol, notionalUsd / avgPrice);

    // Determine sides based on direction
    const lighterSide = direction === "long_lighter_short_hl" ? Side.BUY : Side.SELL;
    const hlSide = direction === "long_lighter_short_hl" ? Side.SELL : Side.BUY;

    // Calculate limit prices with slippage
    const lighterPrice = this.calculateLimitPrice(lighterTicker, lighterSide, maxSlippageBps);
    const hlPrice = this.calculateLimitPrice(hlTicker, hlSide, maxSlippageBps);

    // Execute both legs in parallel
    const [lighterResult, hlResult] = await Promise.all([
      this.executeLeg(this.lighter, symbol, lighterSide, targetSize, lighterPrice),
      this.executeLeg(this.hyperliquid, symbol, hlSide, targetSize, hlPrice),
    ]);

    // CRITICAL: Handle partial/failed fills with reconciliation
    let wasReconciled = false;
    let reconciliation: ReconciliationResult | undefined;

    const bothSucceeded = lighterResult.success && hlResult.success;
    const bothFailed = !lighterResult.success && !hlResult.success;
    const oneFailed = !bothSucceeded && !bothFailed;

    if (oneFailed) {
      // ONE LEG FAILED - MUST RECONCILE
      console.error(`⚠️ PARTIAL FILL DETECTED - initiating emergency reconciliation`);
      reconciliation = await this.emergencyReconcile(
        symbol,
        lighterResult,
        hlResult,
        maxSlippageBps
      );
      wasReconciled = true;
    }

    // Calculate final imbalance after any reconciliation
    const lighterNotional = lighterResult.actualSize * lighterResult.actualPrice;
    const hlNotional = hlResult.actualSize * hlResult.actualPrice;
    const avgNotional = (lighterNotional + hlNotional) / 2;
    const imbalanceRatio = avgNotional > 0 ? Math.abs(lighterNotional - hlNotional) / avgNotional : 0;

    const isBalanced = imbalanceRatio <= this.maxImbalanceRatio;
    
    // Success only if both legs filled AND balanced (or successfully reconciled)
    const success = (bothSucceeded && isBalanced) || 
                   (wasReconciled && reconciliation?.action === "filled_lagging");

    let position: OpenPosition | undefined;
    if (success) {
      position = {
        symbol,
        direction,
        entryEdgeBps: 0, // Will be set by caller
        entryTimestamp: Date.now(),
        lighterSize: lighterSide === Side.BUY ? lighterResult.actualSize : -lighterResult.actualSize,
        hlSize: hlSide === Side.BUY ? hlResult.actualSize : -hlResult.actualSize,
        lighterEntryPrice: lighterResult.actualPrice,
        hlEntryPrice: hlResult.actualPrice,
        notionalUsd: avgNotional,
      };
    }

    return {
      success,
      lighterLeg: lighterResult,
      hlLeg: hlResult,
      imbalanceRatio,
      isBalanced,
      position,
      wasReconciled,
      reconciliation,
    };
  }

  /**
   * Emergency reconciliation when one leg fails
   * Strategy: Try to unwind the successful leg, or fill the failed leg
   */
  private async emergencyReconcile(
    symbol: string,
    lighterResult: LegResult,
    hlResult: LegResult,
    maxSlippageBps: number
  ): Promise<ReconciliationResult> {
    const lighterFilled = lighterResult.success && lighterResult.actualSize > 0;
    const hlFilled = hlResult.success && hlResult.actualSize > 0;

    // Case 1: Lighter filled, HL failed → Try to close Lighter position
    if (lighterFilled && !hlFilled) {
      console.log(`  Lighter filled ${lighterResult.actualSize}, HL failed. Unwinding Lighter...`);
      
      // Close Lighter position (opposite side)
      const unwindSide = lighterResult.side === Side.BUY ? Side.SELL : Side.BUY;
      const ticker = await this.lighter.getTicker(symbol);
      const unwindPrice = this.calculateLimitPrice(ticker, unwindSide, maxSlippageBps * 2); // More aggressive

      const unwindResult = await this.executeLeg(
        this.lighter,
        symbol,
        unwindSide,
        lighterResult.actualSize,
        unwindPrice,
        true // reduce only
      );

      if (unwindResult.success && unwindResult.actualSize >= lighterResult.actualSize * 0.95) {
        // Reset the lighter result since we unwound
        lighterResult.actualSize = 0;
        lighterResult.actualPrice = 0;
        return {
          action: "unwound_success",
          message: `Successfully unwound Lighter position`,
          lighterDelta: -unwindResult.actualSize,
          hlDelta: 0,
        };
      }

      return {
        action: "unwound_partial",
        message: `Partial unwind: closed ${unwindResult.actualSize} of ${lighterResult.actualSize}`,
        lighterDelta: -unwindResult.actualSize,
        hlDelta: 0,
      };
    }

    // Case 2: HL filled, Lighter failed → Try to close HL position
    if (hlFilled && !lighterFilled) {
      console.log(`  HL filled ${hlResult.actualSize}, Lighter failed. Unwinding HL...`);

      const unwindSide = hlResult.side === Side.BUY ? Side.SELL : Side.BUY;
      const ticker = await this.hyperliquid.getTicker(symbol);
      const unwindPrice = this.calculateLimitPrice(ticker, unwindSide, maxSlippageBps * 2);

      const unwindResult = await this.executeLeg(
        this.hyperliquid,
        symbol,
        unwindSide,
        hlResult.actualSize,
        unwindPrice,
        true
      );

      if (unwindResult.success && unwindResult.actualSize >= hlResult.actualSize * 0.95) {
        hlResult.actualSize = 0;
        hlResult.actualPrice = 0;
        return {
          action: "unwound_success",
          message: `Successfully unwound HL position`,
          lighterDelta: 0,
          hlDelta: -unwindResult.actualSize,
        };
      }

      return {
        action: "unwound_partial",
        message: `Partial unwind: closed ${unwindResult.actualSize} of ${hlResult.actualSize}`,
        lighterDelta: 0,
        hlDelta: -unwindResult.actualSize,
      };
    }

    return {
      action: "failed",
      message: "No action taken - unexpected state",
      lighterDelta: 0,
      hlDelta: 0,
    };
  }

  /**
   * Execute a dual-leg exit trade
   */
  async executeExit(position: OpenPosition): Promise<ExecutionResult> {
    const { symbol, lighterSize, hlSize } = position;

    // Get current prices
    const [lighterTicker, hlTicker] = await Promise.all([
      this.lighter.getTicker(symbol),
      this.hyperliquid.getTicker(symbol),
    ]);

    // Determine exit sides (opposite of position direction)
    const lighterSide = lighterSize > 0 ? Side.SELL : Side.BUY;
    const hlSide = hlSize > 0 ? Side.SELL : Side.BUY;

    // More aggressive slippage for exits (we want to close)
    const exitSlippageBps = 20;
    const lighterPrice = this.calculateLimitPrice(lighterTicker, lighterSide, exitSlippageBps);
    const hlPrice = this.calculateLimitPrice(hlTicker, hlSide, exitSlippageBps);

    // Execute both legs in parallel with reduce_only
    const [lighterResult, hlResult] = await Promise.all([
      this.executeLeg(this.lighter, symbol, lighterSide, Math.abs(lighterSize), lighterPrice, true),
      this.executeLeg(this.hyperliquid, symbol, hlSide, Math.abs(hlSize), hlPrice, true),
    ]);

    // Handle partial exits
    let wasReconciled = false;
    let reconciliation: ReconciliationResult | undefined;

    if (lighterResult.success !== hlResult.success) {
      console.error(`⚠️ PARTIAL EXIT - one leg failed`);
      // For exits, we may need to retry the failed leg
      reconciliation = await this.retryFailedExitLeg(
        symbol,
        position,
        lighterResult,
        hlResult,
        exitSlippageBps
      );
      wasReconciled = true;
    }

    // Calculate how much was actually closed
    const lighterNotional = lighterResult.actualSize * lighterResult.actualPrice;
    const hlNotional = hlResult.actualSize * hlResult.actualPrice;
    const avgNotional = (lighterNotional + hlNotional) / 2;
    const imbalanceRatio =
      avgNotional > 0 ? Math.abs(lighterNotional - hlNotional) / avgNotional : 0;

    const isBalanced = imbalanceRatio <= this.maxImbalanceRatio;
    const success = lighterResult.success && hlResult.success;

    return {
      success,
      lighterLeg: lighterResult,
      hlLeg: hlResult,
      imbalanceRatio,
      isBalanced,
      wasReconciled,
      reconciliation,
    };
  }

  /**
   * Retry a failed exit leg with more aggressive pricing
   */
  private async retryFailedExitLeg(
    symbol: string,
    position: OpenPosition,
    lighterResult: LegResult,
    hlResult: LegResult,
    slippageBps: number
  ): Promise<ReconciliationResult> {
    const moreAggressiveSlippage = slippageBps * 3; // 3x slippage for retry

    if (!lighterResult.success && lighterResult.actualSize < Math.abs(position.lighterSize)) {
      const remainingSize = Math.abs(position.lighterSize) - lighterResult.actualSize;
      const ticker = await this.lighter.getTicker(symbol);
      const side = position.lighterSize > 0 ? Side.SELL : Side.BUY;
      const price = this.calculateLimitPrice(ticker, side, moreAggressiveSlippage);

      const retryResult = await this.executeLeg(this.lighter, symbol, side, remainingSize, price, true);
      
      if (retryResult.success) {
        lighterResult.actualSize += retryResult.actualSize;
        return {
          action: "filled_lagging",
          message: `Retry filled Lighter: ${retryResult.actualSize}`,
          lighterDelta: retryResult.actualSize,
          hlDelta: 0,
        };
      }
    }

    if (!hlResult.success && hlResult.actualSize < Math.abs(position.hlSize)) {
      const remainingSize = Math.abs(position.hlSize) - hlResult.actualSize;
      const ticker = await this.hyperliquid.getTicker(symbol);
      const side = position.hlSize > 0 ? Side.SELL : Side.BUY;
      const price = this.calculateLimitPrice(ticker, side, moreAggressiveSlippage);

      const retryResult = await this.executeLeg(this.hyperliquid, symbol, side, remainingSize, price, true);
      
      if (retryResult.success) {
        hlResult.actualSize += retryResult.actualSize;
        return {
          action: "filled_lagging",
          message: `Retry filled HL: ${retryResult.actualSize}`,
          lighterDelta: 0,
          hlDelta: retryResult.actualSize,
        };
      }
    }

    return {
      action: "failed",
      message: "Retry failed - manual intervention required",
      lighterDelta: 0,
      hlDelta: 0,
    };
  }

  /**
   * Execute a single leg
   */
  private async executeLeg(
    exchange: ExchangeClient,
    symbol: string,
    side: Side,
    size: number,
    price: number,
    reduceOnly: boolean = false
  ): Promise<LegResult> {
    try {
      const orderRequest: OrderRequest = {
        clientId: `${exchange.name}:${symbol}:${Date.now()}`,
        symbol,
        side,
        size,
        orderType: OrderType.LIMIT,
        price,
        reduceOnly,
        timeInForce: OrderTimeInForce.IOC, // Immediate or cancel for atomic execution
      };

      const result = await exchange.placeOrder(orderRequest);

      // For Lighter, we need to poll for actual fill if not immediately returned
      let filledSize = result.filledSize;
      let avgPrice = result.averageFillPrice ?? price;

      // If order was submitted but fill size unknown, poll for fill status
      if (result.status === "submitted" && filledSize === 0 && exchange.name === "lighter") {
        // Give time for fill to process
        await this.sleep(500);
        
        // Check position to infer fill
        try {
          const positions = await exchange.getPositions();
          const pos = positions.find((p) => p.symbol === symbol);
          if (pos) {
            // Infer fill from position
            filledSize = pos.size;
            avgPrice = pos.entryPrice;
          }
        } catch {
          // Fall back to assuming order filled at limit price
          filledSize = size;
          avgPrice = price;
        }
      }

      return {
        success: filledSize > 0,
        orderResult: result,
        actualSize: filledSize,
        actualPrice: avgPrice,
        side,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        actualSize: 0,
        actualPrice: 0,
        side,
      };
    }
  }

  /**
   * Calculate limit price with slippage buffer
   */
  private calculateLimitPrice(ticker: Ticker, side: Side, slippageBps: number): number {
    const slippageMultiplier = slippageBps / 10000;

    if (side === Side.BUY) {
      // Buying: go above ask
      return ticker.ask * (1 + slippageMultiplier);
    } else {
      // Selling: go below bid
      return ticker.bid * (1 - slippageMultiplier);
    }
  }

  /**
   * Reconcile imbalanced positions
   * Called when legs are out of sync
   */
  async reconcile(
    symbol: string,
    lighterDelta: number,
    hlDelta: number,
    maxSlippageBps: number
  ): Promise<{ lighterResult?: LegResult; hlResult?: LegResult }> {
    const results: { lighterResult?: LegResult; hlResult?: LegResult } = {};

    // Fix Lighter position if needed
    if (Math.abs(lighterDelta) > 0.0001) {
      const ticker = await this.lighter.getTicker(symbol);
      const side = lighterDelta > 0 ? Side.BUY : Side.SELL;
      const price = this.calculateLimitPrice(ticker, side, maxSlippageBps);
      results.lighterResult = await this.executeLeg(
        this.lighter,
        symbol,
        side,
        Math.abs(lighterDelta),
        price
      );
    }

    // Fix HL position if needed
    if (Math.abs(hlDelta) > 0.0001) {
      const ticker = await this.hyperliquid.getTicker(symbol);
      const side = hlDelta > 0 ? Side.BUY : Side.SELL;
      const price = this.calculateLimitPrice(ticker, side, maxSlippageBps);
      results.hlResult = await this.executeLeg(
        this.hyperliquid,
        symbol,
        side,
        Math.abs(hlDelta),
        price
      );
    }

    return results;
  }

  /**
   * Get actual position sizes from both exchanges
   */
  async getActualPositions(symbol: string): Promise<{
    lighterSize: number;
    hlSize: number;
  }> {
    const [lighterPositions, hlPositions] = await Promise.all([
      this.lighter.getPositions(),
      this.hyperliquid.getPositions(),
    ]);

    const lighterPos = lighterPositions.find((p) => p.symbol === symbol);
    const hlPos = hlPositions.find((p) => p.symbol === symbol);

    return {
      lighterSize: lighterPos ? (lighterPos.side === Side.BUY ? lighterPos.size : -lighterPos.size) : 0,
      hlSize: hlPos ? (hlPos.side === Side.BUY ? hlPos.size : -hlPos.size) : 0,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
