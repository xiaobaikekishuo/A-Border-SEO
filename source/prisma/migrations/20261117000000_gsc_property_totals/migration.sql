-- Existing days retain their original page-detail provenance until the next GSC sync.
ALTER TABLE "GscSyncCoverage"
  ADD COLUMN "propertyChecked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "propertyClicks" INTEGER,
  ADD COLUMN "propertyImpressions" INTEGER,
  ADD COLUMN "propertyPosition" DOUBLE PRECISION;
