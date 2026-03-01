import { logger } from "@/infrastructure/utils/logger";
import { MusicServiceKey } from "./external.constants";

/**
 * RateLimitService - Centralized rate limit management for all music sources
 * Tracks blocking state per service with exponential backoff on repeated errors
 */

export type ServiceKey = MusicServiceKey;

export type ErrorType = "RATE_LIMIT_429" | "FORBIDDEN_403" | "CONNECTION_TIMEOUT" | "UNKNOWN";

interface RateLimitState {
  blockedUntil: number | null;
  retryCount: number;
  lastErrorType?: ErrorType;
}

/**
 * Get timeout configuration for a specific service and error type
 */
function getTimeoutConfig(serviceKey: ServiceKey, errorType: ErrorType) {
  const config: Record<ServiceKey, Record<ErrorType, { min: number; max: number }>> = {
    // SoundCloud
    [MusicServiceKey.SoundCloudSearch]: {
      RATE_LIMIT_429: { min: 30_000, max: 90_000 }, // 30-90 sec
      FORBIDDEN_403: { min: 30 * 60_000, max: 90 * 60_000 }, // 30-90 min
      CONNECTION_TIMEOUT: { min: 30 * 60_000, max: 90 * 60_000 }, // 30-90 min
      UNKNOWN: { min: 30 * 60_000, max: 90 * 60_000 }, // 30-90 min
    },
    [MusicServiceKey.SoundCloudDownload]: {
      RATE_LIMIT_429: { min: 30_000, max: 90_000 }, // 30-90 sec
      FORBIDDEN_403: { min: 30 * 60_000, max: 90 * 60_000 }, // 30-90 min
      CONNECTION_TIMEOUT: { min: 30 * 60_000, max: 90 * 60_000 }, // 30-90 min
      UNKNOWN: { min: 30 * 60_000, max: 90 * 60_000 }, // 30-90 min
    },

    // YouTube
    [MusicServiceKey.YoutubeSearch]: {
      RATE_LIMIT_429: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
      FORBIDDEN_403: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
      CONNECTION_TIMEOUT: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
      UNKNOWN: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
    },
    [MusicServiceKey.YoutubeDownload]: {
      RATE_LIMIT_429: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
      FORBIDDEN_403: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
      CONNECTION_TIMEOUT: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
      UNKNOWN: { min: 10 * 60_000, max: 30 * 60_000 }, // 10-30 min
    },
  };

  return config[serviceKey][errorType];
}

/**
 * Get random delay between min and max milliseconds
 */
