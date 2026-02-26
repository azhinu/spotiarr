import type { ITrack } from "@spotiarr/shared";

export type MusicSource = "soundcloud" | "youtube";

/**
 * Interface for searching tracks on a specific music source
 */
export interface ITrackSearchService {
  /**
   * Search for a track and return the URL
   * @throws AppError if track not found
   * @throws YoutubeRateLimitError if rate limited
   */
  findTrackUrl(artist: string, name: string): Promise<string>;
}

/**
 * Interface for downloading tracks from a specific music source
 */
export interface ITrackDownloadService {
  /**
   * Download and format a track
   * @param track The track to download
   * @param outputPath The path where the audio file should be saved
   * @throws AppError for various error conditions
   */
  downloadAndFormat(track: ITrack, outputPath: string): Promise<void>;

  /**
   * Check if this service can handle downloading from the given URL
   */
  canHandle(url: string): boolean;
}

/**
 * Combined interface for a complete music source
 */
export interface IMusicSourceService extends ITrackSearchService, ITrackDownloadService {
  /** Human-readable source name */
  readonly sourceName: MusicSource;
}
