/**
 * Funding Time Utilities
 *
 * Helpers for working with funding settlement times (00:00, 08:00, 16:00 UTC).
 */

const FUNDING_HOURS_UTC = [0, 8, 16];

/**
 * Get the next funding settlement time.
 */
export function getNextFundingTime(): Date {
  const now = new Date();

  for (const hour of FUNDING_HOURS_UTC) {
    const fundingTime = new Date(now);
    fundingTime.setUTCHours(hour, 0, 0, 0);

    if (fundingTime > now) {
      return fundingTime;
    }
  }

  // Next funding is tomorrow at 00:00 UTC
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

/**
 * Check if we recently passed a funding time.
 */
export function justPassedFunding(withinMinutes: number = 5): boolean {
  const now = new Date();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const fundingMinutes = FUNDING_HOURS_UTC.map((h) => h * 60);

  for (const fundingMin of fundingMinutes) {
    const diff = nowMinutes - fundingMin;
    if (diff >= 0 && diff <= withinMinutes) {
      return true;
    }
  }

  return false;
}

/**
 * Get minutes until next funding.
 */
export function minutesUntilFunding(): number {
  const nextFunding = getNextFundingTime();
  return Math.round((nextFunding.getTime() - Date.now()) / 60_000);
}

