import { NormalizedTrack, PlaylistTypeEnum, type ITrack } from "@spotiarr/shared";
import * as fs from "fs";
import * as path from "path";
import { PlaylistRepository } from "@/domain/repositories/playlist.repository";
import { TrackRepository } from "@/domain/repositories/track.repository";
import { SpotifyService } from "@/domain/services/spotify.service";
import { FileSystemM3uService } from "@/infrastructure/services/file-system-m3u.service";
import { FileSystemTrackPathService } from "@/infrastructure/services/file-system-track-path.service";
import { MetadataService } from "@/infrastructure/services/metadata.service";
import { getErrorMessage } from "@/infrastructure/utils/error.utils";

export class TrackPostProcessingService {
  constructor(
    private readonly spotifyService: SpotifyService,
    private readonly metadataService: MetadataService,
    private readonly playlistRepository: PlaylistRepository,
    private readonly trackRepository: TrackRepository,
    private readonly trackPathService: FileSystemTrackPathService,
    private readonly m3uService: FileSystemM3uService,
  ) {}

  /**
   * Handles metadata embedding, cover art saving
   * NOTE: Does NOT generate M3U. Call updatePlaylistM3u() after saving the track status.
   */
  async process(track: ITrack, trackFilePath: string): Promise<void> {
    try {
      console.log(`[PostProcessing] Starting metadata enrichment for: ${track.artist} - ${track.name}`);
      console.log(`[PostProcessing] Available URLs - trackUrl: ${track.trackUrl || 'none'}, spotifyUrl: ${track.spotifyUrl || 'none'}`);

      const { playlistCoverUrl, isPlaylistType } = await this.getPlaylistCoverInfo(track);
      const spotifyTrackMetadata = await this.getSpotifyTrackMetadata(track);

      if (spotifyTrackMetadata) {
        console.log(`[PostProcessing] ✓ Spotify metadata received:`, {
          name: spotifyTrackMetadata.name,
          artist: spotifyTrackMetadata.artist,
          album: spotifyTrackMetadata.album,
          albumYear: spotifyTrackMetadata.albumYear,
          trackNumber: spotifyTrackMetadata.trackNumber,
          discNumber: spotifyTrackMetadata.discNumber,
          totalTracks: spotifyTrackMetadata.totalTracks,
          hasCover: !!spotifyTrackMetadata.albumCoverUrl
        });
      } else {
        console.warn(`[PostProcessing] ✗ No Spotify metadata available, using track data as-is`);
      }

      const title = spotifyTrackMetadata?.name ?? track.name;
      const artist = spotifyTrackMetadata?.artist ?? track.artist;
      const album = spotifyTrackMetadata?.album ?? track.album;
      const albumYear = spotifyTrackMetadata?.albumYear ?? track.albumYear;
      const trackNumber = spotifyTrackMetadata?.trackNumber ?? track.trackNumber;
      const discNumber = spotifyTrackMetadata?.discNumber ?? track.discNumber;
      const totalTracks = spotifyTrackMetadata?.totalTracks ?? track.totalTracks;
      const trackCoverUrl = spotifyTrackMetadata?.albumCoverUrl ?? "";

      // 1. Embed ID3 Tags (prefer specific track cover)
      await this.metadataService.writeTags(trackFilePath, {
        title,
        artist,
        album,
        albumYear,
        trackNumber,
        discNumber,
        totalTracks,
        coverUrl: trackCoverUrl || playlistCoverUrl || "",
      });

      console.log(`[PostProcessing] ✓ ID3 tags written successfully to ${trackFilePath}`);

      // 2. Save folder cover.jpg
      const trackDirectory = path.dirname(trackFilePath);
      const folderCoverUrl = isPlaylistType ? playlistCoverUrl : trackCoverUrl;

      if (folderCoverUrl) {
        await this.metadataService.saveCoverArt(trackDirectory, folderCoverUrl);
      }

      // 3. Save Artist Image (if applicable)
      await this.saveArtistImageIfNeeded(track);
    } catch (error) {
      console.error(
        `Error during post-processing for track ${track.name}: ${getErrorMessage(error)}`,
      );
      // We don't throw here to avoid failing the whole download if just metadata fails
    }
  }

