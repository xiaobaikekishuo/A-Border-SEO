CREATE TABLE "ManusKeywordTask" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "siteId" TEXT NOT NULL REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('submitting','unknown','pending','running','waiting','completed','failed')),
  "remoteId" TEXT,
  "taskUrl" TEXT,
  "result" TEXT,
  "files" JSONB NOT NULL DEFAULT '[]',
  "errorCode" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ManusKeywordTask_userId_siteId_requestId_key" ON "ManusKeywordTask"("userId","siteId","requestId");
CREATE INDEX "ManusKeywordTask_userId_siteId_createdAt_id_idx" ON "ManusKeywordTask"("userId","siteId","createdAt","id");
