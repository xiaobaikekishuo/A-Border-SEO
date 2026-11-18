import { db } from "@/lib/db";
import { googleFetch } from "./google-fetch";
import { openGoogleTokens, sealGoogleTokens } from "@/lib/google/token-store";
import type { Prisma } from "@prisma/client";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class ReauthRequiredError extends Error {
  constructor() {
    super("Your Google connection has expired. Please reconnect your account.");
    this.name = "ReauthRequiredError";
  }
}

/**
 * Refreshes Google OAuth tokens if expired.
 * Throws ReauthRequiredError when the refresh token itself is invalid/expired.
 */
async function refreshAccessToken(
  refreshToken: string
): Promise<{
  accessToken: string;
  expiresAt: number;
}> {
  const response = await googleFetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (body.includes("invalid_grant")) {
      throw new ReauthRequiredError();
    }
    throw new Error(
      `Failed to refresh token: ${response.status} ${response.statusText}${
        body ? `: ${body.slice(0, 500)}` : ""
      }`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Gets a valid access token for a user, refreshing if necessary
 */
export async function getAccessToken(userId: string): Promise<string> {
  return getCurrentAccessToken(userId, 2);
}

async function getCurrentAccessToken(userId: string, retries: number): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { googleTokens: true, updatedAt: true },
  });

  // Decrypted here; a legacy plain-text row is read as is. Tokens that no
  // longer decrypt (NEXTAUTH_SECRET changed) need a new sign-in.
  let tokens;
  try {
    tokens = openGoogleTokens(user?.googleTokens);
  } catch {
    throw new ReauthRequiredError();
  }
  if (!tokens) {
    throw new ReauthRequiredError();
  }

  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new ReauthRequiredError();
  }

  if (!tokens.expiresAt || tokens.expiresAt - Date.now() < 5 * 60 * 1000) {
    let refreshed;
    try { refreshed = await refreshAccessToken(tokens.refreshToken); }
    catch (error) {
      // A failed old grant should not hide a connection established while its
      // refresh was in flight. Re-read only when that snapshot really changed.
      const current = await db.user.findUnique({ where: { id: userId }, select: { googleTokens: true, updatedAt: true } });
      if (retries > 0 && current && (current.updatedAt.getTime() !== user!.updatedAt.getTime()
        || JSON.stringify(current.googleTokens) !== JSON.stringify(user!.googleTokens))) {
        return getCurrentAccessToken(userId, retries - 1);
      }
      throw error;
    }
    const { accessToken, expiresAt } = refreshed;

    const saved = await db.user.updateMany({
      where: { id: userId, updatedAt: user!.updatedAt,
        googleTokens: { equals: user!.googleTokens as Prisma.InputJsonValue } },
      data: {
        // Written encrypted, which also re-encrypts a legacy plain-text row.
        googleTokens: sealGoogleTokens({
          ...tokens,
          accessToken,
          expiresAt,
        }),
      },
    });
    if (saved.count === 1) return accessToken;
    // A concurrent connection, disconnect, deletion or winning refresh owns
    // the row now. Never resurrect or overwrite the earlier token snapshot.
    if (retries > 0) return getCurrentAccessToken(userId, retries - 1);
    throw new Error("Google connection changed. Retry the request.");
  }

  return tokens.accessToken;
}
