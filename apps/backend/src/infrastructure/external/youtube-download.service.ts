import { SUPPORTED_AUDIO_FORMATS, SupportedAudioFormat, type ITrack } from "@spotiarr/shared";
import { YtDlp } from "ytdlp-nodejs";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { RateLimitService, type ErrorType } from "./rate-limit.service";
import { YoutubeSearchService } from "./youtube-search.service";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export class YoutubeDownloadService {
  private readonly serviceKey = "youtube:download" as const;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly searchService: YoutubeSearchService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async downloadAndFormat(track: ITrack, output: string): Promise<void> {
    console.debug(`Downloading ${track.artist} - ${track.name} (${track.youtubeUrl}) from YT`);
    if (!track.youtubeUrl) {
      console.error("youtubeUrl is null or undefined");
      throw new AppError(400, "internal_server_error", "youtubeUrl is null or undefined");
    }

    // Check if YouTube is currently rate-limited
    const isBlocked = await this.rateLimitService.isBlocked(this.serviceKey);
    if (isBlocked) {
      const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
      const message = blockedUntil
        ? `YouTube download is rate-limited until ${new Date(blockedUntil).toISOString()}`
        : "YouTube download is currently rate-limited";
      console.warn(
        `[YoutubeDownloadService] ${message}. Cannot download: ${track.artist} - ${track.name}`,
      );
      throw new YoutubeRateLimitError(message);
    }

    console.info(
      `[YoutubeDownloadService] Starting download from YouTube: ${track.artist} - ${track.name} (${track.youtubeUrl})`,
    );

    const ytdlp = new YtDlp({
      binaryPath: this.searchService.getYtDlpPath(),
    });

    // Get format from settings with fallback to 'mp3'
    const configuredFormat = await this.settingsService.getString("FORMAT");
    const formatType = (
      SUPPORTED_AUDIO_FORMATS.includes(configuredFormat as SupportedAudioFormat)
        ? configuredFormat
        : "mp3"
    ) as SupportedAudioFormat;

    const audioQuality = await this.settingsService.getString("YT_AUDIO_QUALITY");
    const qualityMap: Record<string, 0 | 5 | 9> = {
      best: 0,
      good: 5,
      acceptable: 9,
    };
    const quality = (qualityMap[audioQuality] ?? 0) as 0 | 5 | 9;

    // Get cookies browser from settings
    const ytCookies = await this.settingsService.getString("YT_COOKIES");
    const isCookieFile = ytCookies && (ytCookies.includes("/") || ytCookies.endsWith(".txt"));

    try {
      console.debug(
        `[YoutubeDownloadService] yt-dlp config: format=${formatType}, quality=${quality}, output=${output}`,
      );
      await ytdlp.downloadAsync(track.youtubeUrl, {
        format: {
          filter: "audioonly",
          type: formatType,
          quality,
        },
        output,
        cookies: isCookieFile ? ytCookies : undefined,
        cookiesFromBrowser: !isCookieFile && ytCookies ? ytCookies : undefined,
        headers: HEADERS,
      });
      console.info(
        `[YoutubeDownloadService] ✓ SUCCESS: Downloaded ${track.artist} - ${track.name} from YouTube to ${output}`,
      );
    } catch (error) {
      // Check if this is a YouTube rate-limit error
      const errorMessage = this.getErrorMessage(error);
      console.error(
        `[YoutubeDownloadService] ✗ FAILED: Download error for ${track.artist} - ${track.name}: ${errorMessage}`,
      );
      const errorClassification = this.classifyError(errorMessage);

      if (errorClassification.type === "RATE_LIMITED") {
        console.error(`[YoutubeDownloadService] 🔴 RATE_LIMITED (429): ${errorMessage}`);
        await this.rateLimitService.setBlocked(this.serviceKey, "RATE_LIMIT_429");
        const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
        const untilTime = blockedUntil ? new Date(blockedUntil).toISOString() : "unknown";
        console.warn(`[YoutubeDownloadService] Service paused until ${untilTime}`);
        throw new YoutubeRateLimitError(`YouTube rate-limited - paused until ${untilTime}`);
      }
      throw error;
    }
  }

  /**
   * Extract error message from various error types
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Classify error type for better debugging
   */
  private classifyError(
    error: string,
  ): { type: string; message: string; errorType?: ErrorType } {
    // Rate limit errors
    if (
      error.includes("rate-limited by YouTube") ||
      error.includes("rate-limited") ||
      error.includes("rate limit") ||
      error.includes("429")
    ) {
      return {
        type: "RATE_LIMITED",
        message: "YouTube rate limited",
        errorType: "RATE_LIMIT_429",
      };
    }

    // Connection/timeout errors - including yt-dlp specific timeout messages
    if (
      error.includes("timeout") ||
      error.includes("Connection") ||
      error.includes("read operation timed out") ||
      error.includes("Giving up after") ||
      error.includes("ECONNREFUSED") ||
      error.includes("ENOTFOUND") ||
      error.includes("getaddrinfo")
    ) {
      return {
        type: "CONNECTION_ERROR",
        message: "Network connection error or timeout",
        errorType: "CONNECTION_TIMEOUT",
      };
    }

    return { type: "UNKNOWN", message: error };
  }
}
