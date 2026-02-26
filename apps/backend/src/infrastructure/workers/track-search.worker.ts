import { type ITrack } from "@spotiarr/shared";
import { UnrecoverableError, Worker } from "bullmq";
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

export async function createTrackSearchWorker() {
  const concurrency = await settingsService.getNumber("YT_SEARCH_CONCURRENCY");

  const worker = new Worker(
    "track-search-processor",
    async (job) => {
      const track: ITrack = job.data;
      try {
        // Use multi-source search instead of YouTube-only search
        await trackService.findTrack(track);
      } catch (error) {
        // If YouTube is rate-limited, delay this job by 3-15 minutes instead of failing
        if (error instanceof YoutubeRateLimitError) {
          const delayMs = getRandomDelay();
          const delayMinutes = Math.round(delayMs / 60000);
          console.warn(
            `[TrackSearchWorker] YouTube rate-limited. Postponing job ${job.id} by ${delayMinutes} minutes.`,
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
      concurrency: concurrency || 3, // Default to 3 if setting missing
      connection: {
        host: getEnv().REDIS_HOST,
        port: getEnv().REDIS_PORT,
      },
    },
  );

  worker.on("completed", (job) => {
    console.log(`[TrackSearchWorker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[TrackSearchWorker] Job ${job?.id} failed:`, err);

    // Don't log as error if job was just rescheduled due to rate limit
    if (err instanceof UnrecoverableError && err.message.includes("Rescheduled")) {
      console.log(`[TrackSearchWorker] Job ${job?.id} rescheduled for later`);
    }
  });

  console.log(`✅ Track search worker initialized (Concurrency: ${concurrency || 3})`);
  return worker;
}
