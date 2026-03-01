import { TrackStatusEnum } from "@spotiarr/shared";
import type { TrackRepository } from "@/domain/repositories/track.repository";
import { logger } from "@/infrastructure/utils/logger";
import type { RetryTrackDownloadUseCase } from "./retry-track-download.use-case";

export class RescueStuckTracksUseCase {
  constructor(
    private readonly trackRepository: TrackRepository,
    private readonly retryTrackDownloadUseCase: RetryTrackDownloadUseCase,
  ) {}

  async execute(): Promise<void> {
    logger.log("🚑 Checking for stuck tracks...");

    const stuckStatuses = [
      TrackStatusEnum.Downloading,
      TrackStatusEnum.Searching,
      TrackStatusEnum.Queued,
    ];

    const stuckTracks = await this.trackRepository.findAllByStatuses(stuckStatuses);

    if (stuckTracks.length === 0) {
      logger.log("✅ No stuck tracks found.");
      return;
    }

    logger.log(`⚠️ Found ${stuckTracks.length} stuck tracks. Rescuing...`);

    let rescuedCount = 0;
    for (const track of stuckTracks) {
      if (!track.id || !track.status) continue;

      try {
        logger.log(`🔄 Rescuing track: ${track.artist} - ${track.name} [${track.status}]`);
        await this.retryTrackDownloadUseCase.execute(track.id);
        rescuedCount++;
      } catch (error) {
        logger.error(
          `❌ Failed to rescue track ${track.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    logger.log(`✅ Rescued ${rescuedCount}/${stuckTracks.length} tracks.`);
  }
}
