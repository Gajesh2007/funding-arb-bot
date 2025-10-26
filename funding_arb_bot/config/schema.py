"""Pydantic settings models for the funding arbitrage bot."""

from __future__ import annotations

from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ExchangeCredentials(BaseModel):
    """Credential payload for exchange clients."""

    api_key: Optional[str] = Field(default=None, alias="API_KEY")
    api_secret: Optional[str] = Field(default=None, alias="API_SECRET")
    api_passphrase: Optional[str] = Field(default=None, alias="API_PASSPHRASE")
    private_key: Optional[str] = Field(default=None, alias="PRIVATE_KEY")


class ExchangeConfig(BaseModel):
    """Static exchange config used by connectors and risk checks."""

    name: Literal["hyperliquid", "lighter"]
    base_url: str
    websocket_url: Optional[str] = None
    symbols: List[str] = Field(default_factory=list)
    account_id: Optional[str] = None
    account_address: Optional[str] = None
    credentials: ExchangeCredentials


class RiskLimits(BaseModel):
    """Global and per-symbol risk limits."""

    max_total_notional: float = Field(..., gt=0)
    max_symbol_notional: float = Field(..., gt=0)
    max_leverage: float = Field(..., gt=0)
    margin_buffer_ratio: float = Field(..., gt=0, lt=1)
    drift_threshold_bps: float = Field(..., gt=0)


class StrategyThresholds(BaseModel):
    """Strategy parameters controlling entry/exit logic."""

    min_edge_bps: float = Field(..., gt=0)
    exit_edge_bps: float = Field(..., gt=0)
    funding_horizon_hours: float = Field(..., gt=0)
    rebalance_interval_seconds: int = Field(..., gt=0)
    stale_data_seconds: int = Field(..., gt=0)
    tracked_symbols: List[str] = Field(..., min_length=1)


class TimeInForce(str, Enum):
    IOC = "ioc"
    GTT = "gtt"
    POST_ONLY = "post_only"


class ExecutionConfig(BaseModel):
    """Execution parameters for order placement."""

    order_notional: float = Field(..., gt=0)
    slippage_bps: float = Field(default=5.0, gt=0)
    time_in_force: TimeInForce = TimeInForce.IOC


class Settings(BaseSettings):
    """Root settings object loaded from env/config files."""

    model_config = SettingsConfigDict(env_file=".env", env_nested_delimiter="__", case_sensitive=False)

    environment: Literal["prod", "staging", "dev"] = "dev"
    base_currency: str = "USDC"
    poll_interval_seconds: float = 1.0

    hyperliquid: ExchangeConfig
    lighter: ExchangeConfig

    risk: RiskLimits
    strategy: StrategyThresholds
    execution: ExecutionConfig

    sentry_dsn: Optional[str] = None
    metrics_enabled: bool = True


