import { TrackStatusEnum, type LibraryArtist, type LibraryScanResult } from "@spotiarr/shared";
import { TrackRepository } from "@/domain/repositories/track.repository";
import { FileSystemScannerService } from "@/infrastructure/services/file-system-scanner.service";
import { FileSystemTrackPathService } from "@/infrastructure/services/file-system-track-path.service";

export class ScanLibraryUseCase {
  constructor(
    private readonly scannerService: FileSystemScannerService,
    private readonly pathService: FileSystemTrackPathService,
    private readonly trackRepository?: TrackRepository,
  ) {}

  async execute(): Promise<LibraryScanResult> {
    const startTime = Date.now();
    const libraryPath = this.pathService.getMusicLibraryPath();

    console.log(`🔍 Scanning music library at: ${libraryPath}`);

    const artists = await this.scannerService.scanMusicLibrary(libraryPath);

    const syncResult = await this.syncTracksWithLibrary(artists);

    // Try to attach duration from DB if available
    if (this.trackRepository) {
      try {
        const completedTracks = await this.trackRepository.findAllByStatuses([
          TrackStatusEnum.Completed,
        ]);

        // Build map for quick lookup. A precise match requires matching title and artist.
        const dbTrackMap = new Map<string, number>();
        for (const t of completedTracks) {
          const trackData = t.toPrimitive();
          if (trackData.durationMs) {
            // Simplified key: lowercase artist + name to maximize matches
            const key = `${trackData.artist.toLowerCase()} - ${trackData.name.toLowerCase()}`;
            dbTrackMap.set(key, trackData.durationMs);
          }
        }

        for (const artist of artists) {
          for (const album of artist.albums) {
            for (const track of album.tracks) {
              const key = `${track.artist.toLowerCase()} - ${track.name.toLowerCase()}`;
              const durationMs = dbTrackMap.get(key);
              if (!track.duration && durationMs) {
                // frontend expects duration in seconds (based on frontend's * 1000)
                track.duration = Math.round(durationMs / 1000);
              }
            }
          }
        }
      } catch (err) {
        console.warn("Failed to attach track durations from database:", err);
      }
    }

    const totalArtists = artists.length;
    const totalAlbums = artists.reduce((sum, artist) => sum + artist.albumCount, 0);
    const totalTracks = artists.reduce((sum, artist) => sum + artist.trackCount, 0);
    const totalSize = artists.reduce((sum, artist) => sum + artist.totalSize, 0);

    const scanDuration = Date.now() - startTime;

    console.log(`✅ Library scan completed in ${scanDuration}ms`);
    console.log(`   Found: ${totalArtists} artists, ${totalAlbums} albums, ${totalTracks} tracks`);
    console.log(`   Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    if (this.trackRepository) {
      console.log(
        `   DB sync: matched ${syncResult.matched}, updated ${syncResult.updated}, imported ${syncResult.imported}, removed ${syncResult.removed}`,
      );
    }

    return {
      artists,
      totalArtists,
      totalAlbums,
      totalTracks,
      totalSize,
      lastScannedAt: Date.now(),
      scanDuration,
    };
  }

  private async syncTracksWithLibrary(artists: LibraryArtist[]): Promise<{
    matched: number;
    updated: number;
    imported: number;
    removed: number;
  }> {
    if (!this.trackRepository) {
      return { matched: 0, updated: 0, imported: 0, removed: 0 };
    }

    const fullKeySet = new Set<string>();
    const baseKeySet = new Set<string>();
    const scannedTrackMap = new Map<
      string,
      {
        artist: string;
        name: string;
        album: string;
        trackNumber?: number;
        durationMs?: number;
      }
    >();

    for (const artist of artists) {
      for (const album of artist.albums) {
        for (const track of album.tracks) {
          const baseKey = this.buildBaseKey(track.artist, track.name);
          const fullKey = this.buildFullKey(track.artist, track.name, track.album);

          baseKeySet.add(baseKey);
          fullKeySet.add(fullKey);

          if (!scannedTrackMap.has(fullKey)) {
            scannedTrackMap.set(fullKey, {
              artist: track.artist,
              name: track.name,
              album: track.album,
              trackNumber: track.trackNumber,
              durationMs: track.duration ? Math.round(track.duration * 1000) : undefined,
            });
          }
        }
      }
    }

    const dbTracks = await this.trackRepository.findAll();
    const foundAt = Date.now();
    const existingFullKeys = new Set<string>();
    const existingBaseKeys = new Set<string>();

    let matched = 0;
    let updated = 0;
    let imported = 0;
    let removed = 0;

    for (const dbTrackEntity of dbTracks) {
      const dbTrack = dbTrackEntity.toPrimitive();
      if (!dbTrack.id) continue;

      const hasAlbum = !!dbTrack.album?.trim();
      const fullKey = this.buildFullKey(dbTrack.artist, dbTrack.name, dbTrack.album || "");
      const baseKey = this.buildBaseKey(dbTrack.artist, dbTrack.name);

      existingFullKeys.add(fullKey);
      existingBaseKeys.add(baseKey);

      const existsInLibrary = hasAlbum ? fullKeySet.has(fullKey) : baseKeySet.has(baseKey);

      if (existsInLibrary) {
        matched += 1;

        const needsUpdate =
          dbTrack.status !== TrackStatusEnum.Completed ||
          !dbTrack.completedAt ||
          !!dbTrack.error;

        if (needsUpdate) {
          await this.trackRepository.update(dbTrack.id, {
            status: TrackStatusEnum.Completed,
            completedAt: foundAt,
            error: undefined,
          });
          updated += 1;
        }

        continue;
      }

      if (dbTrack.status === TrackStatusEnum.Completed) {
        await this.trackRepository.delete(dbTrack.id);
        removed += 1;
      }
    }

    for (const [fullKey, scannedTrack] of scannedTrackMap) {
      const baseKey = this.buildBaseKey(scannedTrack.artist, scannedTrack.name);
      if (existingFullKeys.has(fullKey) || existingBaseKeys.has(baseKey)) {
        continue;
      }

      await this.trackRepository.save({
        artist: scannedTrack.artist,
        name: scannedTrack.name,
        album: scannedTrack.album,
        trackNumber: scannedTrack.trackNumber,
        durationMs: scannedTrack.durationMs,
        status: TrackStatusEnum.Completed,
        completedAt: foundAt,
      });

      existingFullKeys.add(fullKey);
      existingBaseKeys.add(baseKey);
      imported += 1;
    }

    return { matched, updated, imported, removed };
  }

  private buildBaseKey(artist: string, title: string): string {
    return `${this.normalizeMeta(artist)}|${this.normalizeMeta(title)}`;
  }

  private buildFullKey(artist: string, title: string, album: string): string {
    return `${this.normalizeMeta(artist)}|${this.normalizeMeta(title)}|${this.normalizeMeta(album)}`;
  }

  private normalizeMeta(value: string): string {
    return (value || "").trim().toLocaleLowerCase();
  }
}