  async updatePlaylistM3u(track: ITrack): Promise<void> {
    if (!track.playlistId) return;

    try {
      const playlistEntity = await this.playlistRepository.findOne(track.playlistId);

      // Only generate M3U for actual playlists
      if (!playlistEntity || !playlistEntity.name || playlistEntity.type !== "playlist") {
        return;
      }

      const playlist = playlistEntity.toPrimitive();
      const playlistTracksEntities = await this.trackRepository.findAllByPlaylist(track.playlistId);
      const playlistTracks = playlistTracksEntities.map((t) => t.toPrimitive());

      if (playlistTracks.length > 0) {
        const playlistFolderPath = this.trackPathService.getPlaylistFolderPath(playlist.name!);
        await this.m3uService.generateM3uFile(playlist, playlistTracks, playlistFolderPath);

        const completedCount = this.m3uService.getCompletedTracksCount(playlistTracks);
        console.debug(`Playlist M3U updated: ${completedCount}/${playlistTracks.length} tracks`);
      }
    } catch (err) {
      console.error(`Failed to generate M3U file: ${getErrorMessage(err)}`);
    }
  }

  private async getPlaylistCoverInfo(track: ITrack): Promise<{
    playlistCoverUrl?: string;
    isPlaylistType: boolean;
  }> {
    let playlistCoverUrl: string | undefined;
    let isPlaylistType = false;

    // Get Playlist Info
    if (track.playlistId) {
      const playlist = await this.playlistRepository.findOne(track.playlistId);
      isPlaylistType = playlist?.type === "playlist";
      if (playlist) {
        playlistCoverUrl = playlist.coverUrl;
      }
    }

    return { playlistCoverUrl, isPlaylistType };
  }

  private async getSpotifyTrackMetadata(track: ITrack): Promise<NormalizedTrack | null> {
    const spotifyTrackUrl =
      track.trackUrl ||
      (track.spotifyUrl && track.spotifyUrl.includes("/track/") ? track.spotifyUrl : undefined);

    if (spotifyTrackUrl) {
      console.log(`[PostProcessing] Fetching Spotify metadata from URL: ${spotifyTrackUrl}`);
      
      try {
        const details = await this.spotifyService.getPlaylistDetail(spotifyTrackUrl);
        const trackData = details.tracks[0] ?? null;
        
        if (trackData) {
          return trackData;
        }
        
        console.warn(`[PostProcessing] Spotify returned empty tracks array for ${spotifyTrackUrl}`);
      } catch (error) {
        console.error(`[PostProcessing] Failed to fetch Spotify metadata from URL ${spotifyTrackUrl}: ${getErrorMessage(error)}`);
      }
    } else {
      console.log(`[PostProcessing] No trackUrl available, trying Spotify search for: ${track.artist} - ${track.name}`);
    }

    // Fallback: search by artist and track name
    try {
      const searchQuery = `${track.artist} ${track.name}`;
      console.log(`[PostProcessing] Searching Spotify for: "${searchQuery}"`);
      
      const searchResults = await this.spotifyService.searchCatalog(searchQuery, ["track"], { track: 1 });
      
      if (searchResults.tracks && searchResults.tracks.length > 0) {
        const foundTrack = searchResults.tracks[0];
        console.log(`[PostProcessing] ✓ Found track via search: ${foundTrack.artist} - ${foundTrack.name}`);
        return foundTrack;
      } else {
        console.warn(`[PostProcessing] No results from Spotify search for "${searchQuery}"`);
      }
    } catch (error) {
      console.error(`[PostProcessing] Failed to search Spotify for track ${track.name}: ${getErrorMessage(error)}`);
    }

    return null;
  }

  private async saveArtistImageIfNeeded(track: ITrack): Promise<void> {
    if (!track.playlistId) return;

    try {
      const playlist = await this.playlistRepository.findOne(track.playlistId);

      // Only save artist image if it's NOT a generic playlist and we have an image
      if (playlist && playlist.type !== PlaylistTypeEnum.Playlist && playlist.artistImageUrl) {
        const artistFolderPath = this.trackPathService.getArtistFolderPath(track.artist);

        if (!fs.existsSync(artistFolderPath)) {
          fs.mkdirSync(artistFolderPath, { recursive: true });
        }

        // Save as folder.jpg (standard)
        await this.metadataService.saveCoverArt(
          artistFolderPath,
          playlist.artistImageUrl,
          "folder.jpg",
        );
      }
    } catch (error) {
      console.warn(`Failed to save artist image: ${getErrorMessage(error)}`);
    }
  }
}
