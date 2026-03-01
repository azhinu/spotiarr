import { type ITrack } from "@spotiarr/shared";
import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { logger } from "@/infrastructure/utils/logger";
import { MusicServiceKey } from "./external.constants";
import { RateLimitService } from "./rate-limit.service";
import { SoundCloudDownloadService } from "./soundcloud-download.service";
import { YoutubeSearchService } from "./youtube-search.service";

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
  private getDownloadService(url: string): {
    service: SoundCloudDownloadService | any;
    source: string;
  } {
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
      throw new AppError(400, "no_download_url", "No sourceUrl or youtubeUrl found for track");
    }

    const { service, source } = this.getDownloadService(urlToUse);

    if (source === "SoundCloud") {
      const [isSearchBlocked, isDownloadBlocked] = await Promise.all([
        this.rateLimitService.isBlocked(MusicServiceKey.SoundCloudSearch),
        this.rateLimitService.isBlocked(MusicServiceKey.SoundCloudDownload),
      ]);

      if (isSearchBlocked || isDownloadBlocked) {
        logger.log(
          `[MultiSourceDownloadService] SoundCloud paused (search=${isSearchBlocked}, download=${isDownloadBlocked}). Attempting YouTube fallback for "${track.artist} - ${track.name}"`,
        );
        return await this.downloadFromYoutubeAsFallback(track, output);
      }
    } else {
      const isYoutubeDownloadBlocked = await this.rateLimitService.isBlocked(
        MusicServiceKey.YoutubeDownload,
      );
      if (isYoutubeDownloadBlocked) {
        const blockedUntil = await this.rateLimitService.getBlockedUntil(
          MusicServiceKey.YoutubeDownload,
        );
        const message = blockedUntil
          ? `YouTube is rate-limited until ${new Date(blockedUntil).toISOString()}`
          : "YouTube is currently rate-limited";
        logger.warn(
          `[MultiSourceDownloadService] ${message}. Cannot download: ${track.artist} - ${track.name}`,
        );
        throw new YoutubeRateLimitError(message);
      }
    }

    logger.log(
      `[MultiSourceDownloadService] 🎯 Attempting download from ${source}: "${track.artist} - ${track.name}"`,
    );

    // For YouTube, use the existing download service method
    if (source === "YouTube") {
      try {
        logger.log(`[MultiSourceDownloadService] ↓ Downloading from YouTube...`);
        return await this.youtubeDownloadService.downloadAndFormat(track, output);
      } catch (error) {
        logger.error(
          `[MultiSourceDownloadService] ✗ YouTube download failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    // For SoundCloud, try download with fallback strategy
    const trackForDownload = {
      ...track,
      sourceUrl: urlToUse,
    };

    try {
      logger.log(`[MultiSourceDownloadService] ↓ Downloading from SoundCloud...`);
      return await service.downloadAndFormat(trackForDownload, output);
    } catch (error) {
      // Re-throw YouTube rate limit errors to let worker handle them
      if (error instanceof YoutubeRateLimitError) {
        throw error;
      }

      logger.error(
        `[MultiSourceDownloadService] ✗ SoundCloud download failed. Error: ${error instanceof Error ? error.message : String(error)}`,
      );

      // SoundCloud failed - try YouTube as fallback
      logger.error(
        `[MultiSourceDownloadService] 🔄 SoundCloud failed. Attempting YouTube fallback for "${track.artist} - ${track.name}"`,
      );
      return await this.downloadFromYoutubeAsFallback(track, output);
    }
  }

  /**
   * Fallback method to download from YouTube when primary source fails
   */
  private async downloadFromYoutubeAsFallback(track: ITrack, output: string): Promise<void> {
    try {
      logger.log(
        `[MultiSourceDownloadService] 🔍 Searching for "${track.artist} - ${track.name}" on YouTube...`,
      );

      // Search for track on YouTube
      const youtubeUrl = await this.youtubeSearchService.findOnYoutubeOne(track.artist, track.name);

      logger.log(`[MultiSourceDownloadService] ✓ Found on YouTube: ${youtubeUrl}`);

      // Create track object with YouTube URL for download
      const trackWithYtUrl: ITrack = {
        ...track,
        youtubeUrl,
        sourceUrl: undefined, // Clear SoundCloud URL
      };

      logger.log(`[MultiSourceDownloadService] ↓ Downloading from YouTube...`);
      return await this.youtubeDownloadService.downloadAndFormat(trackWithYtUrl, output);
    } catch (error) {
      // Re-throw YouTube rate limit errors to let worker handle them
      if (error instanceof YoutubeRateLimitError) {
        logger.error(`[MultiSourceDownloadService] ⚠️  YouTube rate-limited during fallback`);
        throw error;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[MultiSourceDownloadService] ✗ YouTube fallback failed: ${errorMsg}`);

      // Both sources failed - throw descriptive error
      throw new AppError(
        400,
        "track_not_found_any_source",
        `Failed to download "${track.artist} - ${track.name}" from all available sources`,
      );
    }
  }
}
