-- Historical snapshots remain unknown. Only newly inspected HTML records a report.
ALTER TABLE "AuditPage" ADD COLUMN "schemaReport" JSONB;
