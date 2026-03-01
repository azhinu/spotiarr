import { PrismaHistoryRepository } from "@/infrastructure/database/prisma-history.repository";
import { PrismaPlaylistRepository } from "@/infrastructure/database/prisma-playlist.repository";
import { PrismaSettingsRepository } from "@/infrastructure/database/prisma-settings.repository";
import { PrismaTrackRepository } from "@/infrastructure/database/prisma-track.repository";

// Repositories - No dependencies, initialize first
export const playlistRepository = new PrismaPlaylistRepository();
export const trackRepository = new PrismaTrackRepository();
export const historyRepository = new PrismaHistoryRepository();
export const settingsRepository = new PrismaSettingsRepository();
