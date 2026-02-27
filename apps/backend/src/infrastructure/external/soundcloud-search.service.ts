import { execFile } from "child_process";
import { promisify } from "util";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { RateLimitService, type ErrorType } from "./rate-limit.service";

const execFilePromise = promisify(execFile);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export class SoundCloudSearchService {
  private readonly ytDlpPath: string;
  private lastSearchTime: number = 0;
  private rateLimitQueue: Promise<void> = Promise.resolve();
  private readonly serviceKey = "soundcloud:search" as const;

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
    this.rateLimitQueue = this.rateLimitQueue
      .then(async () => {
        await this.waitForRateLimitBlock();

        const delayMs = await this.settingsService.getNumber("YT_SEARCH_DELAY_MS");
        const minDelay = delayMs || 1000; // Default 1 second

        // Apply random multiplier (0.5 to 1.5)
        const multiplier = 0.5 + Math.random() * 1.0;
        const adjustedDelay = Math.round(minDelay * multiplier);

        const now = Date.now();
        const timeSinceLastSearch = now - this.lastSearchTime;

        if (timeSinceLastSearch < adjustedDelay) {
          const waitTime = adjustedDelay - timeSinceLastSearch;
          console.debug(`Rate limiting SoundCloud search: waiting ${waitTime}ms`);
          await this.sleep(waitTime);
        }

        this.lastSearchTime = Date.now();
      })
      .catch(() => undefined);

    await this.rateLimitQueue;
  }

  private async waitForRateLimitBlock(): Promise<void> {
    const isBlocked = await this.rateLimitService.isBlocked(this.serviceKey);
    if (!isBlocked) {
      return;
    }

    const remainingTime = await this.rateLimitService.getRemainingTime(this.serviceKey);
    if (remainingTime && remainingTime > 0) {
      console.warn(
        `[SoundCloudSearchService] Rate limited. Waiting ${remainingTime}ms before continuing...`,
      );
      await this.sleep(remainingTime);
    }
  }

  /**
   * Extract HTTP status code from error message
   */
  private extractHttpStatus(error: unknown): string | null {
    const errorStr =
      (error as { stderr?: string; message?: string }).stderr ||
      (error as Error).message ||
      String(error);

    // Look for HTTP status codes: 404, 429, 502, 503, etc.
    const statusMatch = errorStr.match(/(\d{3})/);
    if (statusMatch) {
      return statusMatch[1];
    }
    return null;
  }

  /**
   * Classify error type for better debugging
   */
  private classifyError(
    error: unknown,
  ): { type: string; status?: string; message: string; errorType?: ErrorType } {
    const errorStr =
      (error as { stderr?: string; message?: string }).stderr ||
      (error as Error).message ||
      String(error);

    // HTTP Status codes
    if (errorStr.includes("404")) {
      return { type: "NOT_FOUND", status: "404", message: "Track not found (404)" };
    }
    if (errorStr.includes("429")) {
      return {
        type: "RATE_LIMITED",
        status: "429",
        message: "Rate limited by SoundCloud (429)",
        errorType: "RATE_LIMIT_429",
      };
    }
    if (errorStr.includes("502")) {
      return { type: "BAD_GATEWAY", status: "502", message: "SoundCloud gateway error (502)" };
    }
    if (errorStr.includes("503")) {
      return {
        type: "SERVICE_UNAVAILABLE",
        status: "503",
        message: "SoundCloud service unavailable (503)",
      };
    }
    if (errorStr.includes("403")) {
      return {
        type: "FORBIDDEN",
        status: "403",
        message: "Access forbidden by SoundCloud (403)",
        errorType: "FORBIDDEN_403",
      };
    }
    if (errorStr.includes("401")) {
      return { type: "UNAUTHORIZED", status: "401", message: "Unauthorized access (401)" };
    }

    // Network errors
    if (
      errorStr.includes("Connection") ||
      errorStr.includes("timeout") ||
      errorStr.includes("ECONNREFUSED")
    ) {
      return {
        type: "NETWORK_ERROR",
        message: "Network error: Cannot connect to SoundCloud",
        errorType: "CONNECTION_TIMEOUT",
      };
    }
    if (
      errorStr.includes("ENOTFOUND") ||
      errorStr.includes("getaddrinfo") ||
      errorStr.includes("ERR_DNS")
    ) {
      return {
        type: "DNS_ERROR",
        message: "DNS error: Cannot resolve SoundCloud domain",
        errorType: "CONNECTION_TIMEOUT",
      };
    }

    // Service-specific errors
    if (errorStr.includes("No audio found") || errorStr.includes("not available")) {
      return { type: "NOT_AVAILABLE", message: "Track not available on SoundCloud" };
    }
    if (errorStr.includes("No matching tracks")) {
      return { type: "NO_RESULTS", message: "No matching tracks found" };
    }

    // Unknown error
    return { type: "UNKNOWN", message: errorStr.substring(0, 200) };
  }

  async findTrackUrl(artist: string, name: string): Promise<string> {

    // Check if SoundCloud is currently rate-limited
    const isBlocked = await this.rateLimitService.isBlocked(this.serviceKey);
    if (isBlocked) {
      const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
      const message = blockedUntil
        ? `SoundCloud search is rate-limited until ${new Date(blockedUntil).toISOString()}`
        : "SoundCloud search is currently rate-limited";
      console.warn(`[SoundCloudSearchService] ${message}. Cannot search for "${artist} - ${name}"`);
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
        console.debug(`[SoundCloudSearchService] yt-dlp stderr output: ${stderr}`);
      }

      if (!stdout || !stdout.trim()) {
        console.warn(
          `[SoundCloudSearchService] ⚠️  No results from SoundCloud for "${artist} - ${name}"`,
        );
        throw new AppError(404, "soundcloud_track_not_found", "Track not found on SoundCloud");
      }

      const urls = stdout.trim().split("\n").filter((line) => line.trim().length > 0);

      // Find first SoundCloud URL in results
      const soundcloudUrl = urls.find((u) => u.includes("soundcloud.com"));

      if (soundcloudUrl) {
        return soundcloudUrl;
      }

      console.warn(
        `[SoundCloudSearchService] ⚠️  SoundCloud returned results but no valid URLs: ${urls.join(", ")}`,
      );
      throw new AppError(404, "soundcloud_track_not_found", "Track not found on SoundCloud");
    } catch (error: unknown) {
      // If it's already an AppError, rethrow it
      if (error instanceof AppError) {
        throw error;
      }

      const errorClassification = this.classifyError(error);
      const status = errorClassification.status ? ` [${errorClassification.status}]` : "";
      console.error(
        `[SoundCloudSearchService] ✗ ERROR${status} ${errorClassification.type}: ${errorClassification.message}`,
      );
      console.debug(
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
