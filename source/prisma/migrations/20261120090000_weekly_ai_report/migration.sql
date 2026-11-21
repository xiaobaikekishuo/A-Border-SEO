-- The weekly AI action list of a site (lib/ai-workbench/weekly-report.ts):
-- off by default, written by the owner's local Codex worker, sent through
-- the owner's alert email and webhook.
CREATE TABLE "AiReportSchedule" (
  "siteId" TEXT PRIMARY KEY REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "language" TEXT NOT NULL DEFAULT 'zh-CN' CHECK (char_length("language") BETWEEN 2 AND 10),
  "lastSlot" TIMESTAMP(3),
  "lastJobId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
