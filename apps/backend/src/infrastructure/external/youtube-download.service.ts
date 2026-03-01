import { SUPPORTED_AUDIO_FORMATS, SupportedAudioFormat, type ITrack } from "@spotiarr/shared";
import { YtDlp } from "ytdlp-nodejs";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { getErrorMessage } from "@/infrastructure/utils/error.utils";
import { logger } from "@/infrastructure/utils/logger";
import { classifyYoutubeDownloadError } from "./external-error-classifier.utils";
import { DEFAULT_EXTERNAL_HEADERS, MusicServiceKey } from "./external.constants";
import { RateLimitService } from "./rate-limit.service";
import { YoutubeSearchService } from "./youtube-search.service";

export class YoutubeDownloadService {
  private readonly serviceKey = MusicServiceKey.YoutubeDownload;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly searchService: YoutubeSearchService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async downloadAndFormat(track: ITrack, output: string): Promise<void> {
    logger.debug(`Downloading ${track.artist} - ${track.name} (${track.youtubeUrl}) from YT`);
    if (!track.youtubeUrl) {
      logger.log("youtubeUrl is null or undefined");
      throw new AppError(400, "internal_server_error", "youtubeUrl is null or undefined");
    }

    // Check if YouTube is currently rate-limited
    const isBlocked = await this.rateLimitService.isBlocked(this.serviceKey);
    if (isBlocked) {
      const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
      const message = blockedUntil
        ? `YouTube download is rate-limited until ${new Date(blockedUntil).toISOString()}`
        : "YouTube download is currently rate-limited";
      logger.warn(
        `[YoutubeDownloadService] ${message}. Cannot download: ${track.artist} - ${track.name}`,
      );
      throw new YoutubeRateLimitError(message);
    }

    logger.info(
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
      logger.debug(
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
        headers: DEFAULT_EXTERNAL_HEADERS,
      });
      logger.info(
        `[YoutubeDownloadService] ✓ SUCCESS: Downloaded ${track.artist} - ${track.name} from YouTube to ${output}`,
      );
    } catch (error) {
      // Check if this is a YouTube rate-limit error
      const errorMessage = getErrorMessage(error);
      logger.error(
        `[YoutubeDownloadService] ✗ FAILED: Download error for ${track.artist} - ${track.name}: ${errorMessage}`,
      );
      const errorClassification = classifyYoutubeDownloadError(errorMessage);

      if (errorClassification.type === "RATE_LIMITED") {
        logger.error(`[YoutubeDownloadService] 🔴 RATE_LIMITED (429): ${errorMessage}`);
        await this.rateLimitService.setBlocked(this.serviceKey, "RATE_LIMIT_429");
        const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
        const untilTime = blockedUntil ? new Date(blockedUntil).toISOString() : "unknown";
        logger.warn(`[YoutubeDownloadService] Service paused until ${untilTime}`);
        throw new YoutubeRateLimitError(`YouTube rate-limited - paused until ${untilTime}`);
      }
      throw error;
    }
  }
}
