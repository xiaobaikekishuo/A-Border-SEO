-- hreflang findings of the crawl (lib/seo/hreflang.ts).
ALTER TYPE "IssueType" ADD VALUE 'HREFLANG';

-- GEO readiness evidence saved by crawls from this release on: links to
-- cited sources, app-shell detection and declared dates.
ALTER TABLE "AuditPage" ADD COLUMN "geoSignals" JSONB;

-- PageSpeed Insights: lab Total Blocking Time and Chrome UX Report field data
-- (p75 of the last 28 days). Lighthouse cannot measure INP; the field data can.
ALTER TABLE "VitalsReport"
  ADD COLUMN "tbt" DOUBLE PRECISION,
  ADD COLUMN "fieldSource" TEXT CHECK ("fieldSource" IS NULL OR "fieldSource" IN ('URL', 'ORIGIN')),
  ADD COLUMN "fieldLcp" DOUBLE PRECISION,
  ADD COLUMN "fieldInp" DOUBLE PRECISION,
  ADD COLUMN "fieldCls" DOUBLE PRECISION,
  ADD COLUMN "fieldCategory" TEXT;

-- Prompt tracking: several answers per prompt and platform in one run, the
-- brand fact card, and the reviewer's accuracy and sentiment labels.
ALTER TABLE "GeoTracking"
  ADD COLUMN "samples" INTEGER NOT NULL DEFAULT 1 CHECK ("samples" BETWEEN 1 AND 5),
  ADD COLUMN "facts" JSONB;

ALTER TABLE "GeoAnswer"
  ADD COLUMN "sample" INTEGER NOT NULL DEFAULT 0 CHECK ("sample" BETWEEN 0 AND 4),
  ADD COLUMN "review" JSONB;
-- Existing answers are sample 0, so they stay unique under the wider key.
DROP INDEX "GeoAnswer_runId_promptId_platform_key";
CREATE UNIQUE INDEX "GeoAnswer_runId_promptId_platform_sample_key" ON "GeoAnswer"("runId", "promptId", "platform", "sample");

-- IndexNow: the site's key and the result of the last submission.
CREATE TABLE "IndexNowState" (
  "siteId" TEXT NOT NULL,
  "key" TEXT NOT NULL CHECK ("key" ~ '^[A-Za-z0-9-]{8,128}$'),
  "verifiedAt" TIMESTAMP(3),
  "lastSubmittedAt" TIMESTAMP(3),
  "lastStatus" INTEGER,
  "lastCount" INTEGER,
  "lastMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IndexNowState_pkey" PRIMARY KEY ("siteId"),
  CONSTRAINT "IndexNowState_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
