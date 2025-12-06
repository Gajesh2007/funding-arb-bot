# Funding Arbitrage Bot

Market-neutral funding rate arbitrage bot trading between Lighter and Hyperliquid perpetuals.

**TypeScript** — Uses `@nktkas/hyperliquid` and `lighter-ts-sdk` for native SDK integration.

## Features

- **Auto-Discovery** — Automatically finds and ranks best opportunities across all symbols
- **Historical Funding Analysis** — Tracks funding rates over 24hr window to avoid entering on spikes
- **Spike Detection** — Only enters when current rate is within 2σ of historical mean
- **Atomic Dual-Leg Execution** — Executes both legs with emergency reconciliation if one fails
- **Stop-Loss & Take-Profit** — Per-position risk limits to prevent liquidation from price spikes
- **Max Hold Time** — Force exit positions after configurable hours
- **Price Divergence Detection** — Exit if exchange prices diverge beyond threshold
- **Position Limits** — Max positions, max notional, margin checks
- **Portfolio Drawdown Kill Switch** — Stops trading if total losses exceed threshold
- **Funding Payment Tracking** — Polls exchanges after funding times to record actual payments
- **Drift Detection** — Periodically verifies positions match between exchanges
- **Rate Limiting** — Prevents API rate limit violations
- **Crash Recovery** — Persists state to disk for recovery
- **Correct PnL Accounting** — Proper delta-neutral position math

## Installation

```sh
pnpm install
```

## Quick Start

### Spot Opportunities (Read-Only)

```sh
# Single scan
pnpm spot --once

# Continuous scanning
pnpm spot

# With options
pnpm spot --min-edge 10 --verbose --symbols ETH BTC SOL
```

### Live Trading

```sh
# Dry run with auto-discovery (default)
npx tsx src/cli/main.ts run --dry-run

# Auto-discover top 5 opportunities
npx tsx src/cli/main.ts run --dry-run --max-symbols 5

# Manually specify symbols (disables auto-discovery)
npx tsx src/cli/main.ts run --dry-run --symbols ETH BTC SOL

# Live trading (requires credentials)
npx tsx src/cli/main.ts run --notional 500
```

### View Current Rates

```sh
npx tsx src/cli/main.ts rates --symbols ETH BTC SOL
```

### Check PnL

```sh
npx tsx src/cli/main.ts pnl

# With breakdown by symbol
npx tsx src/cli/main.ts pnl --by-symbol
```

## Configuration

Create a `.env` file:

```env
# Required for live trading
HYPERLIQUID_PRIVATE_KEY=0x...
LIGHTER_PRIVATE_KEY=0x...
LIGHTER_ACCOUNT_INDEX=0
LIGHTER_API_KEY_INDEX=0
```

## CLI Reference

```
Commands:
  spot [options]   Scan for opportunities (read-only)
  rates [options]  Show current funding rates
  run [options]    Start live trading bot
  pnl [options]    Show PnL summary

Run Options:
  -e, --min-edge <bps>      Min edge to enter (default: 20)
  -x, --exit-edge <bps>     Exit threshold (default: 5)
  -n, --notional <usd>      Order size (default: 500)
  -m, --max-notional <usd>  Max total notional (default: 10000)
  -a, --auto                Auto-discover best opportunities (default)
  --max-symbols <n>         Max symbols in auto mode (default: 5)
  -s, --symbols <list>      Manually specify symbols (disables auto)
  -i, --interval <sec>      Poll interval (default: 30)
  -v, --verbose             Show detailed status
  --dry-run                 Simulate without real trades

Leverage & Risk Options:
  -l, --leverage <x>        Target leverage (default: 2 = 2x, safer)
  --stop-loss <usd>         Stop-loss per position in USD (default: 100)
  --stop-loss-pct <pct>     Stop-loss as % of notional (default: 0.2 = 20%)
  --take-profit <usd>       Take-profit per position in USD (default: 150)
  --take-profit-pct <pct>   Take-profit as % of notional (default: 0.3 = 30%)
  --max-hold <hours>        Max hold time before forced exit (default: 48)
  --max-divergence <pct>    Max price divergence between exchanges (default: 0.02 = 2%)
  --max-drawdown <usd>      Max portfolio drawdown before kill switch (default: 500)
  --liq-buffer <pct>        Buffer before liquidation to exit (default: 0.2 = 20%)

PnL Options:
  --by-symbol               Show breakdown by symbol
```

## How It Works

### Auto-Discovery

By default, the bot automatically:

1. **Scans all symbols** available on both Hyperliquid and Lighter
2. **Calculates edge** for each symbol (HL rate - Lighter rate)
3. **Ranks by absolute edge** and selects top N
4. **Refreshes every 5 minutes** to find new opportunities

Example output:
```
🔍 Auto-discovering best opportunities...

✅ Found 5 opportunities:

   YZY       -89.3 bps   978% APY  S→L
   IP         11.7 bps   128% APY  L→S
   ZORA        7.0 bps    76% APY  L→S
   0G          6.2 bps    68% APY  L→S
   VVV         5.4 bps    59% APY  L→S
```

### Entry Criteria

1. **Minimum Edge** — Edge must exceed threshold (default: 20 bps)
2. **Sufficient History** — At least 12 samples collected (~1hr at 5min intervals)
3. **Not a Spike** — Current rate within 2σ of 24hr mean
4. **Stable/Increasing Trend** — Edge not trending downward
5. **Risk Limits** — Under max positions and notional limits
6. **Margin Check** — Sufficient free margin on both exchanges (2x safety factor)

### Exit Criteria

