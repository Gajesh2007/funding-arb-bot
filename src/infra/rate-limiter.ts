/**
 * Rate Limiter
 *
 * Simple rate limiter for API calls with per-key throttling.
 */

export class RateLimiter {
  private lastCallTime = new Map<string, number>();
  private callCounts = new Map<string, number[]>();

  constructor(
    private readonly minIntervalMs: number = 100,
    private readonly maxCallsPerMinute: number = 50
  ) {}

  /**
   * Wait if necessary to respect rate limits.
   */
  async throttle(key: string = "default"): Promise<void> {
    const now = Date.now();
    const lastCall = this.lastCallTime.get(key) ?? 0;
    const timeSinceLastCall = now - lastCall;

    // Enforce minimum interval
    if (timeSinceLastCall < this.minIntervalMs) {
      await this.sleep(this.minIntervalMs - timeSinceLastCall);
    }

    // Check calls per minute
    const calls = this.callCounts.get(key) ?? [];
    const oneMinuteAgo = now - 60_000;
    const recentCalls = calls.filter((t) => t > oneMinuteAgo);

    if (recentCalls.length >= this.maxCallsPerMinute) {
      const oldestCall = Math.min(...recentCalls);
      const waitTime = oldestCall + 60_000 - now;
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }

    // Record this call
    this.lastCallTime.set(key, Date.now());
    recentCalls.push(Date.now());
    this.callCounts.set(key, recentCalls.slice(-this.maxCallsPerMinute));
  }

  /**
   * Wrap an async function with rate limiting.
   */
  wrap<T>(fn: () => Promise<T>, key: string = "default"): () => Promise<T> {
    return async () => {
      await this.throttle(key);
      return fn();
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

