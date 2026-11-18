CREATE TABLE "HostedDevice" (
  "id" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionBinding" TEXT NOT NULL,
  "desktopVersion" TEXT NOT NULL,
  "codexLogin" BOOLEAN NOT NULL DEFAULT false,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HostedDevice_issuer_productId_installationId_key" ON "HostedDevice"("issuer", "productId", "installationId");
CREATE INDEX "HostedDevice_userId_idx" ON "HostedDevice"("userId");
ALTER TABLE "Session" ADD COLUMN "hostedDeviceId" TEXT;
ALTER TABLE "Session" ADD COLUMN "hostedBinding" TEXT;
ALTER TABLE "Job" ADD COLUMN "hostedDeviceId" TEXT;
ALTER TABLE "ContentPlanJob" ADD COLUMN "hostedDeviceId" TEXT;
ALTER TABLE "AiWorkbenchJob" ADD COLUMN "hostedDeviceId" TEXT;
