import { Queue } from "bullmq";
import { AppError } from "@/domain/errors/app-error";
import { logger } from "@/infrastructure/utils/logger";
import { getEnv } from "../setup/environment";

let trackDownloadQueue: Queue;
let trackSearchQueue: Queue;

export function initializeQueues(): void {
  const env = getEnv();
  const connection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  };

  trackDownloadQueue = new Queue("track-download-processor", {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });

  trackSearchQueue = new Queue("track-search-processor", {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });

  logger.log("✅ BullMQ queues initialized");
}

export function getTrackDownloadQueue(): Queue {
  if (!trackDownloadQueue) {
    throw new AppError(500, "internal_server_error", "Track download queue not initialized");
  }
  return trackDownloadQueue;
}

export function getTrackSearchQueue(): Queue {
  if (!trackSearchQueue) {
    throw new AppError(500, "internal_server_error", "Track search queue not initialized");
  }
  return trackSearchQueue;
}
