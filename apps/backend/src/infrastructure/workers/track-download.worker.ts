import { TrackStatusEnum, type ITrack } from "@spotiarr/shared";
import { UnrecoverableError, Worker } from "bullmq";
import { emitSseEvent } from "@/presentation/routes/events.routes";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { container } from "../../container";
import { getEnv } from "../setup/environment";

const { trackService, settingsService } = container;

const MIN_BLOCK_MS = 3 * 60 * 1000; // 3 minutes
const MAX_BLOCK_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Get random delay between 3 and 15 minutes
 */
function getRandomDelay(): number {
  return MIN_BLOCK_MS + Math.floor(Math.random() * (MAX_BLOCK_MS - MIN_BLOCK_MS));
}

export async function createTrackDownloadWorker() {
  const maxPerMinute = await settingsService.getNumber("YT_DOWNLOADS_PER_MINUTE");

  const worker = new Worker(
    "track-download-processor",
    async (job) => {
      const track: ITrack = job.data;
      console.log(
        `[TrackDownloadWorker] Starting download job ${job.id} for: ${track.artist} - ${track.name}`,
      );
      // Rate limit is handled natively by BullMQ now using the limiter option below
      try {
        await trackService.downloadFromYoutube(track);
      } catch (error) {
        console.error(
          `[TrackDownloadWorker] Download failed for ${track.artist} - ${track.name}:`,
          error instanceof Error ? error.message : String(error),
        );
        // If YouTube is rate-limited, delay this job by 3-15 minutes instead of failing
        if (error instanceof YoutubeRateLimitError) {
          const delayMs = getRandomDelay();
          const delayMinutes = Math.round(delayMs / 60000);
          console.warn(
            `[TrackDownloadWorker] YouTube rate-limited. Postponing job ${job.id} by ${delayMinutes} minutes.`,
          );
          // Throw UnrecoverableError with delay to reschedule the job
          const delayUntil = Date.now() + delayMs;
          await job.moveToDelayed(delayUntil, "*");
          throw new UnrecoverableError(
            `Rescheduled until ${new Date(delayUntil).toISOString()}`,
          );
        }
        throw error;
      }
    },
    {
      connection: {
        host: getEnv().REDIS_HOST,
        port: getEnv().REDIS_PORT,
      },
      limiter: {
        max: maxPerMinute || 10, // Fallback to 10 if setting is missing/0
        duration: 60000, // 1 minute
      },
    },
  );

  worker.on("completed", (job) => {
    console.log(`[TrackDownloadWorker] Job ${job.id} completed`);
  });

  worker.on("drained", async () => {
    console.log(`[TrackDownloadWorker] Queue drained, triggering library scan...`);
    try {
      await container.libraryService.scan();
      container.eventsController.emit("library-updated");
      console.log(`[TrackDownloadWorker] Library scan completed successfully.`);
    } catch (err) {
      console.error(`[TrackDownloadWorker] Failed to scan library after queue drain:`, err);
    }
  });

  worker.on("failed", async (job, err) => {
    console.error(`[TrackDownloadWorker] Job ${job?.id} failed:`, err);

    if (job?.data?.id) {
      const track: ITrack = job.data;
      const trackId = track.id;

      if (!trackId) {
        console.error("Cannot update track status: track.id is undefined");
        return;
      }

      // Don't mark as error if job was just rescheduled due to rate limit
      if (err instanceof UnrecoverableError && err.message.includes("Rescheduled")) {
        console.log(`[TrackDownloadWorker] Job ${job.id} rescheduled for later`);
        return;
      }

      try {
        await trackService.update(trackId, {
          ...track,
          status: TrackStatusEnum.Error,
          error: err instanceof Error ? err.message : String(err),
        });
        container.eventsController.emit("playlists-updated");
      } catch (updateError) {
        console.error(`Failed to update track ${trackId} status after job failure:`, updateError);
      }
    }
  });

  console.log(`✅ Track download worker initialized (Rate limit: ${maxPerMinute}/min)`);
  return worker;
}
