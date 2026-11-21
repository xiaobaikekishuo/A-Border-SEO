-- Manus research templates besides keyword research (lib/manus/research.ts):
-- GEO citation sources and link prospects, with structured result rows.
CREATE TABLE "ManusResearchTask" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "siteId" TEXT NOT NULL REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('GEO_SOURCES','LINK_PROSPECTS')),
  "input" JSONB NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('submitting','unknown','pending','running','waiting','completed','failed')),
  "remoteId" TEXT,
  "taskUrl" TEXT,
  "summary" TEXT,
  "rows" JSONB NOT NULL DEFAULT '[]',
  "extracted" BOOLEAN,
  "errorCode" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ManusResearchTask_userId_siteId_requestId_key" ON "ManusResearchTask"("userId","siteId","requestId");
CREATE INDEX "ManusResearchTask_userId_siteId_kind_createdAt_id_idx" ON "ManusResearchTask"("userId","siteId","kind","createdAt","id");
