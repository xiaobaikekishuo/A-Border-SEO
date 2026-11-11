-- Crawls saved before this release keep their score. NULL marks the legacy
-- per-finding deduction (100 minus 8/3/1); new crawls record "page-share-v1".
ALTER TABLE "Crawl" ADD COLUMN "healthScoreVersion" TEXT;
