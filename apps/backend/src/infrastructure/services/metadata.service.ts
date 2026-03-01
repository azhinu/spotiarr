import { execFile } from "child_process";
import * as fs from "fs";
import * as NodeID3 from "node-id3";
import { join } from "path";
import { promisify } from "util";
import { AppError } from "@/domain/errors/app-error";
import { logger } from "@/infrastructure/utils/logger";
import { getErrorMessage } from "../utils/error.utils";

const execFilePromise = promisify(execFile);

export class MetadataService {
  async writeTags(
    filePath: string,
    fileTags: {
      title: string;
      artist: string;
      album?: string;
      albumYear?: number;
      trackNumber?: number;
      discNumber?: number;
      totalTracks?: number;
      coverUrl?: string; // Optional: download and embed if present
    },
  ): Promise<void> {
    const fileExtension = filePath.split(".").pop()?.toLowerCase();

    logger.log(`[MetadataService] Writing tags to ${fileExtension} file: ${filePath}`);

    // For MP3 files, use node-id3 (more reliable for MP3)
    if (fileExtension === "mp3") {
      logger.log(`[MetadataService] Using node-id3 for MP3 format`);
      await this.writeTagsWithNodeID3(filePath, fileTags);
    } else {
      // For all other formats (opus, flac, m4a, ogg, etc.), use ffmpeg
      logger.log(`[MetadataService] Using ffmpeg for ${fileExtension} format`);
      await this.writeTagsWithFFmpeg(filePath, fileTags);
    }
  }

  private async writeTagsWithNodeID3(
    filePath: string,
    fileTags: {
      title: string;
      artist: string;
      album?: string;
      albumYear?: number;
      trackNumber?: number;
      discNumber?: number;
      totalTracks?: number;
      coverUrl?: string;
    },
  ): Promise<void> {
    const { title, artist, album, albumYear, trackNumber, discNumber, totalTracks, coverUrl } =
      fileTags;

    const tags: NodeID3.Tags = {
      title,
      artist,
      performerInfo: artist, // Album Artist - crucial for Jellyfin grouping
    };

    if (album) {
      tags.album = album;
    }

    if (albumYear) {
      tags.year = albumYear.toString();
    }

    if (trackNumber) {
      tags.trackNumber = totalTracks ? `${trackNumber}/${totalTracks}` : trackNumber.toString();
    }

    if (discNumber) {
      tags.partOfSet = discNumber.toString();
    }

    if (coverUrl) {
      try {
        const res = await fetch(coverUrl);
        const arrayBuf = await res.arrayBuffer();
        const imageBuffer = Buffer.from(arrayBuf);

        tags.image = {
          mime: "image/jpeg",
          type: { id: 3, name: "front cover" }, // Cover (front)
          description: "cover",
          imageBuffer,
        };
      } catch (error) {
        logger.warn(`Failed to download cover for embedding: ${getErrorMessage(error)}`);
      }
    }

    const success = NodeID3.write(tags, filePath);
    if (!success) {
      logger.warn(`NodeID3.write returned false for ${filePath}`);
    }
  }

