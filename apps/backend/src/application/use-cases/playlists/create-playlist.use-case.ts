import { NormalizedTrack, PlaylistTypeEnum, TrackStatusEnum, type IPlaylist } from "@spotiarr/shared";
import { Playlist } from "@/domain/entities/playlist.entity";
import { AppError } from "@/domain/errors/app-error";
import { EventBus } from "@/domain/events/event-bus";
import { SpotifyUrlHelper, SpotifyUrlType } from "@/domain/helpers/spotify-url.helper";
import type { PlaylistRepository } from "@/domain/repositories/playlist.repository";
import { SpotifyService } from "@/domain/services/spotify.service";
import { SettingsService } from "../../services/settings.service";
import { TrackService } from "../../services/track.service";

interface PlaylistDetail {
  tracks: NormalizedTrack[];
  name: string;
  image: string;
  type: string;
  owner?: string;
  ownerUrl?: string;
}

export class CreatePlaylistUseCase {
  constructor(
    private readonly playlistRepository: PlaylistRepository,
    private readonly spotifyService: SpotifyService,
    private readonly trackService: TrackService,
    private readonly settingsService: SettingsService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(playlistData: IPlaylist): Promise<IPlaylist> {
    const existing = await this.playlistRepository.findAll(false, {
      spotifyUrl: playlistData.spotifyUrl,
    });

    // Use existing playlist if it exists, otherwise create new one
    let playlist: Playlist;
    if (existing.length > 0) {
      playlist = existing[0];
    } else {
      playlist = new Playlist(playlistData);
    }

    let detail: PlaylistDetail | undefined;

    try {
      detail = await this.spotifyService.getPlaylistDetail(playlist.spotifyUrl);
      console.debug(`Playlist detail retrieved with ${detail.tracks?.length || 0} tracks`);

      let displayName = detail.name;
      if ((detail.type === "track" || detail.type === "album") && detail.tracks?.length > 0) {
        const firstTrack = detail.tracks[0];
        const artistName = firstTrack.primaryArtist || firstTrack.artist;
        if (artistName && detail.name) {
          displayName = `${artistName} - ${detail.name}`;
        }
      } else if (detail.type === "artist") {
        displayName = detail.name;
      }

      const artistImageUrl =
        detail.type === "artist"
          ? detail.image || null
          : detail.tracks?.[0]?.primaryArtistImage || null;

      const autoSubscribe = await this.settingsService.getBoolean("AUTO_SUBSCRIBE_NEW_PLAYLISTS");

      playlist.updateDetails(
        displayName,
        detail.type as PlaylistTypeEnum,
        detail.image,
        artistImageUrl ?? undefined,
        detail.owner,
        detail.ownerUrl,
      );

      if (autoSubscribe) {
        playlist.markAsSubscribed();
      }
    } catch (error) {
      console.error(
        `Error getting playlist details: ${playlist.spotifyUrl}`,
        error instanceof Error ? error.stack : String(error),
      );
      playlist.markAsError(error instanceof Error ? error.message : String(error));
    }

    // Save or update playlist
    let savedPlaylistEntity;
    if (playlist.id) {
      // Update existing playlist
      await this.playlistRepository.update(playlist.id, playlist);
      const updated = await this.playlistRepository.findOne(playlist.id);
      if (!updated) {
        throw new AppError(500, "internal_server_error", "Failed to update playlist");
      }
      savedPlaylistEntity = updated;
    } else {
      // Save new playlist
      savedPlaylistEntity = await this.playlistRepository.save(playlist);
    }
    const savedPlaylist = savedPlaylistEntity.toPrimitive();

    if (detail?.tracks && detail.tracks.length > 0) {
      await this.processTracks(savedPlaylist, detail.tracks);
    } else {
      console.warn(`No tracks found for playlist ${savedPlaylist.name}`);
    }

    this.eventBus.emit("playlists-updated");
    return savedPlaylist;
  }

  private async processTracks(playlist: IPlaylist, tracks: NormalizedTrack[]): Promise<void> {
    console.debug(`Starting to process ${tracks.length} tracks for playlist ${playlist.name}`);

    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    const urlType = SpotifyUrlHelper.getUrlType(playlist.spotifyUrl);
    const context = {
      isTrack: urlType === SpotifyUrlType.Track,
      isAlbum: urlType === SpotifyUrlType.Album,
      isArtist: urlType === SpotifyUrlType.Artist,
      playlistId: playlist.id,
      playlistName: playlist.name ?? "Unknown Playlist",
    };

    // Get existing tracks in playlist to avoid duplicates
    const existingTracks = await this.trackService.getAllByPlaylist(playlist.id);
    const existingTrackMap = new Map(
      existingTracks.map((t) => [`${t.artist}|${t.name}`, t] as const)
    );

    const BATCH_SIZE = 10;
    for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
      const batch = tracks.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((track, index) => 
          this.processTrack(track, i + index, context, existingTrackMap)
        ),
      );

      for (const result of results) {
        if (result === "ok") processedCount++;
        else if (result === "skipped") skippedCount++;
        else errorCount++;
      }

      if (processedCount % 50 === 0 && processedCount > 0) {
        console.debug(`Processed ${processedCount} tracks so far for playlist ${playlist.name}`);
      }
    }

    console.debug(
      `Finished processing playlist ${playlist.name}: ${processedCount} tracks processed, ${skippedCount} skipped, ${errorCount} errors`,
    );
  }

  private async processTrack(
    track: NormalizedTrack,
    index: number,
    context: {
      isTrack: boolean;
      isAlbum: boolean;
      isArtist: boolean;
      playlistId: string;
      playlistName: string;
    },
    existingTrackMap: Map<string, any>,
  ): Promise<"ok" | "skipped" | "error"> {
    try {
      if (!track.artist || !track.name) {
        console.warn(`Skipping track ${index + 1}: Missing artist or name information`);
        return "skipped";
      }

      if (track.unavailable === true) {
        console.warn(`Skipping unavailable track ${index + 1}: ${track.artist} - ${track.name}`);
        return "skipped";
      }

      const artistToUse =
        (context.isAlbum || context.isTrack || context.isArtist) && track.primaryArtist
          ? track.primaryArtist
          : track.artist;

      const trackKey = `${artistToUse}|${track.name}`;
      const existingTrack = existingTrackMap.get(trackKey);

      // Check if track already exists
      if (existingTrack) {
        // Skip only if track is already completed
        if (existingTrack.status === TrackStatusEnum.Completed) {
          console.debug(`Track already completed, skipping: ${artistToUse} - ${track.name}`);
          return "skipped";
        }
        // For failed tracks, re-queue them
        console.debug(`Re-queuing track with status ${existingTrack.status}: ${artistToUse} - ${track.name}`);
        await this.trackService.findTrack(existingTrack);
        return "ok";
      }

      // Create new track
      const useSinglesFallback = context.isTrack || context.isArtist;
      const trackNumber = track.trackNumber ?? index + 1;

      await this.trackService.create({
        artist: artistToUse,
        name: track.name,
        album: track.album ?? (useSinglesFallback ? "Singles" : context.playlistName),
        albumYear: track.albumYear,
        trackNumber: trackNumber,
        spotifyUrl: track.previewUrl ?? undefined,
        artists: track.artists,
        trackUrl: track.trackUrl,
        albumUrl: track.albumUrl,
        durationMs: track.durationMs,
        playlistId: context.playlistId,
        playlistIndex: index + 1,
      });

      return "ok";
    } catch (error) {
      console.error(
        `Error creating track "${track?.artist || "Unknown"} - ${track?.name || "Unknown"}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return "error";
    }
  }
}
