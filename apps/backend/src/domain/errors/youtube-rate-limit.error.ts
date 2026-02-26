/**
 * Thrown when YouTube rate-limits the download session
 */
export class YoutubeRateLimitError extends Error {
  constructor(message: string = "YouTube has rate-limited the session") {
    super(message);
    this.name = "YoutubeRateLimitError";
  }
}
