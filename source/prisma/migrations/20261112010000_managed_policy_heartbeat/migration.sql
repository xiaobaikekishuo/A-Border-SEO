ALTER TABLE "WorkerHeartbeat" ADD COLUMN "managedPolicy" TEXT;
ALTER TABLE "ContentPlanJob" ADD COLUMN "executionAuthorizedAt" TIMESTAMP(3);
ALTER TABLE "AiWorkbenchJob" ADD COLUMN "executionAuthorizedAt" TIMESTAMP(3);
