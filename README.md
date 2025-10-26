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

Create a `.env` file or export environment variables:

```
ENVIRONMENT=dev
BASE_CURRENCY=USDC

HYPERLIQUID__BASE_URL=https://api.hyperliquid.xyz
HYPERLIQUID__CREDENTIALS__PRIVATE_KEY=0xabc...
HYPERLIQUID__SYMBOLS=ETH,BTC

LIGHTER__BASE_URL=https://mainnet.zklighter.elliot.ai
LIGHTER__CREDENTIALS__PRIVATE_KEY=0xabc...
LIGHTER__SYMBOLS=ETH,BTC

RISK__MAX_TOTAL_NOTIONAL=10000
RISK__MAX_SYMBOL_NOTIONAL=5000
RISK__MAX_LEVERAGE=5
RISK__MARGIN_BUFFER_RATIO=0.15
RISK__DRIFT_THRESHOLD_BPS=25

STRATEGY__MIN_EDGE_BPS=20
STRATEGY__EXIT_EDGE_BPS=5
STRATEGY__FUNDING_HORIZON_HOURS=24
STRATEGY__REBALANCE_INTERVAL_SECONDS=60
STRATEGY__STALE_DATA_SECONDS=120
STRATEGY__TRACKED_SYMBOLS=ETH,BTC

EXECUTION__ORDER_NOTIONAL=500
EXECUTION__SLIPPAGE_BPS=5
EXECUTION__TIME_IN_FORCE=ioc
```

## Running

```sh
poetry run python -m funding_arb_bot.cli.main run --log-level INFO
```

## Funding Scan Utility

```sh
poetry run python -m funding_arb_bot.cli.main funding-scan --hl-symbol ETH --hl-symbol BTC
```

## Notes

- Ensure adequate balances on both exchanges and monitor margin requirements.
- Execution is best-effort; failed hedges trigger cancellation attempts but manual supervision is recommended.
- Extend strategy thresholds and execution rules to match your risk appetite before deploying with real capital.

