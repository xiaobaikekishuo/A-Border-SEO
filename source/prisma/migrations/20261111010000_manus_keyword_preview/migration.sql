CREATE TABLE "ManusKeywordPreview" (
  "taskId" TEXT PRIMARY KEY REFERENCES "ManusKeywordTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "source" TEXT NOT NULL CHECK ("source" IN ('upload', 'manus')),
  "filename" TEXT NOT NULL,
  "rows" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1
);
