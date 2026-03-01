import { ArtistController } from "@/presentation/controllers/artist.controller";
import { AuthController } from "@/presentation/controllers/auth.controller";
import { EventsController } from "@/presentation/controllers/events.controller";
import { FeedController } from "@/presentation/controllers/feed.controller";
import { HealthController } from "@/presentation/controllers/health.controller";
import { HistoryController } from "@/presentation/controllers/history.controller";
import { LibraryController } from "@/presentation/controllers/library.controller";
import { PlaylistController } from "@/presentation/controllers/playlist.controller";
import { SearchController } from "@/presentation/controllers/search.controller";
import { SettingsController } from "@/presentation/controllers/settings.controller";
import { TrackController } from "@/presentation/controllers/track.controller";

export const setupControllers = (useCases: any, services: any, externalServices: any) => {
  const {
    getTracksUseCase,
    retryTrackDownloadUseCase,
    deleteTrackUseCase,
    getSettingsUseCase,
    updateSettingUseCase,
    createPlaylistUseCase,
    deletePlaylistUseCase,
    getMyPlaylistsUseCase,
    getPlaylistPreviewUseCase,
    getPlaylistsUseCase,
    getSystemStatusUseCase,
    retryPlaylistDownloadsUseCase,
    updatePlaylistUseCase,
    historyUseCases,
  } = useCases;

  const { libraryService } = services;
  const { spotifyArtistClient, spotifyService, spotifyAuthService, spotifyUserLibraryService } =
    externalServices;

  // Controllers
  const trackController = new TrackController(
    deleteTrackUseCase,
    getTracksUseCase,
    retryTrackDownloadUseCase,
  );

  const playlistController = new PlaylistController(
    createPlaylistUseCase,
    deletePlaylistUseCase,
    getMyPlaylistsUseCase,
    getPlaylistPreviewUseCase,
    getPlaylistsUseCase,
    getSystemStatusUseCase,
    retryPlaylistDownloadsUseCase,
    updatePlaylistUseCase,
  );

  const libraryController = new LibraryController(libraryService);
  const artistController = new ArtistController(spotifyArtistClient);
  const searchController = new SearchController(spotifyService);
  const settingsController = new SettingsController(getSettingsUseCase, updateSettingUseCase);
  const historyController = new HistoryController(historyUseCases);
  const feedController = new FeedController(spotifyUserLibraryService);
  const authController = new AuthController(spotifyAuthService, services.settingsService);
  const healthController = new HealthController();
  const eventsController = new EventsController();

  return {
    trackController,
    playlistController,
    libraryController,
    artistController,
    searchController,
    settingsController,
    historyController,
    feedController,
    authController,
    healthController,
    eventsController,
  };
};
