import { type ITrack } from "@spotiarr/shared";
import * as fs from "fs";
import * as path from "path";
import { AppError } from "@/domain/errors/app-error";
import { YoutubeRateLimitError } from "@/domain/errors/youtube-rate-limit.error";
import { EventBus } from "@/domain/events/event-bus";
import { HistoryRepository } from "@/domain/repositories/history.repository";
import { PlaylistRepository } from "@/domain/repositories/playlist.repository";
import { TrackRepository } from "@/domain/repositories/track.repository";
import { MultiSourceDownloadService } from "@/infrastructure/external/multi-source-download.service";
import { FileSystemTrackPathService } from "@/infrastructure/services/file-system-track-path.service";
import { getErrorMessage } from "@/infrastructure/utils/error.utils";
import { TrackPostProcessingService } from "../../services/track-post-processing.service";

export class DownloadTrackUseCase {
  constructor(
    private readonly trackRepository: TrackRepository,
    private readonly multiSourceDownloadService: MultiSourceDownloadService,
    private readonly trackFileHelper: FileSystemTrackPathService,
    private readonly playlistRepository: PlaylistRepository,
    private readonly downloadHistoryRepository: HistoryRepository,
    private readonly eventBus: EventBus,
    private readonly trackPostProcessingService: TrackPostProcessingService,
  ) {}

  async execute(trackData: ITrack): Promise<void> {
    // Validate track exists and get Entity
    if (!trackData.id) return;
    const track = await this.trackRepository.findOne(trackData.id);

    if (!track || !track.id) {
      return;
    }

    // Validate required fields
    this.validateTrack(track.toPrimitive());

    // Update status to Downloading
    track.markAsDownloading();
    await this.trackRepository.update(track.id, track);
    this.eventBus.emit("playlists-updated");

    let error: string | undefined;

    try {
      await this.downloadAndProcessTrack(track.toPrimitive());
    } catch (err) {
      // Re-throw YouTube rate limit errors to be handled by worker
      if (err instanceof YoutubeRateLimitError) {
        throw err;
      }

      console.error(
        `Failed to download track: ${track.artist} - ${track.name}`,
        getErrorMessage(err),
      );
      error = getErrorMessage(err);
    }

    // Update final status
    if (error) {
      track.markAsError(error);
    } else {
      track.markAsCompleted();
    }

    await this.trackRepository.update(track.id, track);

    // Persist in download history when successful
    if (!error) {
      // We need playlist info; reload with relations so playlist is present
      // Note: findOneWithPlaylist returns Track entity now
      const persistedTrack = await this.trackRepository.findOneWithPlaylist(track.id);
      if (persistedTrack) {
        // downloadHistoryRepository likely expects ITrack, check this later.
        // Assuming it expects ITrack for now as we haven't touched it.
        await this.downloadHistoryRepository.createFromTrack(persistedTrack.toPrimitive());
        this.eventBus.emit("download-history-updated");
      }

      // Generate M3U if successful (NOW SAFE: track is marked as completed in DB)
      // This fixes the issue where the current track was missing from M3U
      await this.trackPostProcessingService.updatePlaylistM3u(track.toPrimitive());
    }

    // Notify playlists have changed (track status affects playlist state)
    this.eventBus.emit("playlists-updated");
  }

  private validateTrack(track: ITrack): void {
    if (!track.name || !track.artist) {
      const errorMsg = `Track field is null or undefined: name=${track.name}, artist=${track.artist}`;
      console.error(errorMsg);
      throw new AppError(400, "internal_server_error", errorMsg);
    }
  }

  private async downloadAndProcessTrack(track: ITrack): Promise<void> {
    // Always download to Artist/Album directory structure
    const trackFilePath = await this.trackFileHelper.getFolderName(track);
    const trackDirectory = path.dirname(trackFilePath);

    // Create directory structure
    if (!fs.existsSync(trackDirectory)) {
      fs.mkdirSync(trackDirectory, { recursive: true });
    }

    // 1. Download Content
    await this.multiSourceDownloadService.downloadAndFormat(track, trackFilePath);

    // 2. Post-Processing (Metadata, Covers, M3U)
    // Delegated to dedicated service to keep Use Case clean
    console.debug(`[DownloadTrackUseCase] Starting post-processing for ${track.artist} - ${track.name}`);
    await this.trackPostProcessingService.process(track, trackFilePath);
    console.debug(`[DownloadTrackUseCase] Post-processing completed for ${track.artist} - ${track.name}`);

    // 3. Create symlink in playlist folder if this is a playlist download
    if (track.playlistId) {
      const playlist = await this.playlistRepository.findOne(track.playlistId);
      // Check if it's strictly a playlist (not artist or album download)
      if (playlist && playlist.type === "playlist" && playlist.name) {
        await this.createPlaylistSymlink(track, trackFilePath, playlist.name);
      }
    }
  }

  private async createPlaylistSymlink(
    track: ITrack,
    targetPath: string,
    playlistName: string,
  ): Promise<void> {
    try {
      const symlinkPath = await this.trackFileHelper.getPlaylistSymlinkPath(track, playlistName);
      const symlinkDirectory = path.dirname(symlinkPath);

      // Create playlist directory if it doesn't exist
      if (!fs.existsSync(symlinkDirectory)) {
        fs.mkdirSync(symlinkDirectory, { recursive: true });
      }

      // Remove existing symlink if it exists
      if (fs.existsSync(symlinkPath)) {
        fs.unlinkSync(symlinkPath);
      }

      // Create symlink (relative path for portability)
      const relativePath = path.relative(symlinkDirectory, targetPath);
      fs.symlinkSync(relativePath, symlinkPath);

      console.log(
        `Created symlink for playlist "${playlistName}": ${symlinkPath} -> ${targetPath}`,
      );
    } catch (err) {
      console.error(
        `Failed to create symlink for track in playlist "${playlistName}":`,
        getErrorMessage(err),
      );
      // Don't throw - symlink creation is not critical for download success
    }
  }
}
