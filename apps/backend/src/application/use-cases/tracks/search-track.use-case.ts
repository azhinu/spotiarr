import { TrackStatusEnum, type ITrack } from "@spotiarr/shared";
import { EventBus } from "@/domain/events/event-bus";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { TrackRepository } from "@/domain/repositories/track.repository";
import type { TrackQueueService } from "@/domain/services/track-queue.service";
import { MultiSourceSearchService } from "@/infrastructure/external/multi-source-search.service";
import { SettingsService } from "../../services/settings.service";

/**
 * Multi-source track search use case
 * Searches for tracks across SoundCloud and YouTube with priority fallback
 */
export class SearchTrackUseCase {
  constructor(
    private readonly trackRepository: TrackRepository,
    private readonly multiSourceSearchService: MultiSourceSearchService,
    private readonly settingsService: SettingsService,
    private readonly queueService: TrackQueueService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(track: ITrack): Promise<void> {
    if (!track.id) {
      return;
    }

    const existingTrack = await this.trackRepository.findOneWithPlaylist(track.id);
    if (!existingTrack) {
      return;
    }

    existingTrack.markAsSearching();
    await this.trackRepository.update(track.id, existingTrack);
    this.eventBus.emit("playlists-updated");

    try {
      const searchResult = await this.multiSourceSearchService.findTrack(
        existingTrack.artist,
        existingTrack.name,
      );

      // Mark as queued with source information
      existingTrack.markAsQueuedWithSource(searchResult.url, searchResult.source);
    } catch (error) {
      // Re-throw YouTube rate limit errors to be handled by worker
      if (error instanceof YoutubeRateLimitError) {
        throw error;
      }

      console.error(
        `Failed to find track on any source: ${existingTrack.artist} - ${existingTrack.name}`,
        error instanceof Error ? error.stack : String(error),
      );
      existingTrack.markAsError(error instanceof Error ? error.message : String(error));
    }

    await this.trackRepository.update(track.id, existingTrack);
    this.eventBus.emit("playlists-updated");

    if (existingTrack.sourceUrl && existingTrack.status === TrackStatusEnum.Queued) {
      const maxRetries = await this.settingsService.getNumber("DOWNLOAD_MAX_RETRIES");
      const safeMaxRetries = maxRetries >= 1 && maxRetries <= 10 ? maxRetries : 3;
      await this.queueService.enqueueDownloadTrack(existingTrack.toPrimitive(), {
        maxRetries: safeMaxRetries,
      });
    }
  }
}
