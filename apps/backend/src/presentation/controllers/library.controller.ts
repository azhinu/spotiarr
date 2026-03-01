import { Request, Response } from "express";
import { LibraryService } from "@/application/services/library.service";
import { logger } from "@/infrastructure/utils/logger";

export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  getStats = async (req: Request, res: Response) => {
    try {
      const stats = await this.libraryService.getStats();
      res.json({ data: stats });
    } catch (error) {
      logger.error("Error getting library stats:", error);
      res.status(500).json({
        error: "internal_server_error",
        message: error instanceof Error ? error.message : "Failed to get library stats",
      });
    }
  };

  getArtists = async (req: Request, res: Response) => {
    try {
      const artists = await this.libraryService.getArtists();
      res.json({ data: artists });
    } catch (error) {
      logger.error("Error getting artists:", error);
      res.status(500).json({
        error: "internal_server_error",
        message: error instanceof Error ? error.message : "Failed to get artists",
      });
    }
  };

  getArtist = async (req: Request, res: Response) => {
    try {
      const artistName = decodeURIComponent(req.params.name);
      const artist = await this.libraryService.getArtist(artistName);

      if (!artist) {
        res.status(404).json({
          error: "internal_server_error",
          message: "Artist not found",
        });
        return;
      }

      res.json({ data: artist });
    } catch (error) {
      logger.error("Error getting artist:", error);
      res.status(500).json({
        error: "internal_server_error",
        message: error instanceof Error ? error.message : "Failed to get artist",
      });
    }
  };

  getImage = async (req: Request, res: Response) => {
    try {
      const imagePath = req.query.path as string;

      if (!imagePath) {
        res.status(400).json({
          error: "invalid_request",
          message: "Image path is required",
        });
        return;
      }

      res.sendFile(imagePath, (err) => {
        if (err) {
          logger.error(`Error sending file ${imagePath}:`, err);
          if (!res.headersSent) {
            res.status(404).json({
              error: "file_not_found",
              message: "File not found",
            });
          }
        }
      });
    } catch (error) {
      logger.error("Error serving image:", error);
      res.status(500).json({
        error: "internal_server_error",
        message: error instanceof Error ? error.message : "Failed to serve image",
      });
    }
  };

  scan = async (req: Request, res: Response) => {
    try {
      const result = await this.libraryService.scan();
      res.json({ data: result });
    } catch (error) {
      logger.error("Error scanning library:", error);
      res.status(500).json({
        error: "internal_server_error",
        message: error instanceof Error ? error.message : "Failed to scan library",
      });
    }
  };
}
