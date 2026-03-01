import { HistoryUseCases } from "@/application/use-cases/history/history.use-cases";
import { ScanLibraryUseCase } from "@/application/use-cases/library/scan-library.use-case";
import { CreatePlaylistUseCase } from "@/application/use-cases/playlists/create-playlist.use-case";
import { DeletePlaylistUseCase } from "@/application/use-cases/playlists/delete-playlist.use-case";
import { GetMyPlaylistsUseCase } from "@/application/use-cases/playlists/get-my-playlists.use-case";
import { GetPlaylistPreviewUseCase } from "@/application/use-cases/playlists/get-playlist-preview.use-case";
import { GetPlaylistsUseCase } from "@/application/use-cases/playlists/get-playlists.use-case";
import { GetSystemStatusUseCase } from "@/application/use-cases/playlists/get-system-status.use-case";
import { RetryPlaylistDownloadsUseCase } from "@/application/use-cases/playlists/retry-playlist-downloads.use-case";
import { SyncSubscribedPlaylistsUseCase } from "@/application/use-cases/playlists/sync-subscribed-playlists.use-case";
import { UpdatePlaylistUseCase } from "@/application/use-cases/playlists/update-playlist.use-case";
import { GetSettingsUseCase } from "@/application/use-cases/settings/get-settings.use-case";
import { UpdateSettingUseCase } from "@/application/use-cases/settings/update-setting.use-case";
import { CreateTrackUseCase } from "@/application/use-cases/tracks/create-track.use-case";
import { DeleteTrackUseCase } from "@/application/use-cases/tracks/delete-track.use-case";
import { DownloadTrackUseCase } from "@/application/use-cases/tracks/download-track.use-case";
import { GetTracksUseCase } from "@/application/use-cases/tracks/get-tracks.use-case";
import { RescueStuckTracksUseCase } from "@/application/use-cases/tracks/rescue-stuck-tracks.use-case";
import { RetryTrackDownloadUseCase } from "@/application/use-cases/tracks/retry-track-download.use-case";
import { SearchTrackOnYoutubeUseCase } from "@/application/use-cases/tracks/search-track-on-youtube.use-case";
import { SearchTrackUseCase } from "@/application/use-cases/tracks/search-track.use-case";
import { UpdateTrackUseCase } from "@/application/use-cases/tracks/update-track.use-case";
import {
  playlistRepository,
  trackRepository,
  historyRepository,
  settingsRepository,
} from "./repositories";
import {
  settingsService,
  queueService,
  eventBus,
  trackFileHelper,
  fileSystemScannerService,
  getTrackPostProcessingService,
  getTrackService,
} from "./services";

export const setupUseCases = (
  youtubeSearchService: any,
  multiSourceSearchService: any,
  multiSourceDownloadService: any,
  spotifyService: any,
  spotifyUserLibraryService: any,
) => {
  // Use Cases - Settings
  const getSettingsUseCase = new GetSettingsUseCase(settingsRepository);
  const updateSettingUseCase = new UpdateSettingUseCase(
    settingsRepository,
    spotifyUserLibraryService,
    eventBus,
  );

  // Use Cases - Tracks
  const createTrackUseCase = new CreateTrackUseCase(trackRepository, queueService, eventBus);
  const deleteTrackUseCase = new DeleteTrackUseCase(trackRepository);
  const getTracksUseCase = new GetTracksUseCase(trackRepository);
  const updateTrackUseCase = new UpdateTrackUseCase(trackRepository);

  // Keep old YouTube search use case for backward compatibility
  const searchTrackOnYoutubeUseCase = new SearchTrackOnYoutubeUseCase(
    trackRepository,
    youtubeSearchService,
    settingsService,
    queueService,
    eventBus,
  );

  // New multi-source search use case
  const searchTrackUseCase = new SearchTrackUseCase(
    trackRepository,
    multiSourceSearchService,
    settingsService,
    queueService,
    eventBus,
  );

  const retryTrackDownloadUseCase = new RetryTrackDownloadUseCase(
    trackRepository,
    queueService,
    eventBus,
  );
  const rescueStuckTracksUseCase = new RescueStuckTracksUseCase(
    trackRepository,
    retryTrackDownloadUseCase,
  );

  // Use new multi-source download service
  const trackPostProcessingService = getTrackPostProcessingService();
  const downloadTrackUseCase = new DownloadTrackUseCase(
    trackRepository,
    multiSourceDownloadService,
    trackFileHelper,
    playlistRepository,
    historyRepository,
    eventBus,
    trackPostProcessingService,
  );

  // Use Cases - Playlists
  const getSystemStatusUseCase = new GetSystemStatusUseCase(playlistRepository);
  const getPlaylistPreviewUseCase = new GetPlaylistPreviewUseCase(spotifyService);
  const getPlaylistsUseCase = new GetPlaylistsUseCase(playlistRepository);
  const deletePlaylistUseCase = new DeletePlaylistUseCase(playlistRepository, eventBus);
  const updatePlaylistUseCase = new UpdatePlaylistUseCase(playlistRepository, eventBus);

  const createPlaylistUseCase = new CreatePlaylistUseCase(
    playlistRepository,
    spotifyService,
    getTrackService,
    settingsService,
    eventBus,
  );

  const syncSubscribedPlaylistsUseCase = new SyncSubscribedPlaylistsUseCase(
    playlistRepository,
    spotifyService,
    getTrackService,
    eventBus,
  );

  const retryPlaylistDownloadsUseCase = new RetryPlaylistDownloadsUseCase(
    playlistRepository,
    getTrackService,
  );

  const getMyPlaylistsUseCase = new GetMyPlaylistsUseCase(spotifyService);

  // Library Use Cases
  const scanLibraryUseCase = new ScanLibraryUseCase(
    fileSystemScannerService,
    trackFileHelper,
    trackRepository,
  );

  const historyUseCases = new HistoryUseCases({ repository: historyRepository });

  return {
    // Settings
    getSettingsUseCase,
    updateSettingUseCase,
    // Tracks
    createTrackUseCase,
    deleteTrackUseCase,
    getTracksUseCase,
    updateTrackUseCase,
    searchTrackOnYoutubeUseCase,
    searchTrackUseCase,
    retryTrackDownloadUseCase,
    rescueStuckTracksUseCase,
    downloadTrackUseCase,
    // Playlists
    getSystemStatusUseCase,
    getPlaylistPreviewUseCase,
    getPlaylistsUseCase,
    deletePlaylistUseCase,
    updatePlaylistUseCase,
    createPlaylistUseCase,
    syncSubscribedPlaylistsUseCase,
    retryPlaylistDownloadsUseCase,
    getMyPlaylistsUseCase,
    // Library
    scanLibraryUseCase,
    // History
    historyUseCases,
  };
};
