CREATE TABLE "ManagedIdentity" (
    "issuer" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagedIdentity_pkey" PRIMARY KEY ("issuer", "productId", "accountId")
);
CREATE UNIQUE INDEX "ManagedIdentity_userId_key" ON "ManagedIdentity"("userId");
ALTER TABLE "ManagedIdentity" ADD CONSTRAINT "ManagedIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD COLUMN "managedNonceHash" TEXT;
ALTER TABLE "Session" ADD COLUMN "managedInstallationId" TEXT;
