import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

// Production route bundles can load this module separately. Share one pool per
// process there too, rather than opening another pool for each bundle.
globalForPrisma.prisma = db;
