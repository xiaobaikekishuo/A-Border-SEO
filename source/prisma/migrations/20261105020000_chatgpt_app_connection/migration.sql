CREATE TABLE "ChatGptHost" ("id" TEXT NOT NULL, "hostId" TEXT NOT NULL, CONSTRAINT "ChatGptHost_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ChatGptHost_hostId_key" ON "ChatGptHost"("hostId");
CREATE TABLE "ChatGptProfile" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "clientId" TEXT, "subject" TEXT, "email" TEXT,
  "encryptedTokens" TEXT, "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[], "expiresAt" TIMESTAMP(3),
  "selected" BOOLEAN NOT NULL DEFAULT false, "epoch" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatGptProfile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChatGptProfile_userId_createdAt_idx" ON "ChatGptProfile"("userId", "createdAt");
ALTER TABLE "ChatGptProfile" ADD CONSTRAINT "ChatGptProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "ChatGptLoginAttempt" (
  "stateHash" TEXT NOT NULL, "userId" TEXT NOT NULL, "profileId" TEXT NOT NULL, "epoch" INTEGER NOT NULL,
  "encryptedPending" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "returnPath" TEXT NOT NULL,
  CONSTRAINT "ChatGptLoginAttempt_pkey" PRIMARY KEY ("stateHash")
);
CREATE INDEX "ChatGptLoginAttempt_expiresAt_idx" ON "ChatGptLoginAttempt"("expiresAt");
ALTER TABLE "ChatGptLoginAttempt" ADD CONSTRAINT "ChatGptLoginAttempt_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ChatGptProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "ChatGptInference" ("jobId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ChatGptInference_pkey" PRIMARY KEY ("jobId"));
ALTER TABLE "ChatGptInference" ADD CONSTRAINT "ChatGptInference_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiWorkbenchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
