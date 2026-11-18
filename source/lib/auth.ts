import NextAuth from "next-auth";
import { customFetch } from "@auth/core";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "./db";
import { isSignInAllowed } from "./registration";
import { storeSignInTokens } from "./google/token-store";
import { syncGoogleProfile } from "./google/profile";
import { googleFetch } from "./google/google-fetch";
import { managedSessionAdapter } from "./desktop/managed-session";

// Skipped during `next build` so the Docker image can be built without real
// credentials.  NEXT_PHASE is set by Next.js; SKIP_ENV_VALIDATION is a manual
// escape hatch for other build toolchains.
const isBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.SKIP_ENV_VALIDATION === "1";
const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (!isBuild && process.env.ABORDER_HOSTED !== "1" && process.env.ABORDER_MANAGED !== "1" && !hasGoogle) {
  throw new Error("Missing Google OAuth credentials");
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: managedSessionAdapter(PrismaAdapter(db), db),
  providers: [
    ...(hasGoogle || isBuild ? [Google({
      [customFetch]: googleFetch,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      checks: ["pkce", "state"],
      authorization: {
        params: {
          scope: "openid email profile https://www.googleapis.com/auth/webmasters.readonly",
          access_type: "offline",
          prompt: "consent",
        },
      },
    })] : []),
  ],
  callbacks: {
    signIn({ account }) {
      if (process.env.ABORDER_HOSTED === "1") return false;
      return isSignInAllowed(account);
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      if (user?.email) {
        // The adapter stores name and picture only when it creates the user.
        try {
          await syncGoogleProfile(db, user.email, profile);
        } catch (error) {
          console.error("Failed to update the profile:", error);
        }
      }
      if (account?.access_token && user?.email) {
        // Save Google OAuth tokens (encrypted) after user is created by adapter
        try {
          await storeSignInTokens(db, user.email, account);
        } catch (error) {
          console.error("Failed to save Google tokens:", error);
        }
      }
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "database",
  },
  secret: process.env.NEXTAUTH_SECRET,
  ...(process.env.ABORDER_HOSTED === "1" ? { cookies: { sessionToken: { name: "__Secure-authjs.session-token", options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure: true } } } } : {}),
});
