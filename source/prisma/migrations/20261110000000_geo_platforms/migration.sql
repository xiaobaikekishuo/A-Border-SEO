-- Robots-type meta tags and data-nosnippet, recorded by crawls from this release on.
ALTER TABLE "AuditPage" ADD COLUMN "robotsDirectives" JSONB;

-- New snapshot kinds: the live access check and the imported AI reports.
ALTER TABLE "GeoSnapshot" DROP CONSTRAINT "GeoSnapshot_kind_check";
ALTER TABLE "GeoSnapshot" ADD CONSTRAINT "GeoSnapshot_kind_check"
  CHECK ("kind" IN ('GA4', 'BOT', 'PROBE', 'GSC_AI', 'BING_AI'));

CREATE TABLE "GeoTracking" (
  "siteId" TEXT NOT NULL,
  "brands" JSONB NOT NULL,
  "platforms" TEXT[],
  "scheduleDays" INTEGER CHECK ("scheduleDays" IS NULL OR "scheduleDays" BETWEEN 1 AND 90),
  "budgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK ("budgetUsd" > 0 AND "budgetUsd" <= 100),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GeoTracking_pkey" PRIMARY KEY ("siteId"),
  CONSTRAINT "GeoTracking_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GeoPrompt" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "tag" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeoPrompt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GeoPrompt_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GeoPrompt_siteId_text_key" ON "GeoPrompt"("siteId", "text");

CREATE TABLE "GeoRun" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "jobId" TEXT,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  "plan" JSONB NOT NULL,
  "planned" INTEGER NOT NULL,
  "done" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "budgetUsd" DOUBLE PRECISION NOT NULL,
  "summary" JSONB,
  "error" TEXT,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "GeoRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GeoRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GeoRun_jobId_key" ON "GeoRun"("jobId");
CREATE INDEX "GeoRun_siteId_startedAt_idx" ON "GeoRun"("siteId", "startedAt");

CREATE TABLE "GeoAnswer" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "runId" TEXT,
  "promptId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "source" TEXT NOT NULL CHECK ("source" IN ('DATAFORSEO', 'MANUAL')),
  "status" TEXT NOT NULL CHECK ("status" IN ('OK', 'NO_ANSWER', 'FAILED')),
  "text" TEXT,
  "citations" JSONB NOT NULL,
  "meta" JSONB,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeoAnswer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GeoAnswer_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GeoAnswer_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GeoRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GeoAnswer_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "GeoPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GeoAnswer_runId_promptId_platform_key" ON "GeoAnswer"("runId", "promptId", "platform");
CREATE INDEX "GeoAnswer_siteId_createdAt_idx" ON "GeoAnswer"("siteId", "createdAt");
CREATE INDEX "GeoAnswer_promptId_platform_createdAt_idx" ON "GeoAnswer"("promptId", "platform", "createdAt");
