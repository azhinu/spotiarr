import { SUPPORTED_AUDIO_FORMATS, SupportedAudioFormat, type ITrack } from "@spotiarr/shared";
import { YtDlp } from "ytdlp-nodejs";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { getErrorMessage } from "@/infrastructure/utils/error.utils";
import { logger } from "@/infrastructure/utils/logger";
import { classifySoundCloudDownloadError } from "./external-error-classifier.utils";
import { DEFAULT_EXTERNAL_HEADERS, MusicServiceKey } from "./external.constants";
import { RateLimitService } from "./rate-limit.service";

/**
 * SoundCloudDownloadService - Downloads audio from SoundCloud URLs using yt-dlp
 */
export class SoundCloudDownloadService {
  private readonly serviceKey = MusicServiceKey.SoundCloudDownload;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly ytDlpPath: string,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async downloadAndFormat(track: ITrack, output: string): Promise<void> {
    if (!track.sourceUrl || !track.sourceUrl.includes("soundcloud.com")) {
      throw new AppError(400, "invalid_soundcloud_url", "Invalid SoundCloud URL");
    }

    // Check if SoundCloud is currently rate-limited
    const isBlocked = await this.rateLimitService.isBlocked(this.serviceKey);
    if (isBlocked) {
      const blockedUntil = await this.rateLimitService.getBlockedUntil(this.serviceKey);
      const message = blockedUntil
        ? `SoundCloud download is rate-limited until ${new Date(blockedUntil).toISOString()}`
        : "SoundCloud download is currently rate-limited";
      logger.warn(
        `[SoundCloudDownloadService] ${message}. Cannot download: ${track.artist} - ${track.name}`,
      );
      throw new AppError(429, "soundcloud_rate_limited", message);
    }

    const ytdlp = new YtDlp({
      binaryPath: this.ytDlpPath,
    });

    const configuredFormat = await this.settingsService.getString("FORMAT");
    const formatType = (
      SUPPORTED_AUDIO_FORMATS.includes(configuredFormat as SupportedAudioFormat)
        ? configuredFormat
        : "mp3"
    ) as SupportedAudioFormat;

    try {
      await ytdlp.downloadAsync(track.sourceUrl, {
        extractAudio: true,
        audioFormat: formatType,
        audioQuality: await this.settingsService.getString("YT_AUDIO_QUALITY"),
        output,
        fixup: "force",
        headers: DEFAULT_EXTERNAL_HEADERS,
      });
      logger.info(
        `[SoundCloudDownloadService] ✓ SUCCESS: Downloaded ${track.artist} - ${track.name} from SoundCloud to ${output}`,
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error(
        `[SoundCloudDownloadService] ✗ FAILED: Download error for ${track.artist} - ${track.name}: ${errorMessage}`,
      );

      const errorClassification = classifySoundCloudDownloadError(error);

      // Check for rate-limit errors
      if (errorClassification.type === "RATE_LIMITED") {
        logger.error(`[SoundCloudDownloadService] 🔴 RATE_LIMITED (429): ${errorMessage}`);
        await this.rateLimitService.setBlocked(this.serviceKey, "RATE_LIMIT_429");
        throw new AppError(
          429,
          "soundcloud_rate_limited",
          "SoundCloud rate limited. Please try again later.",
        );
      }

      // Check for connection/auth errors
      if (errorClassification.type === "FORBIDDEN") {
        logger.error(`[SoundCloudDownloadService] 🔴 CONNECTION_ERROR/403: ${errorMessage}`);
        await this.rateLimitService.setBlocked(this.serviceKey, "FORBIDDEN_403");
        throw new AppError(
          403,
          "soundcloud_forbidden",
          "SoundCloud access denied. Service paused.",
        );
      }

      logger.error(`[SoundCloudDownloadService] 🔴 ${errorClassification.type}: ${errorMessage}`);
      throw error;
    }
  }
}
