import { AppError } from "@/domain/errors/app-error";
import type { EventBus } from "@/domain/events/event-bus";
import type { TrackRepository } from "@/domain/repositories/track.repository";
import type { TrackQueueService } from "@/domain/services/track-queue.service";
import type { MusicSource } from "@/infrastructure/external/multi-source-search.service";

export class RetryTrackDownloadUseCase {
  constructor(
    private readonly trackRepository: TrackRepository,
    private readonly queueService: TrackQueueService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(id: string, options?: { preferredSource?: MusicSource }): Promise<void> {
    const track = await this.trackRepository.findOneWithPlaylist(id);
    if (!track) {
      throw new AppError(404, "track_not_found");
    }

    track.markAsNew();
    await this.trackRepository.update(id, track);
    this.eventBus.emit("playlists-updated");

    const trackForSearch = track.toPrimitive();
    if (options?.preferredSource) {
      trackForSearch.source = options.preferredSource;
    }

    await this.queueService.enqueueSearchTrack(trackForSearch);
  }
}
