CREATE TABLE "DesktopLoginChallenge" (
    "id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesktopLoginChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DesktopLoginChallenge_expiresAt_idx" ON "DesktopLoginChallenge"("expiresAt");

CREATE TABLE "DesktopOAuthAttempt" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" TEXT NOT NULL,
    "siteId" TEXT,
    "report" JSONB,
    "code" TEXT,

    CONSTRAINT "DesktopOAuthAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DesktopOAuthAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DesktopOAuthAttempt_expiresAt_idx" ON "DesktopOAuthAttempt"("expiresAt");
CREATE INDEX "DesktopOAuthAttempt_userId_idx" ON "DesktopOAuthAttempt"("userId");
