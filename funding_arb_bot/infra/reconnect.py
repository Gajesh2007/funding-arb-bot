"""WebSocket and connection retry utilities."""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator, Callable, TypeVar

from tenacity import RetryError, retry, retry_if_exception_type, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)

T = TypeVar("T")


async def resilient_stream(
    stream_factory: Callable[[], AsyncIterator[T]],
    stream_name: str,
    max_retries: int = 5,
) -> AsyncIterator[T]:
    """Wrap an async iterator with automatic reconnection on failure.

    Args:
        stream_factory: Function that creates a new stream iterator
        stream_name: Name for logging
        max_retries: Maximum consecutive retry attempts

    Yields:
        Items from the underlying stream
    """
    retry_count = 0

    while retry_count < max_retries:
        try:
            logger.info(f"{stream_name}_connecting", extra={"retry": retry_count})
            stream = stream_factory()

            async for item in stream:
                retry_count = 0  # Reset on successful message
                yield item

        except Exception as e:
            retry_count += 1
            logger.error(
                f"{stream_name}_disconnected",
                extra={"error": str(e), "retry": retry_count, "max_retries": max_retries},
            )

            if retry_count >= max_retries:
                logger.critical(f"{stream_name}_max_retries_exceeded")
                raise

            # Exponential backoff
            wait_seconds = min(2**retry_count, 60)
            logger.info(f"{stream_name}_reconnecting", extra={"wait_seconds": wait_seconds})
            await asyncio.sleep(wait_seconds)


@retry(
    retry=retry_if_exception_type((ConnectionError, TimeoutError, OSError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    reraise=True,
)
async def retry_api_call(coro):
    """Retry wrapper for API calls with exponential backoff.

    Args:
        coro: Coroutine to execute

    Returns:
        Result of the coroutine

    Raises:
        RetryError if all attempts fail
    """
    return await coro

