import { logger } from "@/infrastructure/utils/logger";

const MIN_BLOCK_MS = 3 * 60 * 1000; // 3 minutes
const MAX_BLOCK_MS = 15 * 60 * 1000; // 15 minutes

/**
 * In-memory storage for rate limit state
 * This is sufficient because:
 * 1. All workers run in the same process
 * 2. Rate limit state is temporary (3-15 minutes duration)
 * 3. If process restarts, the state resets naturally
 */
let rateLimitBlockedUntil: number | null = null;

/**
 * Get random delay between min and max milliseconds
 */
function getRandomBlockDuration(): number {
  return MIN_BLOCK_MS + Math.floor(Math.random() * (MAX_BLOCK_MS - MIN_BLOCK_MS));
}

export class YoutubeRateLimitService {
  /**
   * Check if YouTube is currently rate-limited
   */
  async isRateLimited(): Promise<boolean> {
    if (rateLimitBlockedUntil === null) {
      return false;
    }

    const now = Date.now();
    if (now < rateLimitBlockedUntil) {
      return true;
    }

    // Block time has expired, clean it up
    rateLimitBlockedUntil = null;
    return false;
  }

  /**
   * Get the time when rate limit will be lifted (ms since epoch)
   */
  async getRateLimitUntil(): Promise<number | null> {
    if (rateLimitBlockedUntil === null) {
      return null;
    }

    const now = Date.now();
    if (now < rateLimitBlockedUntil) {
      return rateLimitBlockedUntil;
    }

    // Block time has expired
    rateLimitBlockedUntil = null;
    return null;
  }

  /**
   * Set YouTube as rate-limited for a random duration between 3-15 minutes
   */
  async setRateLimited(): Promise<void> {
    const blockDuration = getRandomBlockDuration();
    const blockUntil = Date.now() + blockDuration;
    rateLimitBlockedUntil = blockUntil;
    const durationMinutes = Math.round(blockDuration / 60000);
    logger.warn(
      `[YoutubeRateLimitService] YouTube rate limited. Blocked for ${durationMinutes} minutes until ${new Date(blockUntil).toISOString()}`,
    );
  }

  /**
   * Clear the rate limit status
   */
  async clearRateLimit(): Promise<void> {
    rateLimitBlockedUntil = null;
    logger.log("[YoutubeRateLimitService] Rate limit cleared");
  }
}
