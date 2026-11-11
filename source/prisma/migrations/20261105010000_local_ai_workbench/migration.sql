BEGIN;
CREATE TABLE "AiWorkbenchJob" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "ContentJobStatus" NOT NULL DEFAULT 'QUEUED',
  "request" JSONB NOT NULL,
  "context" JSONB NOT NULL,
  "result" JSONB,
  "draftText" TEXT,
  "error" TEXT,
  "activeKey" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "AiWorkbenchJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiWorkbenchJob_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AiWorkbenchJob_activeKey_key" ON "AiWorkbenchJob"("activeKey");
CREATE INDEX "AiWorkbenchJob_siteId_createdAt_idx" ON "AiWorkbenchJob"("siteId", "createdAt");
CREATE INDEX "AiWorkbenchJob_status_createdAt_idx" ON "AiWorkbenchJob"("status", "createdAt");
COMMIT;
