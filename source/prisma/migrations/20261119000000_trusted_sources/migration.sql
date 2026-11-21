-- Trusted sources: external pages an AI draft of the site may cite. Links in a
-- draft outside the site's verified pages and these sources are replaced by a
-- marker and listed for the owner instead of failing the task.
CREATE TABLE "TrustedSource" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "url" TEXT NOT NULL CHECK ("url" ~ '^https?://' AND char_length("url") <= 2048),
  "title" TEXT CHECK (char_length("title") <= 200),
  "note" TEXT CHECK (char_length("note") <= 300),
  "checkedAt" TIMESTAMP(3),
  "lastStatus" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrustedSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrustedSource_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrustedSource_siteId_url_key" ON "TrustedSource"("siteId", "url");
CREATE INDEX "TrustedSource_siteId_createdAt_idx" ON "TrustedSource"("siteId", "createdAt");
