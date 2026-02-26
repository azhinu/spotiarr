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

/**
 * SoundCloudDownloadService - Downloads audio from SoundCloud URLs using yt-dlp
 */
export class SoundCloudDownloadService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly ytDlpPath: string,
  ) {}

  async downloadAndFormat(track: ITrack, output: string): Promise<void> {
    if (!track.sourceUrl || !track.sourceUrl.includes("soundcloud.com")) {
      throw new AppError(400, "invalid_soundcloud_url", "Invalid SoundCloud URL");
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
      console.debug(
        `Downloaded ${track.artist} - ${track.name} from SoundCloud to ${output}`,
      );
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      console.error(`[SoundCloudDownloadService] Failed to download: ${errorMessage}`);
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
  private readonly rateLimitService: YoutubeRateLimitService;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly youtubeSearchService: YoutubeSearchService,
    private readonly youtubeDownloadService: any, // Use existing YoutubeDownloadService
  ) {
    const ytDlpPath = youtubeSearchService.getYtDlpPath();
    this.soundcloudDownloadService = new SoundCloudDownloadService(settingsService, ytDlpPath);
    this.rateLimitService = new YoutubeRateLimitService();
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

    console.debug(`Downloading ${track.artist} - ${track.name} from ${source}`);

    // For YouTube, use the existing download service method
    if (source === "YouTube") {
      return this.youtubeDownloadService.downloadAndFormat(track, output);
    }

    // For other sources, we need to set sourceUrl if it's not already
    const trackForDownload = {
      ...track,
      sourceUrl: urlToUse,
    };

    return service.downloadAndFormat(trackForDownload, output);
  }
}
