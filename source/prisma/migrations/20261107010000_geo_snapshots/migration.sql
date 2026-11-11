CREATE TABLE "GeoSnapshot" (
  "siteId" TEXT NOT NULL REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('GA4', 'BOT')),
  "report" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GeoSnapshot_pkey" PRIMARY KEY ("siteId", "kind")
);
