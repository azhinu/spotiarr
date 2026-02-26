import { execFile, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { promisify } from "util";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { YoutubeRateLimitService } from "./youtube-rate-limit.service";

const execFilePromise = promisify(execFile);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export class YoutubeSearchService {
  private readonly ytDlpPath: string;
  private lastSearchTime: number = 0;
  private readonly rateLimitService: YoutubeRateLimitService;

  constructor(private readonly settingsService: SettingsService) {
    this.rateLimitService = new YoutubeRateLimitService();
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

    const now = Date.now();
    const timeSinceLastSearch = now - this.lastSearchTime;

    if (timeSinceLastSearch < minDelay) {
      const waitTime = minDelay - timeSinceLastSearch;
      console.debug(`Rate limiting: waiting ${waitTime}ms before next search`);
      await this.sleep(waitTime);
    }

    this.lastSearchTime = Date.now();
  }

  /**
   * Classify error type for better debugging
   */
  private classifyError(
    error: unknown,
  ): { type: string; status?: string; message: string } {
    const errorStr =
      (error as { stderr?: string; message?: string }).stderr ||
      (error as Error).message ||
      String(error);

    // Rate limit errors
    if (
      errorStr.includes("rate-limited by YouTube") ||
      errorStr.includes("rate-limited") ||
      errorStr.includes("429")
    ) {
      return { type: "RATE_LIMITED", status: "429", message: "YouTube rate limited (429)" };
    }

    // HTTP Status codes
    if (errorStr.includes("403")) {
      return { type: "FORBIDDEN", status: "403", message: "Access forbidden (403)" };
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

    // Network errors
    if (
      errorStr.includes("Connection") ||
      errorStr.includes("timeout") ||
      errorStr.includes("ECONNREFUSED")
    ) {
      return { type: "NETWORK_ERROR", message: "Network error: Cannot connect to YouTube" };
    }
    if (errorStr.includes("ENOTFOUND") || errorStr.includes("getaddrinfo")) {
      return { type: "DNS_ERROR", message: "DNS error: Cannot resolve YouTube domain" };
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
   * Execute yt-dlp search with retry logic
   */
  private async executeSearch(
    args: string[],
    retryCount: number = 0,
    maxRetries: number = 3,
  ): Promise<string> {
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
        if (retryCount < maxRetries) {
          // Exponential backoff: 4s, 12s, 36s
          const backoffMs = 4000 * Math.pow(3, retryCount);
          console.warn(
            `Rate limit detected. Retry ${retryCount + 1}/${maxRetries} after ${backoffMs / 1000}s`,
          );
          await this.sleep(backoffMs);
          return this.executeSearch(args, retryCount + 1, maxRetries);
        } else {
          // Max retries exhausted - set random rate limit block (3-15 minutes)
          console.error("[YoutubeSearchService] YouTube rate limit detected after max retries!");
          await this.rateLimitService.setRateLimited();
          const blockedUntil = await this.rateLimitService.getRateLimitUntil();
          const untilTime = blockedUntil ? new Date(blockedUntil).toISOString() : "unknown";
          throw new YoutubeRateLimitError(
            `YouTube rate-limited - paused until ${untilTime}`,
          );
        }
      }

      throw error;
    }
  }

  async findOnYoutubeOne(artist: string, name: string): Promise<string> {
    console.debug(`Searching ${artist} - ${name} on YT`);

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
