import { SettingsService } from "@/application/services/settings.service";
import { MultiSourceDownloadService } from "@/infrastructure/external/multi-source-download.service";
import { MultiSourceSearchService } from "@/infrastructure/external/multi-source-search.service";
import { RateLimitService } from "@/infrastructure/external/rate-limit.service";
import { SpotifyAlbumClient } from "@/infrastructure/external/spotify-album.client";
import { SpotifyArtistClient } from "@/infrastructure/external/spotify-artist.client";
import { SpotifyAuthService } from "@/infrastructure/external/spotify-auth.service";
import { SpotifyPlaylistClient } from "@/infrastructure/external/spotify-playlist.client";
import { SpotifySearchClient } from "@/infrastructure/external/spotify-search.client";
import { SpotifyTrackClient } from "@/infrastructure/external/spotify-track.client";
import { SpotifyUserLibraryService } from "@/infrastructure/external/spotify-user-library.service";
import { YoutubeDownloadService } from "@/infrastructure/external/youtube-download.service";
import { YoutubeSearchService } from "@/infrastructure/external/youtube-search.service";

export const setupExternalServices = (settingsService: SettingsService) => {
  // Rate limit service - shared across all sources
  const rateLimitService = new RateLimitService();

  // YouTube services
  const youtubeSearchService = new YoutubeSearchService(settingsService, rateLimitService);
  const youtubeDownloadService = new YoutubeDownloadService(
    settingsService,
    youtubeSearchService,
    rateLimitService,
  );

  // Multi-source search and download services
  const multiSourceSearchService = new MultiSourceSearchService(
    settingsService,
    youtubeSearchService,
    youtubeSearchService.getYtDlpPath(),
    rateLimitService,
  );
  const multiSourceDownloadService = new MultiSourceDownloadService(
    settingsService,
    youtubeSearchService,
    youtubeDownloadService,
    rateLimitService,
  );

  // Spotify services
  const spotifyAuthService = SpotifyAuthService.getInstance(settingsService);
  const spotifyArtistClient = new SpotifyArtistClient(spotifyAuthService, settingsService);
  const spotifyTrackClient = new SpotifyTrackClient(
    spotifyAuthService,
    settingsService,
    spotifyArtistClient,
  );
  const spotifyAlbumClient = new SpotifyAlbumClient(
    spotifyAuthService,
    settingsService,
    spotifyArtistClient,
  );
  const spotifyPlaylistClient = new SpotifyPlaylistClient(
    spotifyAuthService,
    settingsService,
    spotifyTrackClient,
    spotifyAlbumClient,
  );
  const spotifySearchClient = new SpotifySearchClient(
    spotifyAuthService,
    settingsService,
    spotifyArtistClient,
  );
  const spotifyUserLibraryService = SpotifyUserLibraryService.getInstance(
    settingsService,
    spotifyAuthService,
  );

  return {
    rateLimitService,
    youtubeSearchService,
    youtubeDownloadService,
    multiSourceSearchService,
    multiSourceDownloadService,
    spotifyAuthService,
    spotifyArtistClient,
    spotifyTrackClient,
    spotifyAlbumClient,
    spotifyPlaylistClient,
    spotifySearchClient,
    spotifyUserLibraryService,
  };
};
