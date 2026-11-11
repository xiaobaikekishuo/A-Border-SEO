BEGIN;
ALTER TABLE "Site" ADD COLUMN "researchLanguage" TEXT NOT NULL DEFAULT 'en', ADD COLUMN "researchLocation" INTEGER NOT NULL DEFAULT 2840;
ALTER TABLE "AuditPage" ADD COLUMN "articleText" TEXT, ADD COLUMN "articleHeadings" JSONB;
ALTER TABLE "ContentCluster" ADD COLUMN "optimization" JSONB;
ALTER TABLE "ContentPlanJob" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PLAN', ADD COLUMN "request" JSONB;
CREATE TABLE "GscSyncCoverage" (
 "id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL, "date" TIMESTAMP(3) NOT NULL,
 "gscProperty" TEXT NOT NULL, "pagesComplete" BOOLEAN NOT NULL DEFAULT false,
 "queryPagesComplete" BOOLEAN NOT NULL DEFAULT false, "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "GscSyncCoverage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GscSyncCoverage_siteId_date_key" ON "GscSyncCoverage"("siteId","date");
CREATE INDEX "GscSyncCoverage_siteId_date_idx" ON "GscSyncCoverage"("siteId","date");
CREATE TABLE "QueryPage" (
 "id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL, "query" TEXT NOT NULL, "page" TEXT NOT NULL,
 "date" TIMESTAMP(3) NOT NULL, "clicks" INTEGER NOT NULL DEFAULT 0, "impressions" INTEGER NOT NULL DEFAULT 0,
 "ctr" DOUBLE PRECISION NOT NULL DEFAULT 0, "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
 CONSTRAINT "QueryPage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "QueryPage_siteId_query_page_date_key" ON "QueryPage"("siteId","query","page","date");
CREATE INDEX "QueryPage_siteId_date_idx" ON "QueryPage"("siteId","date");
COMMIT;