function getRandomDelay(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

/**
 * Calculate exponential backoff delay with exponential factor
 */
function calculateBackoffDelay(min: number, max: number, retryCount: number): number {
  // Apply exponential backoff: multiplier = 2^retryCount
  const multiplier = Math.pow(2, Math.min(retryCount, 5)); // Cap at 2^5 = 32x
  const baseDelay = getRandomDelay(min, max);
  const delayWithBackoff = baseDelay * multiplier;

  // Cap the total delay at max * 32 to avoid absurdly long timeouts
  return Math.min(delayWithBackoff, max * 32);
}

export class RateLimitService {
  private readonly rateLimits: Map<ServiceKey, RateLimitState> = new Map();

  constructor() {
    // Initialize all service keys
    const services: ServiceKey[] = [
      MusicServiceKey.SoundCloudSearch,
      MusicServiceKey.SoundCloudDownload,
      MusicServiceKey.YoutubeSearch,
      MusicServiceKey.YoutubeDownload,
    ];

    for (const service of services) {
      this.rateLimits.set(service, {
        blockedUntil: null,
        retryCount: 0,
      });
    }
  }

  /**
   * Check if a service is currently rate-limited
   */
  async isBlocked(serviceKey: ServiceKey): Promise<boolean> {
    const state = this.rateLimits.get(serviceKey);
    if (!state || state.blockedUntil === null) {
      return false;
    }

    const now = Date.now();
    if (now < state.blockedUntil) {
      return true;
    }

    // Block time has expired, clean it up
    state.blockedUntil = null;
    state.retryCount = 0;
    state.lastErrorType = undefined;

    return false;
  }

  /**
   * Get the time when rate limit will be lifted (ms since epoch)
   */
  async getBlockedUntil(serviceKey: ServiceKey): Promise<number | null> {
    const state = this.rateLimits.get(serviceKey);
    if (!state) return null;

    if (state.blockedUntil === null) {
      return null;
    }

    const now = Date.now();
    if (now >= state.blockedUntil) {
      // Block time has expired
      state.blockedUntil = null;
      state.retryCount = 0;
      state.lastErrorType = undefined;
      return null;
    }

    return state.blockedUntil;
  }

  /**
   * Set a service as blocked due to an error
   * Uses exponential backoff if this is a retry
   */
  async setBlocked(serviceKey: ServiceKey, errorType: ErrorType = "UNKNOWN"): Promise<void> {
    const state = this.rateLimits.get(serviceKey);
    if (!state) return;

    const timeoutConfig = getTimeoutConfig(serviceKey, errorType);

    // Check if we're retrying (blockedUntil already exists and has passed)
    const isRetry = state.blockedUntil !== null && Date.now() >= state.blockedUntil;

    if (isRetry) {
      // This is a retry - increment counter and apply exponential backoff
      state.retryCount += 1;
      const backoffDelay = calculateBackoffDelay(
        timeoutConfig.min,
        timeoutConfig.max,
        state.retryCount - 1, // Apply backoff based on previous retries
      );
      state.blockedUntil = Date.now() + backoffDelay;

      const durationMinutes = Math.round(backoffDelay / 60000);
      const durationSeconds = Math.round(backoffDelay / 1000);
      const duration =
        backoffDelay >= 60000 ? `${durationMinutes} minutes` : `${durationSeconds} seconds`;

      logger.warn(
        `[RateLimitService] ${serviceKey} blocked (RETRY #${state.retryCount}) due to ${errorType}. ` +
          `Blocked for ${duration} until ${new Date(state.blockedUntil).toISOString()}`,
      );
    } else {
      // First error
      state.retryCount = 1;
      const delay = getRandomDelay(timeoutConfig.min, timeoutConfig.max);
      state.blockedUntil = Date.now() + delay;

      const durationMinutes = Math.round(delay / 60000);
      const durationSeconds = Math.round(delay / 1000);
      const duration = delay >= 60000 ? `${durationMinutes} minutes` : `${durationSeconds} seconds`;

      logger.warn(
        `[RateLimitService] ${serviceKey} blocked due to ${errorType}. ` +
          `Blocked for ${duration} until ${new Date(state.blockedUntil).toISOString()}`,
      );
    }

    state.lastErrorType = errorType;
  }

  /**
   * Clear the block status for a service
   */
  async clearBlock(serviceKey: ServiceKey): Promise<void> {
    const state = this.rateLimits.get(serviceKey);
    if (!state) return;

    state.blockedUntil = null;
    state.retryCount = 0;
    state.lastErrorType = undefined;

    logger.log(`[RateLimitService] Block cleared for ${serviceKey}`);
  }

  /**
   * Get current status report for all services
   */
  async getStatusReport(): Promise<
    Record<ServiceKey, { isBlocked: boolean; blockedUntil: number | null; retryCount: number }>
  > {
    const report: Record<
      ServiceKey,
      { isBlocked: boolean; blockedUntil: number | null; retryCount: number }
    > = {} as any;

    for (const [key, state] of this.rateLimits) {
      const isBlocked = await this.isBlocked(key);
      report[key] = {
        isBlocked,
        blockedUntil: state.blockedUntil,
        retryCount: state.retryCount,
      };
    }

    return report;
  }

  /**
   * Get remaining wait time in milliseconds for a blocked service
   */
  async getRemainingTime(serviceKey: ServiceKey): Promise<number | null> {
    const blockedUntil = await this.getBlockedUntil(serviceKey);
    if (blockedUntil === null) {
      return null;
    }

    const remaining = blockedUntil - Date.now();
    return remaining > 0 ? remaining : null;
  }
}
