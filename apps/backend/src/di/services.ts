import { LibraryService } from "@/application/services/library.service";
import { PlaylistService } from "@/application/services/playlist.service";
import { SettingsService } from "@/application/services/settings.service";
import { TrackPostProcessingService } from "@/application/services/track-post-processing.service";
import { TrackService } from "@/application/services/track.service";
import type { ScanLibraryUseCase } from "@/application/use-cases/library/scan-library.use-case";
import type { CreatePlaylistUseCase } from "@/application/use-cases/playlists/create-playlist.use-case";
import type { DeletePlaylistUseCase } from "@/application/use-cases/playlists/delete-playlist.use-case";
import type { GetMyPlaylistsUseCase } from "@/application/use-cases/playlists/get-my-playlists.use-case";
import type { GetPlaylistPreviewUseCase } from "@/application/use-cases/playlists/get-playlist-preview.use-case";
import type { GetPlaylistsUseCase } from "@/application/use-cases/playlists/get-playlists.use-case";
import type { GetSystemStatusUseCase } from "@/application/use-cases/playlists/get-system-status.use-case";
import type { RetryPlaylistDownloadsUseCase } from "@/application/use-cases/playlists/retry-playlist-downloads.use-case";
import type { SyncSubscribedPlaylistsUseCase } from "@/application/use-cases/playlists/sync-subscribed-playlists.use-case";
import type { UpdatePlaylistUseCase } from "@/application/use-cases/playlists/update-playlist.use-case";
import type { CreateTrackUseCase } from "@/application/use-cases/tracks/create-track.use-case";
import type { DeleteTrackUseCase } from "@/application/use-cases/tracks/delete-track.use-case";
import type { DownloadTrackUseCase } from "@/application/use-cases/tracks/download-track.use-case";
import type { GetTracksUseCase } from "@/application/use-cases/tracks/get-tracks.use-case";
import type { RetryTrackDownloadUseCase } from "@/application/use-cases/tracks/retry-track-download.use-case";
import type { SearchTrackOnYoutubeUseCase } from "@/application/use-cases/tracks/search-track-on-youtube.use-case";
import type { SearchTrackUseCase } from "@/application/use-cases/tracks/search-track.use-case";
import type { UpdateTrackUseCase } from "@/application/use-cases/tracks/update-track.use-case";
import { SpotifyService } from "@/domain/services/spotify.service";
import { AppEventBus } from "@/infrastructure/messaging/app-event-bus";
import { BullMqTrackQueueService } from "@/infrastructure/messaging/bullmq-track-queue.service";
import { FileSystemM3uService } from "@/infrastructure/services/file-system-m3u.service";
import { FileSystemScannerService } from "@/infrastructure/services/file-system-scanner.service";
import { FileSystemTrackPathService } from "@/infrastructure/services/file-system-track-path.service";
import { MetadataService } from "@/infrastructure/services/metadata.service";
import {
  playlistRepository,
  trackRepository,
  historyRepository,
  settingsRepository,
} from "./repositories";

export const settingsService = new SettingsService(settingsRepository);
export const trackFileHelper = new FileSystemTrackPathService(settingsService);
export const m3uService = new FileSystemM3uService(settingsService, trackFileHelper);
export const metadataService = new MetadataService();
export const queueService = new BullMqTrackQueueService();
export const eventBus = new AppEventBus();
export const fileSystemScannerService = new FileSystemScannerService();

let trackPostProcessingService: TrackPostProcessingService;
let trackService: TrackService;

export interface ApplicationServicesDependencies {
  // Track Use Cases
  createTrackUseCase: CreateTrackUseCase;
  deleteTrackUseCase: DeleteTrackUseCase;
  getTracksUseCase: GetTracksUseCase;
  updateTrackUseCase: UpdateTrackUseCase;
  searchTrackOnYoutubeUseCase: SearchTrackOnYoutubeUseCase;
  searchTrackUseCase: SearchTrackUseCase;
  retryTrackDownloadUseCase: RetryTrackDownloadUseCase;
  downloadTrackUseCase: DownloadTrackUseCase;

  // Playlist Use Cases
  createPlaylistUseCase: CreatePlaylistUseCase;
  getSystemStatusUseCase: GetSystemStatusUseCase;
  getPlaylistPreviewUseCase: GetPlaylistPreviewUseCase;
  syncSubscribedPlaylistsUseCase: SyncSubscribedPlaylistsUseCase;
  getPlaylistsUseCase: GetPlaylistsUseCase;
  deletePlaylistUseCase: DeletePlaylistUseCase;
  updatePlaylistUseCase: UpdatePlaylistUseCase;
  retryPlaylistDownloadsUseCase: RetryPlaylistDownloadsUseCase;
  getMyPlaylistsUseCase: GetMyPlaylistsUseCase;

  // Library Use Cases
  scanLibraryUseCase: ScanLibraryUseCase;
}

export const setupApplicationServices = (
  spotifyService: SpotifyService,
  useCases: ApplicationServicesDependencies,
) => {
  // Services (Post-Processing)
  trackPostProcessingService = new TrackPostProcessingService(
    spotifyService,
    metadataService,
    playlistRepository,
    trackRepository,
    trackFileHelper,
    m3uService,
  );

  // Domain Services (Track)
  trackService = new TrackService({
    createTrackUseCase: useCases.createTrackUseCase,
    deleteTrackUseCase: useCases.deleteTrackUseCase,
    getTracksUseCase: useCases.getTracksUseCase,
    updateTrackUseCase: useCases.updateTrackUseCase,
    searchTrackOnYoutubeUseCase: useCases.searchTrackOnYoutubeUseCase,
    searchTrackUseCase: useCases.searchTrackUseCase,
    retryTrackDownloadUseCase: useCases.retryTrackDownloadUseCase,
    downloadTrackUseCase: useCases.downloadTrackUseCase,
  });

  // Domain Services (Playlist)
  const playlistService = new PlaylistService({
    createPlaylistUseCase: useCases.createPlaylistUseCase,
    getSystemStatusUseCase: useCases.getSystemStatusUseCase,
    getPlaylistPreviewUseCase: useCases.getPlaylistPreviewUseCase,
    syncSubscribedPlaylistsUseCase: useCases.syncSubscribedPlaylistsUseCase,
    getPlaylistsUseCase: useCases.getPlaylistsUseCase,
    deletePlaylistUseCase: useCases.deletePlaylistUseCase,
    updatePlaylistUseCase: useCases.updatePlaylistUseCase,
    retryPlaylistDownloadsUseCase: useCases.retryPlaylistDownloadsUseCase,
    getMyPlaylistsUseCase: useCases.getMyPlaylistsUseCase,
  });

  // Library Services
  const libraryService = new LibraryService(useCases.scanLibraryUseCase);

  return {
    trackPostProcessingService,
    trackService,
    playlistService,
    libraryService,
  };
};

export const getTrackPostProcessingService = () => trackPostProcessingService;

export const getTrackService = () => trackService;
