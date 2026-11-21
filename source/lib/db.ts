import { PrismaClient } from "@prisma/client";
import { slowQueryLine, slowQueryThreshold } from "./db-log";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

function createClient(): PrismaClient {
  const levels: ("error" | "warn")[] = process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];
  const threshold = slowQueryThreshold();
  if (threshold === null) return new PrismaClient({ log: levels });
  // Opt-in, to find what makes a page slow: ABORDER_SLOW_QUERY_MS=200 logs every
  // database query that takes 200 ms or longer.
  const client = new PrismaClient({ log: [...levels.map((level) => ({ level, emit: "stdout" as const })), { level: "query" as const, emit: "event" as const }] });
  (client as unknown as { $on(event: "query", listener: (event: { duration: number; query: string }) => void): void })
    .$on("query", (event) => { if (event.duration >= threshold) console.warn(slowQueryLine(event)); });
  return client as unknown as PrismaClient;
}

export const db = globalForPrisma.prisma || createClient();

// Production route bundles can load this module separately. Share one pool per
// process there too, rather than opening another pool for each bundle.
globalForPrisma.prisma = db;
