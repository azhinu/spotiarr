import { SettingsService } from "@/application/services/settings.service";
import { logger } from "@/infrastructure/utils/logger";
import { MusicServiceKey } from "./external.constants";
import { RateLimitService } from "./rate-limit.service";

/**
 * BaseSearchService - Abstract base class for search services with common rate-limiting logic
 */
export abstract class BaseSearchService {
  protected lastSearchTime: number = 0;
  protected abstract readonly serviceKey: MusicServiceKey;

  protected constructor(
    protected readonly settingsService: SettingsService,
    protected readonly rateLimitService: RateLimitService,
  ) {}

  /**
   * Sleep for a specified number of milliseconds
   */
  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Enforce rate limiting by ensuring minimum delay between searches
   * Uses a configurable delay from settings with a random multiplier (0.5 to 1.5)
   */
  protected async enforceRateLimit(serviceName: string): Promise<void> {
    const delayMs = await this.settingsService.getNumber("YT_SEARCH_DELAY_MS");
    const minDelay = delayMs || 1000; // Default 1 second

    // Apply random multiplier (0.5 to 1.5) to avoid thundering herd
    const multiplier = 0.5 + Math.random() * 1.0;
    const adjustedDelay = Math.round(minDelay * multiplier);

    const now = Date.now();
    const timeSinceLastSearch = now - this.lastSearchTime;

    if (timeSinceLastSearch < adjustedDelay) {
      const waitTime = adjustedDelay - timeSinceLastSearch;
      logger.debug(`Rate limiting ${serviceName} search: waiting ${waitTime}ms`);
      await this.sleep(waitTime);
    }

    this.lastSearchTime = Date.now();
  }

  /**
   * Update last search time to current time
   */
  protected updateLastSearchTime(): void {
    this.lastSearchTime = Date.now();
  }
}
