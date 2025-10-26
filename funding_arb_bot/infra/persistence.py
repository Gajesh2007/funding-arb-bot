"""Position persistence for crash recovery."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Dict

logger = logging.getLogger(__name__)


class PositionStore:
    """Persist open positions to disk for crash recovery."""

    def __init__(self, path: Path | str = ".positions.json") -> None:
        self._path = Path(path)

    def save(self, positions: Dict[str, Dict[str, float | str]]) -> None:
        """Save positions to disk."""
        try:
            with open(self._path, "w") as f:
                json.dump(positions, f, indent=2)
        except Exception as e:
            logger.error("position_save_failed", extra={"error": str(e)})

    def load(self) -> Dict[str, Dict[str, float | str]]:
        """Load positions from disk."""
        if not self._path.exists():
            return {}
        try:
            with open(self._path, "r") as f:
                return json.load(f)
        except Exception as e:
            logger.error("position_load_failed", extra={"error": str(e)})
            return {}

    def clear(self) -> None:
        """Clear persisted positions."""
        if self._path.exists():
            self._path.unlink()

