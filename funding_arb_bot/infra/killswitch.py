"""Circuit breaker and kill switch for emergency halt."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict

logger = logging.getLogger(__name__)


@dataclass
class KillSwitch:
    """Circuit breaker tracking failures and emergency conditions."""

    max_consecutive_failures: int = 3
    max_total_failures_per_hour: int = 10
    
    consecutive_failures: int = 0
    total_failures: int = 0
    failure_timestamps: list[float] = field(default_factory=list)
    is_tripped: bool = False
    trip_reason: str = ""

    def record_success(self) -> None:
        """Reset consecutive failure counter on success."""
        self.consecutive_failures = 0

    def record_failure(self, reason: str) -> bool:
        """Record a failure and check if kill switch should trip.

        Args:
            reason: Failure description

        Returns:
            True if kill switch was tripped
        """
        import time

        self.consecutive_failures += 1
        self.total_failures += 1
        self.failure_timestamps.append(time.time())

        # Prune old timestamps (keep last hour)
        cutoff = time.time() - 3600
        self.failure_timestamps = [ts for ts in self.failure_timestamps if ts > cutoff]

        # Check trip conditions
        if self.consecutive_failures >= self.max_consecutive_failures:
            self.trip(f"Consecutive failures: {self.consecutive_failures} ({reason})")
            return True

        if len(self.failure_timestamps) >= self.max_total_failures_per_hour:
            self.trip(f"Too many failures in 1 hour: {len(self.failure_timestamps)}")
            return True

        return False

    def trip(self, reason: str) -> None:
        """Activate kill switch."""
        self.is_tripped = True
        self.trip_reason = reason
        logger.critical("KILL_SWITCH_TRIPPED", extra={"reason": reason})

    def reset(self) -> None:
        """Manually reset kill switch (admin action)."""
        self.is_tripped = False
        self.trip_reason = ""
        self.consecutive_failures = 0
        logger.warning("kill_switch_reset")


@dataclass
class MarginMonitor:
    """Track margin health across exchanges."""

    margin_buffer_ratio: float
    positions_by_exchange: Dict[str, float] = field(default_factory=dict)
    last_margin_check: float = 0.0

    def update_margin_usage(self, exchange: str, utilization: float) -> bool:
        """Update margin utilization and check if approaching danger.

        Args:
            exchange: Exchange name
            utilization: Margin utilization ratio (0-1)

        Returns:
            True if margin is critically low
        """
        self.positions_by_exchange[exchange] = utilization

        if utilization > (1 - self.margin_buffer_ratio):
            logger.error(
                "margin_critical",
                extra={"exchange": exchange, "utilization": utilization, "buffer": self.margin_buffer_ratio},
            )
            return True

        if utilization > 0.75:
            logger.warning("margin_high", extra={"exchange": exchange, "utilization": utilization})

        return False

