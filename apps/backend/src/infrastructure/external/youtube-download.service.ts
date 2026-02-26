import { SUPPORTED_AUDIO_FORMATS, SupportedAudioFormat, type ITrack } from "@spotiarr/shared";
import { YtDlp } from "ytdlp-nodejs";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { YoutubeRateLimitService } from "./youtube-rate-limit.service";
import { YoutubeSearchService } from "./youtube-search.service";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export class YoutubeDownloadService {
  private readonly rateLimitService: YoutubeRateLimitService;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly searchService: YoutubeSearchService,
  ) {
    this.rateLimitService = new YoutubeRateLimitService();
  }

  async downloadAndFormat(track: ITrack, output: string): Promise<void> {
    console.debug(`Downloading ${track.artist} - ${track.name} (${track.youtubeUrl}) from YT`);
    if (!track.youtubeUrl) {
      console.error("youtubeUrl is null or undefined");
      throw new AppError(400, "internal_server_error", "youtubeUrl is null or undefined");
    }

    // Check if YouTube is currently rate-limited
    const isRateLimited = await this.rateLimitService.isRateLimited();
    if (isRateLimited) {
      const blockUntil = await this.rateLimitService.getRateLimitUntil();
      const message = blockUntil
        ? `YouTube is rate-limited until ${new Date(blockUntil).toISOString()}`
        : "YouTube is currently rate-limited";
      throw new YoutubeRateLimitError(message);
    }

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
      console.debug(`Downloaded ${track.artist} - ${track.name} to ${output}`);
    } catch (error) {
      // Check if this is a YouTube rate-limit error
      const errorMessage = this.getErrorMessage(error);
      if (this.isRateLimitError(errorMessage)) {
        console.error(
          `[YoutubeDownloadService] YouTube rate-limiting detected: ${errorMessage}`,
        );
        await this.rateLimitService.setRateLimited();
        const blockedUntil = await this.rateLimitService.getRateLimitUntil();
        const untilTime = blockedUntil ? new Date(blockedUntil).toISOString() : "unknown";
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
   * Check if error message indicates YouTube rate-limiting
   */
  private isRateLimitError(message: string): boolean {
    return message.includes("rate-limited by YouTube") ||
      message.includes("rate limit") ||
      message.includes("rate-limit");
  }
}
