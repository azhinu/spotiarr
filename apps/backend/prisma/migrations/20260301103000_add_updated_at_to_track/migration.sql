ALTER TABLE "Track" ADD COLUMN "updatedAt" BIGINT NOT NULL DEFAULT 0;

UPDATE "Track"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" = 0;