**Strategy-based exits:**
1. **Edge Collapse** — Edge drops below exit threshold (default: 5 bps)
2. **Direction Flip** — Edge changes sign (arb no longer exists)

**Risk-based exits (to prevent liquidation):**
3. **Stop-Loss** — Exit if unrealized loss exceeds $50 (or 10% of notional)
4. **Take-Profit** — Lock in gains at $100 profit (or 20% of notional)
5. **Max Hold Time** — Force exit after 48 hours regardless of PnL
6. **Price Divergence** — Exit if exchange prices differ by >2%

### Risk Protection

Even though the strategy is "delta-neutral," you're NOT perfectly hedged because:
- Entry slippage creates initial price mismatch between legs
- Exchange prices can diverge during volatility
- One leg could get liquidated before the other

The risk limits protect against these scenarios:

```
Position: ETH long Lighter @ $3000, short HL @ $3000
          Notional: $500

Scenario: ETH spikes to $3500 on HL, $3400 on Lighter
          Short leg losing: -$500 * ($3500 - $3000) / $3000 = -$83
          Long leg gaining: +$500 * ($3400 - $3000) / $3000 = +$67
          Net unrealized: -$16

If price continues moving → stop-loss triggers at -$50 → FORCED EXIT
```

**Configuring risk limits:**
```sh
# Conservative (smaller positions, tighter stops)
npx tsx src/cli/main.ts run --stop-loss 25 --max-hold 24

# Aggressive (larger tolerance, longer holds)
npx tsx src/cli/main.ts run --stop-loss 100 --stop-loss-pct 0.15 --max-hold 72
```

### Spike Detection

The bot tracks rolling 24hr funding history per symbol:

```
Current Edge: 50 bps
24hr Mean:    20 bps
24hr StdDev:  8 bps
Deviations:   (50-20)/8 = 3.75σ

3.75σ > 2σ threshold → SPIKE DETECTED → No entry
```

This prevents entering on temporary funding anomalies that revert quickly.

### Atomic Execution with Reconciliation

When placing dual-leg trades, the router:

1. Executes both legs in parallel with IOC limit orders
2. If one leg fails but the other succeeds → **Emergency reconciliation**
3. Attempts to unwind the successful leg to avoid directional exposure
4. Logs reconciliation actions for review

### Drift Detection

Every 5 minutes, the bot:

1. Compares expected position sizes vs actual positions on exchanges
2. If drift exceeds threshold (default: 25 bps) → Alerts and attempts rebalance
3. Logs discrepancies for investigation

### Funding Payment Tracking

After funding times (00:00, 08:00, 16:00 UTC):

1. Polls both exchanges for funding payments
2. Records payments with symbol, amount, rate, position size
3. Updates PnL tracking with actual funding received

## Architecture

```
src/
├── cli/
│   ├── main.ts           # CLI command definitions (slim)
│   └── display.ts        # Console formatting helpers
├── bot/
│   ├── runner.ts         # Main bot loop orchestration
│   ├── executor.ts       # Entry/exit execution logic
│   └── index.ts
├── exchanges/
│   ├── hyperliquid.ts    # @nktkas/hyperliquid SDK
│   ├── lighter.ts        # lighter-ts-sdk (authenticated)
│   ├── lighter-api.ts    # Lighter REST API (public)
│   └── types.ts          # Common types
├── strategy/
│   ├── engine.ts         # Entry/exit decisions
│   ├── funding-history.ts # Historical analysis & spike detection
│   ├── discovery.ts      # Auto-discovery service
│   └── types.ts          # Strategy types
├── execution/
│   ├── router.ts         # Dual-leg execution with reconciliation
│   └── risk.ts           # Risk management, margin checks, drift
├── infra/
│   ├── state-store.ts    # Position & history persistence
│   ├── pnl-tracker.ts    # Trade & funding PnL tracking
│   ├── rate-limiter.ts   # API rate limiting
│   └── funding-times.ts  # Funding time utilities
└── index.ts              # Main exports
```

## Key Improvements

### P0 Fixes (Critical)
- ✅ **Atomic execution** — Emergency reconciliation when one leg fails
- ✅ **Fill tracking** — Lighter fills detected via position change polling

### P1 Fixes (High Priority)
- ✅ **Correct PnL math** — Delta-neutral position PnL calculation
- ✅ **Funding tracking** — Actual funding payments from exchanges
- ✅ **Drift detection** — Position verification with rebalancing

### P2 Fixes (Medium Priority)
- ✅ **Size normalization** — Round to coarser lot size for balance
- ✅ **Margin checks** — Verify free margin before trades
- ✅ **Rate limiting** — Prevent API rate limit violations

### P3 Fixes (Low Priority)
- ✅ **Cancel orders** — Implemented for Hyperliquid
- ✅ **Fee rates** — Using exchange-specific fee rates

## Development

```sh
pnpm typecheck    # Type check
pnpm test         # Run tests (59 tests)
pnpm test:watch   # Watch mode
pnpm build        # Build
```

## Risk Warnings

⚠️ **This is experimental software. Use at your own risk.**

- Start with small notional sizes (e.g., $50-100)
- Use `--dry-run` mode first to validate behavior
- Monitor actively during first 24 hours
- Both exchanges charge funding every 8 hours (00:00, 08:00, 16:00 UTC)
- One-sided fills can cause directional exposure (mitigated but not eliminated)

## SDKs Used

- [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) — Hyperliquid TypeScript SDK
- [`lighter-ts-sdk`](https://github.com/bvvvp009/lighter-ts) — Lighter TypeScript SDK with WASM signer
