import { TrackStatusEnum } from "@spotiarr/shared";
import type { JobType } from "bullmq";
import cron from "node-cron";
import type { MusicSource } from "@/infrastructure/external/multi-source-search.service";
import { logger } from "@/infrastructure/utils/logger";
import { container } from "../../container";
import { getTrackDownloadQueue, getTrackSearchQueue } from "../setup/queues";

const { playlistService, settingsService, trackService, eventBus } = container;

let lastPlaylistCheckTimestamp = 0;
let lastStuckTracksCleanupTimestamp = 0;

async function removeQueuedJobsForTrack(trackId: string): Promise<number> {
  const queues = [
    { name: "download", queue: getTrackDownloadQueue() },
    { name: "search", queue: getTrackSearchQueue() },
  ];
  const states: JobType[] = ["active", "waiting", "delayed", "prioritized"];

  let removedCount = 0;

  for (const { name, queue } of queues) {
    const jobs = await queue.getJobs(states, 0, -1, true);

    for (const job of jobs) {
      if (job.data?.id !== trackId || !job.id) {
        continue;
      }

      try {
        await queue.remove(job.id);
        removedCount += 1;
      } catch (error) {
        const state = await job.getState().catch(() => "unknown");
        logger.warn(
          `[ScheduledJob] Unable to remove ${name} job ${job.id} for track ${trackId} (state=${state}):`,
          error,
        );
      }
    }
  }

  return removedCount;
}

function getFallbackSource(track: {
  source?: "soundcloud" | "youtube";
  sourceUrl?: string;
  youtubeUrl?: string;
}): MusicSource {
  if (track.source === "soundcloud") {
    return "youtube";
  }

  if (track.source === "youtube") {
    return "soundcloud";
  }

  const url = track.sourceUrl || track.youtubeUrl || "";
  if (url.includes("soundcloud.com")) {
    return "youtube";
  }

  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    return "soundcloud";
  }

  return "youtube";
}

export const checkPlaylistsJob = cron.schedule("* * * * *", async () => {
  try {
    const intervalMinutes = await settingsService.getNumber("PLAYLIST_CHECK_INTERVAL_MINUTES");
    const safeIntervalMinutes = intervalMinutes > 0 ? intervalMinutes : 60;
    const now = Date.now();

    if (now - lastPlaylistCheckTimestamp < safeIntervalMinutes * 60_000) {
      return;
    }

    logger.log("[ScheduledJob] Running playlist check...");
    await playlistService.checkSubscribedPlaylists();
    lastPlaylistCheckTimestamp = now;
    logger.log("[ScheduledJob] Playlist check completed");
  } catch (error) {
    logger.error("[ScheduledJob] Error checking playlists:", error);
  }
});

export const cleanStuckTracksJob = cron.schedule("* * * * *", async () => {
  try {
    const cleanupIntervalMinutes = await settingsService.getNumber(
      "STUCK_TRACKS_CLEANUP_INTERVAL_MINUTES",
    );
    const timeoutMinutes = await settingsService.getNumber("STUCK_TRACKS_TIMEOUT_MINUTES");

    const safeCleanupInterval = cleanupIntervalMinutes > 0 ? cleanupIntervalMinutes : 5;
    const safeTimeout = timeoutMinutes > 0 ? timeoutMinutes : 10;
    const now = Date.now();

    if (now - lastStuckTracksCleanupTimestamp < safeCleanupInterval * 60_000) {
      return;
    }

    const stuckTracks = await trackService.findStuckTracks(
      [TrackStatusEnum.Queued, TrackStatusEnum.Downloading, TrackStatusEnum.Searching],
      now - safeTimeout * 60 * 1000,
    );

    if (stuckTracks.length > 0) {
      logger.log(
        `[ScheduledJob] Found ${stuckTracks.length} stuck tracks, terminating queue jobs and moving to fallback`,
      );

      for (const track of stuckTracks) {
        if (track.id) {
          try {
            const removedJobs = await removeQueuedJobsForTrack(track.id);
            if (removedJobs > 0) {
              logger.warn(
                `[ScheduledJob] Removed ${removedJobs} queue jobs for stuck track ${track.id}`,
              );
            }

            const fallbackSource = getFallbackSource(track);
            await trackService.retry(track.id, { preferredSource: fallbackSource });
            logger.log(
              `[ScheduledJob] Track ${track.id} redirected to fallback search pipeline (preferred=${fallbackSource})`,
            );
          } catch (error) {
            logger.error(
              `[ScheduledJob] Failed to recover stuck track ${track.id}, marking as error:`,
              error,
            );
            await trackService.update(track.id, {
              ...track,
              status: TrackStatusEnum.Error,
              error:
                track.error ||
                `Track was stuck in processing state for more than ${safeTimeout} minutes`,
            });
          }
        }
      }

      eventBus.emit("playlists-updated");
    }

    lastStuckTracksCleanupTimestamp = now;
  } catch (error) {
    logger.error("[ScheduledJob] Error cleaning stuck tracks:", error);
  }
});

export function startScheduledJobs(): void {
  checkPlaylistsJob.start();
  cleanStuckTracksJob.start();
  logger.log("✅ Scheduled jobs started (intervals configurable in Settings)");
}
