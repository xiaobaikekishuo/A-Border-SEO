-- Background Codex work (lib/ai-workbench/pool): the worker's reading of its
-- Codex allowance, each user's pool settings, what fills a site's pool and
-- the pending work itself. Nothing runs until a user turns the pool on.
ALTER TABLE "ContentWorkerState"
  ADD COLUMN "limits" JSONB,
  ADD COLUMN "limitsAt" TIMESTAMP(3),
  ADD COLUMN "limitsError" TEXT,
  ADD COLUMN "models" JSONB,
  ADD COLUMN "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "AiPoolSetting" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "shortReserve" INTEGER NOT NULL DEFAULT 30 CHECK ("shortReserve" BETWEEN 10 AND 90),
  "weeklyReserve" INTEGER NOT NULL DEFAULT 10 CHECK ("weeklyReserve" BETWEEN 5 AND 50),
  "reviewCap" INTEGER NOT NULL DEFAULT 20 CHECK ("reviewCap" BETWEEN 5 AND 200),
  "language" TEXT NOT NULL DEFAULT 'zh-CN' CHECK (char_length("language") BETWEEN 2 AND 10),
  "lightModel" TEXT CHECK ("lightModel" IS NULL OR char_length("lightModel") BETWEEN 1 AND 100),
  "lightReasoning" TEXT DEFAULT 'low' CHECK ("lightReasoning" IS NULL OR "lightReasoning" IN ('minimal', 'low', 'medium', 'high', 'xhigh')),
  "mainModel" TEXT CHECK ("mainModel" IS NULL OR char_length("mainModel") BETWEEN 1 AND 100),
  "mainReasoning" TEXT DEFAULT 'medium' CHECK ("mainReasoning" IS NULL OR "mainReasoning" IN ('minimal', 'low', 'medium', 'high', 'xhigh')),
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AiAutomation" (
  "siteId" TEXT PRIMARY KEY REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "rankings" BOOLEAN NOT NULL DEFAULT false,
  "alerts" BOOLEAN NOT NULL DEFAULT false,
  "meta" BOOLEAN NOT NULL DEFAULT false,
  "schema" BOOLEAN NOT NULL DEFAULT false,
  "clusters" BOOLEAN NOT NULL DEFAULT false,
  "briefs" BOOLEAN NOT NULL DEFAULT false,
  "dailyCap" INTEGER NOT NULL DEFAULT 6 CHECK ("dailyCap" BETWEEN 1 AND 50),
  "markers" JSONB NOT NULL DEFAULT '{}',
  "filledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AiBacklogItem" (
  "id" TEXT PRIMARY KEY,
  "siteId" TEXT NOT NULL REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "source" TEXT NOT NULL CHECK ("source" IN ('RANKINGS', 'ALERTS', 'META', 'SCHEMA', 'CLUSTERS', 'BRIEF', 'BATCH')),
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "priority" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'STARTED', 'SKIPPED', 'CANCELED')),
  "jobId" TEXT REFERENCES "AiWorkbenchJob"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "reason" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "AiBacklogItem_jobId_key" ON "AiBacklogItem"("jobId");
CREATE UNIQUE INDEX "AiBacklogItem_siteId_dedupeKey_key" ON "AiBacklogItem"("siteId", "dedupeKey");
CREATE INDEX "AiBacklogItem_status_priority_createdAt_idx" ON "AiBacklogItem"("status", "priority", "createdAt");
CREATE INDEX "AiBacklogItem_siteId_createdAt_idx" ON "AiBacklogItem"("siteId", "createdAt");
