# Funding Arbitrage Bot

Market-neutral funding rate arbitrage bot trading between Lighter and Hyperliquid perpetuals.

## Prerequisites

- Python 3.12+
- Poetry 2+
- Accounts on Lighter and Hyperliquid with trading permissions
- API private keys for both venues

## Installation

```sh
poetry install
```

## Configuration

Create a `.env` file (copy from `.env.example`) or export environment variables.

### Environment Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| **General Settings** | | | |
| `ENVIRONMENT` | Deployment environment | `dev`, `staging`, `prod` | No (default: `dev`) |
| `BASE_CURRENCY` | Base currency for notional calculations | `USDC` | No (default: `USDC`) |
| **Hyperliquid Configuration** | | | |
| `HYPERLIQUID__BASE_URL` | Hyperliquid API endpoint | `https://api.hyperliquid.xyz` | Yes |
| `HYPERLIQUID__CREDENTIALS__PRIVATE_KEY` | Your Hyperliquid wallet private key (0x...) | `0xabc123...` | Yes |
| `HYPERLIQUID__SYMBOLS` | Comma-separated symbols to trade | `ETH,BTC,SOL` | No |
| **Lighter Configuration** | | | |
| `LIGHTER__BASE_URL` | Lighter API endpoint | `https://mainnet.zklighter.elliot.ai` | Yes |
| `LIGHTER__CREDENTIALS__PRIVATE_KEY` | Your Lighter wallet private key (0x...) | `0xdef456...` | Yes |
| `LIGHTER__SYMBOLS` | Comma-separated symbols to trade | `ETH,BTC,SOL` | No |
| **Risk Management** | | | |
| `RISK__MAX_TOTAL_NOTIONAL` | Maximum total position size (USD) | `10000` | Yes |
| `RISK__MAX_SYMBOL_NOTIONAL` | Maximum per-symbol position size (USD) | `5000` | Yes |
| `RISK__MAX_LEVERAGE` | Maximum allowed leverage | `5` | Yes |
| `RISK__MARGIN_BUFFER_RATIO` | Minimum margin buffer (0-1) | `0.15` (15%) | Yes |
| `RISK__DRIFT_THRESHOLD_BPS` | Max position drift before rebalance (bps) | `25` | Yes |
| **Strategy Parameters** | | | |
| `STRATEGY__MIN_EDGE_BPS` | Minimum funding edge to enter (basis points) | `20` (0.2% per 8hr) | Yes |
| `STRATEGY__EXIT_EDGE_BPS` | Edge threshold to exit position (basis points) | `5` (0.05% per 8hr) | Yes |
| `STRATEGY__FUNDING_HORIZON_HOURS` | Funding rate calculation window | `24` | Yes |
| `STRATEGY__REBALANCE_INTERVAL_SECONDS` | How often to check for opportunities | `60` | Yes |
| `STRATEGY__STALE_DATA_SECONDS` | Max age before data is stale | `120` | Yes |
| `STRATEGY__TRACKED_SYMBOLS` | Comma-separated symbols to monitor | `ETH,BTC,SOL` | Yes |
| **Execution Settings** | | | |
| `EXECUTION__ORDER_NOTIONAL` | Order size in USD notional | `500` | Yes |
| `EXECUTION__SLIPPAGE_BPS` | Max acceptable slippage (basis points) | `5` (0.05%) | Yes |
| `EXECUTION__TIME_IN_FORCE` | Order time-in-force policy | `ioc`, `gtt`, `post_only` | Yes |

### Notes on Configuration

- **Funding rates are 8-hour intervals**: Both exchanges pay/charge funding every 8 hours (3x per day)
- **Basis points (bps)**: 100 bps = 1%. So 20 bps = 0.2% per 8-hour funding period
- **APY calculation**: Edge (bps) × 3 (payments/day) × 365 / 100 = annualized %
- **Private keys**: Must have 0x prefix, keep secure, never commit to git
- **Symbols**: Must exist and be actively traded on BOTH exchanges for arbitrage to work

## Running

### Spot Opportunities (Read-Only)

Continuously scan for arbitrage opportunities without executing trades:

```sh
# Scan all symbols with 20 bps minimum edge
poetry run python -m funding_arb_bot.cli.main spot

# Scan specific symbols with custom threshold
poetry run python -m funding_arb_bot.cli.main spot --min-edge-bps 10 --symbol ETH --symbol BTC --symbol SOL

# Verbose mode: show top compared pairs even below threshold
poetry run python -m funding_arb_bot.cli.main spot --verbose
```

### Funding Scan (One-Time)

Quick snapshot of current funding rates:

```sh
poetry run python -m funding_arb_bot.cli.main funding-scan --hl-symbol ETH --hl-symbol BTC
```

### Run Bot (Live Trading)

**⚠️ WARNING: This executes real trades. Start with small notional sizes.**

```sh
poetry run python -m funding_arb_bot.cli.main run --log-level INFO
```

## Command Reference

| Command | Description | Key Options |
|---------|-------------|-------------|
| `spot` | Continuously scan for opportunities (no trading) | `--min-edge-bps`, `--symbol`, `--verbose` |
| `funding-scan` | One-time funding rate snapshot | `--hl-symbol`, `--hours` |
| `run` | Start live trading bot | `--log-level` |

## Safety Notes

- **Always test with small notional sizes first** (e.g., `EXECUTION__ORDER_NOTIONAL=50`)
- Use `spot` command to validate opportunities before enabling live trading
- Ensure adequate balances on both exchanges and monitor margin requirements
- Execution is best-effort; failed hedges trigger cancellation attempts but manual supervision is recommended
- Both exchanges charge funding every **8 hours** (00:00, 08:00, 16:00 UTC typically)
- Monitor positions actively during first 24 hours of operation

