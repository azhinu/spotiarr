import type { ITrack } from "@spotiarr/shared";
import { resolve } from "path";
import { SettingsService } from "@/application/services/settings.service";
import { getEnv } from "../setup/environment";

export class FileSystemTrackPathService {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Get the base music library path
   */
  getMusicLibraryPath(): string {
    return getEnv().DOWNLOADS;
  }

  /**
   * Get the artist folder path following Jellyfin structure: Music/Artist/
   */
  getArtistFolderPath(artistName: string): string {
    return resolve(
      this.getMusicLibraryPath(),
      this.stripFileIllegalChars(artistName || "Unknown Artist"),
    );
  }

  /**
   * Get the album folder path following Jellyfin structure: Music/Artist/Album/
   */
  getAlbumFolderPath(artistName: string, albumName: string): string {
    return resolve(
      this.getArtistFolderPath(artistName),
      this.stripFileIllegalChars(albumName || "Unknown Album"),
    );
  }

  /**
   * Get the playlists folder path: Music/Playlists/
   */
  getPlaylistsLibraryPath(): string {
    return resolve(this.getMusicLibraryPath(), "Playlists");
  }

  /**
   * Get specific playlist folder path: Music/Playlists/PlaylistName/
   */
  getPlaylistFolderPath(playlistName: string): string {
    return resolve(
      this.getPlaylistsLibraryPath(),
      this.stripFileIllegalChars(playlistName || "Unknown Playlist"),
    );
  }

  stripFileIllegalChars(text: string): string {
    return text.replace(/[/\\?%*:|"<>]/g, "-");
  }

  /**
   * Get the full path for the actual track file (always in Artist/Album structure)
   */
  async getTrackFileName(track: ITrack): Promise<string> {
    const format = await this.settingsService.getString("FORMAT");
    const trackName = track.name || "Unknown Track";
    const artistName = track.artist || "Unknown Artist";
    const albumName = track.album || "Unknown Album";

    const fileName = `${this.stripFileIllegalChars(trackName)}.${format}`;
    return resolve(this.getAlbumFolderPath(artistName, albumName), fileName);
  }

  /**
   * Get the symlink path for a track in a playlist folder
   */
  async getPlaylistSymlinkPath(track: ITrack, playlistName: string): Promise<string> {
    const format = await this.settingsService.getString("FORMAT");
    const trackName = track.name || "Unknown Track";
    const artistName = track.artist || "Unknown Artist";
    const safeArtist = this.stripFileIllegalChars(artistName);
    const safeTrack = this.stripFileIllegalChars(trackName);
    const fileName = `${safeArtist} - ${safeTrack}.${format}`;
    return resolve(this.getPlaylistFolderPath(playlistName), fileName);
  }

  async getFolderName(track: ITrack): Promise<string> {
    return this.getTrackFileName(track);
  }
}
