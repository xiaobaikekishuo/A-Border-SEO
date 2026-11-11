/*
 * The one place a custom deployment plugs its own code into the app. The app
 * itself registers nothing here and its updates never touch this file, so a
 * deployment that replaces its body keeps it across updates.
 *
 * registerExtensions runs once in every process that queues or runs jobs: the
 * Next.js server (instrumentation.ts, before the inline job loop starts), the
 * worker (worker/main.ts) and the MCP server (mcp/server.ts). Register here:
 * - job types: registerJobHandler (lib/jobs/handlers.ts)
 * - schedules: registerSchedule, registerScheduleFilter and
 *   registerSchedulerTask (lib/jobs/scheduler.ts)
 * - who may start a crawl: setCrawlPolicy (lib/jobs/policy.ts)
 * - who may add, change or delete a site: setSitePolicy (lib/site-policy.ts)
 *
 * Every registry lives on globalThis, so registering once per process covers
 * all routes, server actions and the job loop of that process.
 */

const holder = globalThis as unknown as { aborderExtensionsRegistered?: boolean };

/** Registers this deployment's extensions. Safe to call more than once. */
export function registerExtensions(): void {
  if (holder.aborderExtensionsRegistered) return;
  holder.aborderExtensionsRegistered = true;
  // Nothing to register by default.
}