  private async writeTagsWithFFmpeg(
    filePath: string,
    fileTags: {
      title: string;
      artist: string;
      album?: string;
      albumYear?: number;
      trackNumber?: number;
      discNumber?: number;
      totalTracks?: number;
      coverUrl?: string;
    },
  ): Promise<void> {
    const { title, artist, album, albumYear, trackNumber, discNumber, totalTracks, coverUrl } =
      fileTags;

    try {
      const tempFilePath = `${filePath}.tmp.${filePath.split(".").pop()}`;
      const fileExtension = filePath.split(".").pop()?.toLowerCase();
      const ffmpegArgs: string[] = ["-i", filePath, "-c", "copy"];

      // Add metadata tags
      ffmpegArgs.push("-metadata", `title=${title}`);
      ffmpegArgs.push("-metadata", `artist=${artist}`);
      ffmpegArgs.push("-metadata", `album_artist=${artist}`); // Important for Jellyfin

      if (album) {
        ffmpegArgs.push("-metadata", `album=${album}`);
      }

      if (albumYear) {
        ffmpegArgs.push("-metadata", `date=${albumYear}`);
        ffmpegArgs.push("-metadata", `year=${albumYear}`);
      }

      if (trackNumber) {
        ffmpegArgs.push("-metadata", `track=${trackNumber}${totalTracks ? `/${totalTracks}` : ""}`);
      }

      if (discNumber) {
        ffmpegArgs.push("-metadata", `disc=${discNumber}`);
      }

      // Handle cover art for formats that support embedded images (not Opus/Ogg)
      let coverImagePath: string | null = null;
      if (coverUrl && fileExtension !== "opus" && fileExtension !== "ogg") {
        try {
          const res = await fetch(coverUrl);
          const arrayBuf = await res.arrayBuffer();
          const imageBuffer = Buffer.from(arrayBuf);

          // Save cover temporarily
          coverImagePath = `${filePath}.cover.jpg`;
          fs.writeFileSync(coverImagePath, imageBuffer);

          // Add cover art input
          ffmpegArgs.push("-i", coverImagePath);
          ffmpegArgs.push("-map", "0:a");
          ffmpegArgs.push("-map", "1:0");
          ffmpegArgs.push("-metadata:s:v", "title=Album cover");
          ffmpegArgs.push("-metadata:s:v", "comment=Cover (front)");
          ffmpegArgs.push("-disposition:v:0", "attached_pic");
        } catch (error) {
          logger.warn(`Failed to download cover for embedding: ${getErrorMessage(error)}`);
        }
      }

      // Output file
      ffmpegArgs.push("-y", tempFilePath);

      logger.debug(`[MetadataService] Running ffmpeg with args: ffmpeg ${ffmpegArgs.join(" ")}`);

      await execFilePromise("ffmpeg", ffmpegArgs);

      // Replace original file with tagged version
      fs.renameSync(tempFilePath, filePath);

      // Clean up cover image if it was created
      if (coverImagePath && fs.existsSync(coverImagePath)) {
        fs.unlinkSync(coverImagePath);
      }

      logger.log(`[MetadataService] ✓ Successfully wrote tags using ffmpeg to ${filePath}`);
    } catch (error) {
      logger.error(
        `[MetadataService] Failed to write tags with ffmpeg for ${filePath}:`,
        getErrorMessage(error),
      );

      // Clean up temp files on error
      const tempFilePath = `${filePath}.tmp.${filePath.split(".").pop()}`;
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      const coverImagePath = `${filePath}.cover.jpg`;
      if (fs.existsSync(coverImagePath)) {
        fs.unlinkSync(coverImagePath);
      }

      throw new AppError(
        500,
        "internal_server_error",
        `Failed to write metadata with ffmpeg: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Saves cover art in the specified directory for Jellyfin detection
   * Jellyfin looks for: cover.jpg
   * Downloads the image only if it doesn't exist yet
   */
  async saveCoverArt(
    directory: string,
    coverUrl: string,
    fileName: string = "cover.jpg",
  ): Promise<void> {
    if (!coverUrl) {
      return;
    }

    try {
      const coverFile = join(directory, fileName);

      // Only download if the file doesn't exist
      if (fs.existsSync(coverFile)) {
        logger.debug(`Cover art already exists in ${directory}`);
        return;
      }

      // Download the image
      logger.debug(`Downloading cover art to ${directory}`);
      const response = await fetch(coverUrl);

      if (!response.ok) {
        throw new AppError(
          500,
          "internal_server_error",
          `Failed to download cover: ${response.statusText}`,
        );
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());

      // Save file
      fs.writeFileSync(coverFile, imageBuffer);

      logger.debug(`✓ Cover art saved: ${coverFile}`);
    } catch (error) {
      logger.warn(`Failed to save cover art in ${directory}: ${getErrorMessage(error)}`);
    }
  }
}
