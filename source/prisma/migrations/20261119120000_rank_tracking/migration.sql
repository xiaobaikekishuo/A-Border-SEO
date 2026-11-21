-- Rank tracking: the measured Google position of the saved keywords marked
-- for tracking, checked through DataForSEO's standard queue (lib/rank-tracking).
-- A run posts one task per keyword; later jobs collect the results.
ALTER TYPE "AlertType" ADD VALUE 'RANK_DROP';

ALTER TABLE "SavedKeyword" ADD COLUMN "tracked" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "RankTracking" (
  "siteId" TEXT NOT NULL,
  "device" TEXT NOT NULL DEFAULT 'desktop' CHECK ("device" IN ('desktop', 'mobile')),
  "depth" INTEGER NOT NULL DEFAULT 30 CHECK ("depth" BETWEEN 10 AND 100),
  "aiOverview" BOOLEAN NOT NULL DEFAULT false,
  "scheduleDays" INTEGER CHECK ("scheduleDays" IS NULL OR "scheduleDays" BETWEEN 1 AND 90),
  "budgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK ("budgetUsd" > 0 AND "budgetUsd" <= 100),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RankTracking_pkey" PRIMARY KEY ("siteId"),
  CONSTRAINT "RankTracking_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RankRun" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "jobId" TEXT,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('POSTING', 'WAITING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  "device" TEXT NOT NULL,
  "depth" INTEGER NOT NULL,
  "aiOverview" BOOLEAN NOT NULL DEFAULT false,
  "language" TEXT NOT NULL,
  "location" INTEGER NOT NULL,
  "planned" INTEGER NOT NULL,
  "done" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "budgetUsd" DOUBLE PRECISION NOT NULL,
  "error" TEXT,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "RankRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RankRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RankRun_jobId_key" ON "RankRun"("jobId");
CREATE INDEX "RankRun_siteId_startedAt_idx" ON "RankRun"("siteId", "startedAt");

CREATE TABLE "RankCheck" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "remoteId" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('QUEUED', 'PENDING', 'OK', 'FAILED')),
  "position" INTEGER CHECK ("position" IS NULL OR "position" > 0),
  "absolute" INTEGER CHECK ("absolute" IS NULL OR "absolute" > 0),
  "url" TEXT CHECK ("url" IS NULL OR char_length("url") <= 2048),
  "aiOverview" BOOLEAN,
  "aiCited" BOOLEAN,
  "features" TEXT[],
  "top" JSONB NOT NULL DEFAULT '[]',
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT CHECK ("error" IS NULL OR char_length("error") <= 300),
  "checkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RankCheck_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RankCheck_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RankRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RankCheck_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RankCheck_runId_keyword_key" ON "RankCheck"("runId", "keyword");
CREATE INDEX "RankCheck_siteId_keyword_createdAt_idx" ON "RankCheck"("siteId", "keyword", "createdAt");
CREATE INDEX "RankCheck_remoteId_idx" ON "RankCheck"("remoteId");
