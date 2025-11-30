# Funding Arbitrage Bot

Market-neutral funding rate arbitrage bot trading between Lighter and Hyperliquid perpetuals.

**Now in TypeScript** — uses `@nktkas/hyperliquid` and `lighter-ts-sdk` for native SDK integration.

## Prerequisites

- Node.js 20+
- pnpm (or npm)
- Accounts on Lighter and Hyperliquid with trading permissions
- Private keys for both venues (for live trading)

## Installation

```sh
pnpm install
```

## Quick Start

### Spot Opportunities (Read-Only)

Scan for funding rate arbitrage opportunities without trading:

```sh
# Run once
pnpm spot --once

# Continuous scanning (default: every 60 seconds)
pnpm spot

# With options
pnpm spot --min-edge 10 --verbose --symbols ETH BTC SOL
```

### View Current Rates

```sh
npx tsx src/cli/main.ts rates
npx tsx src/cli/main.ts rates --symbols ETH BTC SOL
```

## CLI Reference

```
Usage: funding-arb [options] [command]

Commands:
  spot [options]   Continuously spot funding arbitrage opportunities
  rates [options]  Show current funding rates from both exchanges
  help [command]   Display help for command

Spot Options:
  -e, --min-edge <bps>     Minimum funding rate edge in basis points (default: 20)
  -s, --symbols <list>     Symbols to track (default: all common)
  -v, --verbose            Show all compared symbols
  -i, --interval <sec>     Scan interval in seconds (default: 60)
  --once                   Run scan once and exit

Rates Options:
  -s, --symbols <list>     Symbols to show
```

## Configuration

Create a `.env` file for trading credentials:

```env
# Hyperliquid (optional - only needed for trading)
HYPERLIQUID_PRIVATE_KEY=0x...

# Lighter (required for trading)
LIGHTER_PRIVATE_KEY=0x...
LIGHTER_ACCOUNT_INDEX=0
LIGHTER_API_KEY_INDEX=0
```

## Understanding Funding Rates

- **Hyperliquid**: Pays/charges funding every **1 hour** (native rate is hourly)
- **Lighter**: Pays/charges funding every **8 hours** (native rate is 8-hourly)
- The CLI normalizes all rates to **8-hour** for apples-to-apples comparison
- **Edge (bps)**: Difference between normalized rates × 10,000
- **APY**: `|edge_bps| × 3 × 365 / 100` (3 payments per day at 8hr intervals)

### Example Output

```
🔍 Scanning for funding arb opportunities (min edge: 20 bps)...

Note: All rates normalized to 8hr for comparison (HL native=1hr, Lighter native=8hr)

Symbol         HL 8hr %    Ltr 8hr %       Edge      APY % Direction
====================================================================================================
YZY           0.010000    0.436800    -42.68     467.3 Long Hyperliquid / Short Lighter

✅ Found 1 opportunities at 2:45:14 PM
```

### Direction Interpretation

| Direction | Action |
|-----------|--------|
| Long Lighter / Short Hyperliquid | HL rate > Lighter rate: Go long on Lighter (receive HL funding, pay Lighter funding) |
| Long Hyperliquid / Short Lighter | Lighter rate > HL rate: Go long on Hyperliquid (receive Lighter funding, pay HL funding) |

## Project Structure

```
src/
├── cli/
│   └── main.ts         # CLI entry point
├── exchanges/
│   ├── types.ts        # Core types (Side, OrderType, etc.)
│   ├── hyperliquid.ts  # Hyperliquid client using @nktkas/hyperliquid
│   ├── lighter.ts      # Lighter client using lighter-ts-sdk
│   └── index.ts        # Exports
└── index.ts            # Main export
```

## Development

```sh
# Type check
pnpm typecheck

# Build
pnpm build

# Run development with auto-reload
pnpm dev
```

## SDKs Used

- **Hyperliquid**: [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) — Unofficial TypeScript SDK
- **Lighter**: [`lighter-ts-sdk`](https://github.com/bvvvp009/lighter-ts) — Unofficial TypeScript SDK with WASM signer

## Safety Notes

- The `spot` command is read-only and doesn't require private keys
- Always test with small sizes when live trading
- Both exchanges charge funding every 8 hours (00:00, 08:00, 16:00 UTC typically)
- Monitor rates before committing capital
