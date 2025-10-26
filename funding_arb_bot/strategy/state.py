from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict


class BotState(str, Enum):
    IDLE = "idle"
    ENTERING = "entering"
    HEDGED = "hedged"
    REBALANCING = "rebalancing"
    EXITING = "exiting"
    HALTED = "halted"


@dataclass
class StrategyContext:
    state: BotState = BotState.IDLE
    positions: Dict[str, Dict[str, float | str]] = field(default_factory=dict)


