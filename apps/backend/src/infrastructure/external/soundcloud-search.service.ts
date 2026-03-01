import { execFile } from "child_process";
import { promisify } from "util";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { logger } from "@/infrastructure/utils/logger";
import { classifySoundCloudSearchError } from "./external-error-classifier.utils";
import { MusicServiceKey } from "./external.constants";
import { RateLimitService } from "./rate-limit.service";

const execFilePromise = promisify(execFile);

export class SoundCloudSearchService {
  private readonly ytDlpPath: string;
  private lastSearchTime: number = 0;
  private readonly serviceKey = MusicServiceKey.SoundCloudSearch;

  constructor(
    private readonly settingsService: SettingsService,
    ytDlpPath: string,
    private readonly rateLimitService: RateLimitService,
  ) {
    this.ytDlpPath = ytDlpPath;
  }

  /**
   * Sleep for a specified number of milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Enforce rate limiting by ensuring minimum delay between searches
   */
  private async enforceRateLimit(): Promise<void> {
    const delayMs = await this.settingsService.getNumber("YT_SEARCH_DELAY_MS");
    const minDelay = delayMs || 1000; // Default 1 second

    // Apply random multiplier (0.5 to 1.5)
    const multiplier = 0.5 + Math.random() * 1.0;
    const adjustedDelay = Math.round(minDelay * multiplier);

    const now = Date.now();
    const timeSinceLastSearch = now - this.lastSearchTime;

    if (timeSinceLastSearch < adjustedDelay) {
      const waitTime = adjustedDelay - timeSinceLastSearch;
      logger.debug(`Rate limiting SoundCloud search: waiting ${waitTime}ms`);
      await this.sleep(waitTime);
    }

    this.lastSearchTime = Date.now();
  }

  async findTrackUrl(artist: string, name: string): Promise<string> {
    // Check if SoundCloud is currently rate-limited
    const isBlocked = await this.rateLimitService.isBlocked(this.serviceKey);
    if (isBlocked) {
      const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
      const message = blockedUntil
        ? `SoundCloud search is rate-limited until ${new Date(blockedUntil).toISOString()}`
        : "SoundCloud search is currently rate-limited";
      logger.warn(`[SoundCloudSearchService] ${message}. Cannot search for "${artist} - ${name}"`);
      throw new AppError(429, "soundcloud_rate_limited", message);
    }

    // Enforce rate limiting before making the request
    await this.enforceRateLimit();

    // SoundCloud search with yt-dlp - format: "scsearch:query"
    const query = `${artist} - ${name}`;
    const searchUrl = `scsearch:${query}`;

    const args = [
      "--print",
      "webpage_url",
      "--skip-unavailable-fragments",
      "--no-warnings",
      "--no-playlist",
      "--ignore-errors",
      "--no-continue",
      searchUrl,
    ];

    try {
      const { stdout, stderr } = await execFilePromise(this.ytDlpPath, args);

      if (stderr) {
        logger.debug(`[SoundCloudSearchService] yt-dlp stderr output: ${stderr}`);
      }

      if (!stdout || !stdout.trim()) {
        logger.warn(
          `[SoundCloudSearchService] ⚠️  No results from SoundCloud for "${artist} - ${name}"`,
        );
        throw new AppError(404, "soundcloud_track_not_found", "Track not found on SoundCloud");
      }

      const urls = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0);

      // Find first SoundCloud URL in results
      const soundcloudUrl = urls.find((u) => u.includes("soundcloud.com"));

      if (soundcloudUrl) {
        return soundcloudUrl;
      }

      logger.warn(
        `[SoundCloudSearchService] ⚠️  SoundCloud returned results but no valid URLs: ${urls.join(", ")}`,
      );
      throw new AppError(404, "soundcloud_track_not_found", "Track not found on SoundCloud");
    } catch (error: unknown) {
      // If it's already an AppError, rethrow it
      if (error instanceof AppError) {
        throw error;
      }

      const errorClassification = classifySoundCloudSearchError(error);
      const status = errorClassification.status ? ` [${errorClassification.status}]` : "";
      logger.error(
        `[SoundCloudSearchService] ✗ ERROR${status} ${errorClassification.type}: ${errorClassification.message}`,
      );
      logger.debug(
        `[SoundCloudSearchService] Full error: ${error instanceof Error ? error.stack : String(error)}`,
      );

      // Depending on error type, set rate limit and provide more context
      if (errorClassification.type === "RATE_LIMITED") {
        await this.rateLimitService.setBlocked(this.serviceKey, "RATE_LIMIT_429");
        throw new AppError(
          429,
          "soundcloud_rate_limited",
          "SoundCloud rate limited. Please try again later.",
        );
      } else if (errorClassification.type === "FORBIDDEN") {
        await this.rateLimitService.setBlocked(this.serviceKey, "FORBIDDEN_403");
        throw new AppError(
          403,
          "soundcloud_forbidden",
          "Access forbidden by SoundCloud. Service paused.",
        );
      } else if (
        errorClassification.type === "NETWORK_ERROR" ||
        errorClassification.type === "DNS_ERROR"
      ) {
        await this.rateLimitService.setBlocked(this.serviceKey, "CONNECTION_TIMEOUT");
        throw new AppError(
          503,
          "soundcloud_network_error",
          "Cannot reach SoundCloud. Check your network connection.",
        );
      } else if (
        errorClassification.type === "SERVICE_UNAVAILABLE" ||
        errorClassification.type === "BAD_GATEWAY"
      ) {
        throw new AppError(
          503,
          "soundcloud_unavailable",
          "SoundCloud service is currently unavailable.",
        );
      }

      // Default: treat as not found so we try next source
      throw new AppError(404, "soundcloud_track_not_found", "Track not found on SoundCloud");
    }
  }
}
