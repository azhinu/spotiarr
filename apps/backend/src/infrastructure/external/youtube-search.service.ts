import { execFile, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { promisify } from "util";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { RateLimitService, type ErrorType } from "./rate-limit.service";

const execFilePromise = promisify(execFile);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export class YoutubeSearchService {
  private readonly ytDlpPath: string;
  private lastSearchTime: number = 0;
  private readonly serviceKey = "youtube:search" as const;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly rateLimitService: RateLimitService,
  ) {
    // Auto-detect yt-dlp path from system PATH
    try {
      const systemPath = execSync("which yt-dlp", {
        encoding: "utf-8",
      }).trim();

      // WORKAROUND: ytdlp-nodejs tries to chmod the binary, which fails for /usr/bin/yt-dlp in Docker
      // We copy it to a local writable path (tmp dir) so the library can do its thing
      const localPath = join(os.tmpdir(), "yt-dlp");

      // Only copy if it doesn't exist or is different (simple check)
      if (!fs.existsSync(localPath)) {
        console.debug(`Copying system yt-dlp to ${localPath} to avoid permission issues`);
        fs.copyFileSync(systemPath, localPath);
        fs.chmodSync(localPath, 0o755);
      }

      this.ytDlpPath = localPath;
      console.debug(`Using yt-dlp from: ${this.ytDlpPath}`);
    } catch (e) {
      console.warn("yt-dlp not found in PATH, will try default 'yt-dlp' command", e);
      this.ytDlpPath = "yt-dlp";
    }
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
      console.debug(`Rate limiting YouTube search: waiting ${waitTime}ms`);
      await this.sleep(waitTime);
    }

    this.lastSearchTime = Date.now();
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

    // Rate limit errors
    if (
      errorStr.includes("rate-limited by YouTube") ||
      errorStr.includes("rate-limited") ||
      errorStr.includes("rate limit") ||
      errorStr.includes("429")
    ) {
      return {
        type: "RATE_LIMITED",
        status: "429",
        message: "YouTube rate limited (429)",
        errorType: "RATE_LIMIT_429",
      };
    }

    // HTTP Status codes
    if (errorStr.includes("403")) {
      return {
        type: "FORBIDDEN",
        status: "403",
        message: "Access forbidden (403)",
        errorType: "FORBIDDEN_403",
      };
    }
    if (errorStr.includes("404")) {
      return { type: "NOT_FOUND", status: "404", message: "Video not found (404)" };
    }
    if (errorStr.includes("502")) {
      return { type: "BAD_GATEWAY", status: "502", message: "YouTube gateway error (502)" };
    }
    if (errorStr.includes("503")) {
      return { type: "SERVICE_UNAVAILABLE", status: "503", message: "YouTube unavailable (503)" };
    }

    // Content availability
    if (
      errorStr.includes("This content isn't available") ||
      errorStr.includes("Video unavailable") ||
      errorStr.includes("not available")
    ) {
      return { type: "CONTENT_UNAVAILABLE", message: "Video content is unavailable" };
    }

    // Network errors - including yt-dlp specific timeout messages
    if (
      errorStr.includes("Connection") ||
      errorStr.includes("timeout") ||
      errorStr.includes("read operation timed out") ||
      errorStr.includes("Giving up after") ||
      errorStr.includes("ECONNREFUSED")
    ) {
      return {
        type: "NETWORK_ERROR",
        message: "Network error: Connection timeout or read error",
        errorType: "CONNECTION_TIMEOUT",
      };
    }
    if (errorStr.includes("ENOTFOUND") || errorStr.includes("getaddrinfo")) {
      return {
        type: "DNS_ERROR",
        message: "DNS error: Cannot resolve YouTube domain",
        errorType: "CONNECTION_TIMEOUT",
      };
    }

    // Unknown error
    return { type: "UNKNOWN", message: errorStr.substring(0, 200) };
  }

  /**
   * Check if error is a rate limit error
   */
  private isRateLimitError(error: unknown): boolean {
    const errorClassification = this.classifyError(error);
    return errorClassification.type === "RATE_LIMITED";
  }

  /**
   * Execute yt-dlp search with rate limit detection
   */
  private async executeSearch(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFilePromise(this.ytDlpPath, args);
      return stdout;
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string };

      // If yt-dlp fails but printed a URL to stdout, use it
      if (err.stdout && typeof err.stdout === "string") {
        const urls = err.stdout.trim().split("\n");
        const firstUrl = urls.find((u: string) => u.trim().length > 0);
        if (firstUrl) {
          return err.stdout;
        }
      }

      // Check if it's a rate limit error
      if (this.isRateLimitError(error)) {
        const errorClassification = this.classifyError(error);
        await this.rateLimitService.setBlocked(this.serviceKey, errorClassification.errorType || "RATE_LIMIT_429");
        const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
        const untilTime = blockedUntil ? new Date(blockedUntil).toISOString() : "unknown";
        throw new YoutubeRateLimitError(
          `YouTube rate-limited - paused until ${untilTime}`,
        );
      }

      throw error;
    }
  }

  async findOnYoutubeOne(artist: string, name: string): Promise<string> {

    // Check if YouTube is currently rate-limited
    const isBlocked = await this.rateLimitService.isBlocked(this.serviceKey);
    if (isBlocked) {
      const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
      const message = blockedUntil
        ? `YouTube is rate-limited until ${new Date(blockedUntil).toISOString()}`
        : "YouTube is currently rate-limited";
      throw new YoutubeRateLimitError(message);
    }

    // Enforce rate limiting before making the request
    await this.enforceRateLimit();

    const args = [
      "--print",
      "webpage_url",
      `ytsearch3:${artist} - ${name}`,
      "--no-warnings",
      "--no-playlist",
      "--ignore-errors",
      "--user-agent",
      HEADERS["User-Agent"],
    ];

    // Get cookies browser from settings
    const ytCookies = await this.settingsService.getString("YT_COOKIES");
    if (ytCookies) {
      // Check if it's a file path or a browser name
      const isFile = ytCookies.includes("/") || ytCookies.endsWith(".txt");
      if (isFile) {
        args.push("--cookies", ytCookies);
      } else {
        args.push("--cookies-from-browser", ytCookies);
      }
    }

    try {
      const stdout = await this.executeSearch(args);
      const urls = stdout.trim().split("\n");
      // Get first non-empty line
      const firstUrl = urls.find((u) => u.trim().length > 0);

      if (!firstUrl) {
        throw new AppError(404, "track_not_found", "No results found");
      }

      console.debug(`Found ${artist} - ${name} on ${firstUrl}`);
      return firstUrl;
    } catch (error: unknown) {
      console.error(`Error searching ${artist} - ${name} with yt-dlp:`, error);
      throw error;
    }
  }

  // Helper to expose path to DownloadService if needed, or we can duplicate detection logic (it's small)
  getYtDlpPath(): string {
    return this.ytDlpPath;
  }
}
