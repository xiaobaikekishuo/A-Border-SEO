-- Background pool fillers (1.9.1): a daily limit for each kind of automatic
-- task instead of one for the whole site, which alerts lead to a diagnosis,
-- and each filler's last check so the owner can see what it found.
ALTER TABLE "AiAutomation"
  DROP COLUMN "dailyCap",
  ADD COLUMN "rankingsCap" INTEGER NOT NULL DEFAULT 2 CHECK ("rankingsCap" BETWEEN 1 AND 50),
  ADD COLUMN "alertsCap" INTEGER NOT NULL DEFAULT 2 CHECK ("alertsCap" BETWEEN 1 AND 50),
  ADD COLUMN "metaCap" INTEGER NOT NULL DEFAULT 1 CHECK ("metaCap" BETWEEN 1 AND 50),
  ADD COLUMN "schemaCap" INTEGER NOT NULL DEFAULT 10 CHECK ("schemaCap" BETWEEN 1 AND 50),
  ADD COLUMN "clustersCap" INTEGER NOT NULL DEFAULT 1 CHECK ("clustersCap" BETWEEN 1 AND 50),
  ADD COLUMN "briefsCap" INTEGER NOT NULL DEFAULT 5 CHECK ("briefsCap" BETWEEN 1 AND 50),
  ADD COLUMN "alertsScope" TEXT NOT NULL DEFAULT 'drops' CHECK ("alertsScope" IN ('drops', 'all')),
  ADD COLUMN "status" JSONB NOT NULL DEFAULT '{}';
