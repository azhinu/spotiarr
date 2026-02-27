import { SettingsService } from "@/application/services/settings.service";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { RateLimitService } from "./rate-limit.service";
import { SoundCloudSearchService } from "./soundcloud-search.service";
import { YoutubeSearchService } from "./youtube-search.service";

export type MusicSource = "soundcloud" | "youtube";

export interface SearchResult {
  url: string;
  source: MusicSource;
}

/**
 * Multi-source music search service with priority-based fallback
 * Priority: SoundCloud → YouTube
 */
export class MultiSourceSearchService {
  private readonly soundcloudSearchService: SoundCloudSearchService;
  private readonly youtubeSearchService: YoutubeSearchService;

  constructor(
    private readonly settingsService: SettingsService,
    youtubeSearchService: YoutubeSearchService,
    ytDlpPath: string,
    private readonly rateLimitService: RateLimitService,
  ) {
    this.youtubeSearchService = youtubeSearchService;
    this.soundcloudSearchService = new SoundCloudSearchService(
      settingsService,
      ytDlpPath,
      rateLimitService,
    );
  }

  /**
   * Find a track across multiple sources with priority-based fallback
   * Tries: SoundCloud → YouTube
   *
   * @param artist The artist name
   * @param name The track name
   * @returns SearchResult with URL and source
   * @throws YoutubeRateLimitError if YouTube is rate-limited
   * @throws AppError if track not found on any source
   */
  async findTrack(artist: string, name: string): Promise<SearchResult> {
    const sources: Array<{
      name: MusicSource;
      search: () => Promise<string>;
    }> = [
      {
        name: "soundcloud",
        search: () => this.soundcloudSearchService.findTrackUrl(artist, name),
      },
      {
        name: "youtube",
        search: () => this.youtubeSearchService.findOnYoutubeOne(artist, name),
      },
    ];

    const errors: Array<{ source: MusicSource; error: unknown }> = [];

    for (const source of sources) {
      try {
        console.debug(
          `[MultiSourceSearchService] Trying source: ${source.name} for "${artist} - ${name}"`,
        );
        const url = await source.search();
        console.info(
          `[MultiSourceSearchService] ✓ SUCCESS: Found on ${source.name} - ${url}`,
        );
        return { url, source: source.name };
      } catch (error) {
        // Re-throw YouTube rate limit errors immediately
        if (error instanceof YoutubeRateLimitError) {
          console.error(
            `[MultiSourceSearchService] 🔴 RATE_LIMITED (YouTube): Deferring search for "${artist} - ${name}"`,
          );
          throw error;
        }

        // Log the error and continue to next source
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ source: source.name, error });
        
        // Try to extract more info about the error
        let errorInfo = errorMsg;
        if (error instanceof AppError) {
          errorInfo = `[${error.statusCode}] ${error.errorCode}: ${errorMsg}`;
        }
        
        console.debug(
          `[MultiSourceSearchService] ✗ FAILED (${source.name}): ${errorInfo}`,
        );
      }
    }

    // If we get here, no source found the track
    console.error(
      `[MultiSourceSearchService] Track not found on any source: ${artist} - ${name}`,
    );
    console.error("Errors from each source:", errors);
    throw new AppError(
      404,
      "track_not_found_any_source",
      `Track "${artist} - ${name}" not found on any music source (SoundCloud, YouTube)`,
    );
  }

  /**
   * Find a track, prefer a specific source
   * Falls back to other sources if the preferred one fails
   */
  async findTrackPreferring(
    artist: string,
    name: string,
    preferredSource?: MusicSource,
  ): Promise<SearchResult> {
    if (!preferredSource) {
      return this.findTrack(artist, name);
    }

    // Try preferred source first, then fallback to others
    const sources: Array<{
      name: MusicSource;
      search: () => Promise<string>;
    }> = [
      {
        name: "soundcloud",
        search: () => this.soundcloudSearchService.findTrackUrl(artist, name),
      },
      {
        name: "youtube",
        search: () => this.youtubeSearchService.findOnYoutubeOne(artist, name),
      },
    ];

    // Reorder so preferred source is first
    const reorderedSources = [
      sources.find((s) => s.name === preferredSource),
      ...sources.filter((s) => s.name !== preferredSource),
    ].filter(Boolean) as typeof sources;

    const errors: Array<{ source: MusicSource; error: unknown }> = [];

    for (const source of reorderedSources) {
      try {
        console.debug(`[MultiSourceSearchService] Trying ${source.name} for ${artist} - ${name}`);
        const url = await source.search();
        console.info(
          `[MultiSourceSearchService] Found ${artist} - ${name} on ${source.name}`,
        );
        return { url, source: source.name };
      } catch (error) {
        // Re-throw YouTube rate limit errors immediately
        if (error instanceof YoutubeRateLimitError) {
          console.error(
            `[MultiSourceSearchService] YouTube rate-limited while searching for ${artist} - ${name}`,
          );
          throw error;
        }

        // Log the error and continue to next source
        errors.push({ source: source.name, error });
        console.debug(
          `[MultiSourceSearchService] ${source.name} failed for ${artist} - ${name}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // If we get here, no source found the track
    throw new AppError(
      404,
      "track_not_found_any_source",
      `Track "${artist} - ${name}" not found on any music source (SoundCloud, YouTube)`,
    );
  }
}
