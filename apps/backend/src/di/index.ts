import { SpotifyService } from "@/domain/services/spotify.service";
import { setupControllers } from "./controllers";
import { setupExternalServices } from "./external-services";
import { playlistRepository, trackRepository, historyRepository } from "./repositories";
import {
  settingsService,
  queueService,
  eventBus,
  trackFileHelper,
  metadataService,
  m3uService,
  fileSystemScannerService,
  setupApplicationServices,
} from "./services";
import { setupUseCases } from "./use-cases";

// Initialize all DI modules
const externalServices = setupExternalServices(settingsService);

// Spotify service (needed for setup)
const spotifyService = new SpotifyService(
  externalServices.spotifyArtistClient,
  externalServices.spotifyTrackClient,
  externalServices.spotifyAlbumClient,
  externalServices.spotifyPlaylistClient,
  externalServices.spotifySearchClient,
  externalServices.spotifyUserLibraryService,
);

const useCases = setupUseCases(
  externalServices.youtubeSearchService,
  externalServices.multiSourceSearchService,
  externalServices.multiSourceDownloadService,
  spotifyService,
  externalServices.spotifyUserLibraryService,
);

const services = setupApplicationServices(spotifyService, useCases);

const controllers = setupControllers(useCases, services, externalServices);

eventBus.setSseEmitter(controllers.eventsController.emit);

// Export container with all resources
export const container = {
  // Controllers
  ...controllers,

  // Services
  ...services,

  // External Services
  spotifyService,
  spotifyArtistClient: externalServices.spotifyArtistClient,
  spotifyTrackClient: externalServices.spotifyTrackClient,
  spotifyAlbumClient: externalServices.spotifyAlbumClient,
  spotifyPlaylistClient: externalServices.spotifyPlaylistClient,
  spotifySearchClient: externalServices.spotifySearchClient,
  spotifyUserLibraryService: externalServices.spotifyUserLibraryService,
  spotifyAuthService: externalServices.spotifyAuthService,

  // Core Services
  settingsService,
  queueService,
  eventBus,
  trackPostProcessingService: services.trackPostProcessingService,
  rescueStuckTracksUseCase: useCases.rescueStuckTracksUseCase,
  libraryService: services.libraryService,
  rateLimitService: externalServices.rateLimitService,

  // Use Cases
  getSettingsUseCase: useCases.getSettingsUseCase,
  updateSettingUseCase: useCases.updateSettingUseCase,
};
