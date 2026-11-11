CREATE TYPE "ContentFunnel" AS ENUM ('TOFU', 'MOFU', 'BOFU');
CREATE TYPE "ContentStatus" AS ENUM ('PLANNED', 'BRIEF_READY', 'WRITING', 'REVIEW', 'PUBLISHED');
CREATE TYPE "ContentSource" AS ENUM ('MANUAL', 'AI', 'EXAMPLE');
CREATE TYPE "ContentJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "ContentPillar" (
  "id" TEXT NOT NULL, "siteId" TEXT NOT NULL, "title" TEXT NOT NULL, "keyword" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '', "audience" TEXT NOT NULL DEFAULT '', "goal" TEXT NOT NULL DEFAULT '',
  "url" TEXT, "source" "ContentSource" NOT NULL DEFAULT 'MANUAL', "seedKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentPillar_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentPillar_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ContentPillar_siteId_seedKey_key" ON "ContentPillar"("siteId", "seedKey");
CREATE INDEX "ContentPillar_siteId_createdAt_idx" ON "ContentPillar"("siteId", "createdAt");

CREATE TABLE "ContentCluster" (
  "id" TEXT NOT NULL, "siteId" TEXT NOT NULL, "pillarId" TEXT NOT NULL, "title" TEXT NOT NULL,
  "keyword" TEXT NOT NULL, "dedupeKey" TEXT NOT NULL, "funnel" "ContentFunnel" NOT NULL,
  "intent" TEXT NOT NULL DEFAULT '', "contentType" TEXT NOT NULL DEFAULT 'Guide',
  "status" "ContentStatus" NOT NULL DEFAULT 'PLANNED', "url" TEXT, "scheduledFor" TIMESTAMP(3), "brief" JSONB,
  "source" "ContentSource" NOT NULL DEFAULT 'MANUAL', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentCluster_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentCluster_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ContentCluster_pillarId_fkey" FOREIGN KEY ("pillarId") REFERENCES "ContentPillar"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ContentCluster_pillarId_dedupeKey_key" ON "ContentCluster"("pillarId", "dedupeKey");
CREATE INDEX "ContentCluster_siteId_status_idx" ON "ContentCluster"("siteId", "status");

CREATE TABLE "ContentPlanJob" (
  "id" TEXT NOT NULL, "siteId" TEXT NOT NULL, "pillarId" TEXT NOT NULL,
  "status" "ContentJobStatus" NOT NULL DEFAULT 'QUEUED', "topicCount" INTEGER NOT NULL DEFAULT 9,
  "result" JSONB, "context" JSONB, "error" TEXT, "activeKey" TEXT, "appliedAt" TIMESTAMP(3), "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  CONSTRAINT "ContentPlanJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentPlanJob_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ContentPlanJob_pillarId_fkey" FOREIGN KEY ("pillarId") REFERENCES "ContentPillar"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ContentPlanJob_activeKey_key" ON "ContentPlanJob"("activeKey");
CREATE INDEX "ContentPlanJob_siteId_createdAt_idx" ON "ContentPlanJob"("siteId", "createdAt");
CREATE INDEX "ContentPlanJob_status_createdAt_idx" ON "ContentPlanJob"("status", "createdAt");
CREATE TABLE "ContentWorkerState" (
  "id" TEXT NOT NULL, "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentWorkerState_pkey" PRIMARY KEY ("id")
);
