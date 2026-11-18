import type { PrismaClient } from "@prisma/client";
import { managedUserScope } from "./identity";

/** Queues retained from a previous local user must never run as the new user. */
export async function managedSiteAllows(db: Pick<PrismaClient, "managedIdentity" | "site">, siteId: string): Promise<boolean> {
  const scope = await managedUserScope(db);
  if (!scope.managed) return true;
  if (!scope.userId) return false;
  return Boolean(await db.site.findFirst({ where: { id: siteId, userId: scope.userId }, select: { id: true } }));
}
