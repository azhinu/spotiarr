export const DEFAULT_EXTERNAL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
} as const;

export enum MusicServiceKey {
  SoundCloudSearch = "soundcloud:search",
  SoundCloudDownload = "soundcloud:download",
  YoutubeSearch = "youtube:search",
  YoutubeDownload = "youtube:download",
}
