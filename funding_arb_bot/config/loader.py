"""Utilities for loading application settings."""

from __future__ import annotations

from functools import lru_cache

from .schema import Settings


@lru_cache(maxsize=1)
def load_settings() -> Settings:
    """Load and cache application settings."""

    return Settings()


