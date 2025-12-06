import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../src/infra/rate-limiter.js";

describe("RateLimiter", () => {
  describe("throttle", () => {
    it("enforces minimum interval between calls", async () => {
      const limiter = new RateLimiter(50, 1000); // 50ms min interval

      const start = Date.now();
      await limiter.throttle("test");
      await limiter.throttle("test");
      await limiter.throttle("test");
      const elapsed = Date.now() - start;

      // Should take at least 100ms for 3 calls with 50ms interval
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some timing variance
    });

    it("uses separate limits per key", async () => {
      const limiter = new RateLimiter(50, 1000);

      const start = Date.now();
      await Promise.all([
        limiter.throttle("key1"),
        limiter.throttle("key2"),
        limiter.throttle("key3"),
      ]);
      const elapsed = Date.now() - start;

      // Different keys should not block each other
      expect(elapsed).toBeLessThan(30);
    });

    it("does not block when interval has passed", async () => {
      const limiter = new RateLimiter(10, 1000); // 10ms interval

      await limiter.throttle("test");
      await new Promise((r) => setTimeout(r, 20)); // Wait longer than interval

      const start = Date.now();
      await limiter.throttle("test");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10);
    });
  });

  describe("wrap", () => {
    it("wraps function with rate limiting", async () => {
      const limiter = new RateLimiter(20, 1000);
      let callCount = 0;

      const wrapped = limiter.wrap(async () => {
        callCount++;
        return callCount;
      }, "test");

      const start = Date.now();
      await wrapped();
      await wrapped();
      await wrapped();
      const elapsed = Date.now() - start;

      expect(callCount).toBe(3);
      expect(elapsed).toBeGreaterThanOrEqual(35); // ~40ms for 3 calls
    });

    it("preserves return value from wrapped function", async () => {
      const limiter = new RateLimiter(1, 1000);

      const wrapped = limiter.wrap(async () => {
        return { success: true, value: 42 };
      });

      const result = await wrapped();
      expect(result).toEqual({ success: true, value: 42 });
    });

    it("propagates errors from wrapped function", async () => {
      const limiter = new RateLimiter(1, 1000);

      const wrapped = limiter.wrap(async () => {
        throw new Error("Test error");
      });

      await expect(wrapped()).rejects.toThrow("Test error");
    });
  });

  describe("calls per minute limit", () => {
    it("tracks calls within minute window", async () => {
      // This test uses a high limit to avoid actual waiting
      const limiter = new RateLimiter(1, 100);

      // Make several rapid calls
      for (let i = 0; i < 10; i++) {
        await limiter.throttle("test");
      }

      // Should complete without long waits since we're under the limit
      // The test passing without timeout is the assertion
    });
  });

  describe("default parameters", () => {
    it("uses default values when not specified", async () => {
      const limiter = new RateLimiter();

      // Should not throw with default config
      await limiter.throttle();
      await limiter.throttle("custom-key");
    });
  });
});
