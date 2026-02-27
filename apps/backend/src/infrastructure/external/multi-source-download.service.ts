import { SUPPORTED_AUDIO_FORMATS, SupportedAudioFormat, type ITrack } from "@spotiarr/shared";
import { YtDlp } from "ytdlp-nodejs";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { RateLimitService } from "./rate-limit.service";
import { YoutubeSearchService } from "./youtube-search.service";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/**
 * SoundCloudDownloadService - Downloads audio from SoundCloud URLs using yt-dlp
 */
export class SoundCloudDownloadService {
  private readonly serviceKey = "soundcloud:download" as const;

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
      console.warn(
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

    const audioQuality = await this.settingsService.getString("YT_AUDIO_QUALITY");
    const qualityMap: Record<string, 0 | 5 | 9> = {
      best: 0,
      good: 5,
      acceptable: 9,
    };
    const quality = (qualityMap[audioQuality] ?? 0) as 0 | 5 | 9;

    try {
      await ytdlp.downloadAsync(track.sourceUrl, {
        format: {
          filter: "audioonly",
          type: formatType,
          quality,
        },
        output,
        headers: HEADERS,
      });
      console.info(
        `[SoundCloudDownloadService] ✓ SUCCESS: Downloaded ${track.artist} - ${track.name} from SoundCloud to ${output}`,
      );
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      console.error(
        `[SoundCloudDownloadService] ✗ FAILED: Download error for ${track.artist} - ${track.name}: ${errorMessage}`,
      );

      // Check for rate-limit errors
      if (errorMessage.includes("429") || errorMessage.includes("rate-limit")) {
        console.error(`[SoundCloudDownloadService] 🔴 RATE_LIMITED (429): ${errorMessage}`);
        await this.rateLimitService.setBlocked(this.serviceKey, "RATE_LIMIT_429");
        throw new AppError(
          429,
          "soundcloud_rate_limited",
          "SoundCloud rate limited. Please try again later.",
        );
      }

      // Check for connection/auth errors
      if (
        errorMessage.includes("403") ||
        errorMessage.includes("Connection") ||
        errorMessage.includes("timeout")
      ) {
        console.error(`[SoundCloudDownloadService] 🔴 CONNECTION_ERROR/403: ${errorMessage}`);
        await this.rateLimitService.setBlocked(this.serviceKey, "FORBIDDEN_403");
        throw new AppError(
          403,
          "soundcloud_forbidden",
          "SoundCloud access denied. Service paused.",
        );
      }

      console.error(`[SoundCloudDownloadService] 🔴 UNKNOWN_ERROR: ${errorMessage}`);
      throw error;
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

/**
 * MultiSourceDownloadService - Downloads audio from any supported source
 * Intelligently routes to the appropriate download service based on URL
 */
export class MultiSourceDownloadService {
  private readonly soundcloudDownloadService: SoundCloudDownloadService;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly youtubeSearchService: YoutubeSearchService,
    private readonly youtubeDownloadService: any, // Use existing YoutubeDownloadService
    private readonly rateLimitService: RateLimitService,
  ) {
    const ytDlpPath = youtubeSearchService.getYtDlpPath();
    this.soundcloudDownloadService = new SoundCloudDownloadService(
      settingsService,
      ytDlpPath,
      rateLimitService,
    );
  }

  /**
   * Determine which service to use based on URL
   */
  private getDownloadService(
    url: string,
  ): { service: SoundCloudDownloadService | any; source: string } {
    if (url.includes("soundcloud.com")) {
      return { service: this.soundcloudDownloadService, source: "SoundCloud" };
    } else {
      return { service: this.youtubeDownloadService, source: "YouTube" };
    }
  }

  async downloadAndFormat(track: ITrack, output: string): Promise<void> {
    // Determine which URL to use - try sourceUrl first, then fall back to youtubeUrl
    const urlToUse = track.sourceUrl || track.youtubeUrl;

    if (!urlToUse) {
      throw new AppError(
        400,
        "no_download_url",
        "No sourceUrl or youtubeUrl found for track",
      );
    }

    const { service, source } = this.getDownloadService(urlToUse);

    // Check rate limit status before attempting download
    const scKey = source === "SoundCloud" ? ("soundcloud:download" as const) : ("youtube:download" as const);
    const isBlocked = await this.rateLimitService.isBlocked(scKey);
    if (isBlocked) {
      const blockedUntil = await this.rateLimitService.getBlockedUntil(scKey);
      const message = blockedUntil
        ? `${source} is rate-limited until ${new Date(blockedUntil).toISOString()}`
        : `${source} is currently rate-limited`;
      console.warn(
        `[MultiSourceDownloadService] ${message}. Cannot download: ${track.artist} - ${track.name}`,
      );
      throw new AppError(
        429,
        source === "SoundCloud" ? "soundcloud_rate_limited" : "internal_server_error",
        message,
      );
    }

    console.info(
      `[MultiSourceDownloadService] Downloading ${track.artist} - ${track.name} from ${source} (URL: ${urlToUse})`,
    );

    // For YouTube, use the existing download service method
    if (source === "YouTube") {
      try {
        return await this.youtubeDownloadService.downloadAndFormat(track, output);
      } catch (error) {
        console.error(
          `[MultiSourceDownloadService] YouTube download failed for ${track.artist} - ${track.name}:`,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }

    // For other sources, we need to set sourceUrl if it's not already
    const trackForDownload = {
      ...track,
      sourceUrl: urlToUse,
    };

    try {
      return await service.downloadAndFormat(trackForDownload, output);
    } catch (error) {
      console.error(
        `[MultiSourceDownloadService] ${source} download failed for ${track.artist} - ${track.name}:`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
