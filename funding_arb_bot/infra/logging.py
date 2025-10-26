from __future__ import annotations

import logging
import sys

import structlog


def setup_logging(level: int = logging.INFO, json_format: bool = False) -> None:
    """Setup logging with optional JSON formatting."""
    if json_format:
        logging.basicConfig(level=level, format="%(message)s", stream=sys.stderr)
        structlog.configure(
            wrapper_class=structlog.make_filtering_bound_logger(level),
            processors=[
                structlog.processors.add_log_level,
                structlog.processors.TimeStamper(fmt="iso", utc=True),
                structlog.processors.JSONRenderer(),
            ],
        )
    else:
        logging.basicConfig(
            level=level,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
            stream=sys.stderr,
        )


