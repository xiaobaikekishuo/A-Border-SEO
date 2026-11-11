import type { PrismaClient } from "@prisma/client";
import { isServerless, queueConfig, workerMode } from "./config";
import { JobLoop } from "./loop";
import { JobRunner } from "./runner";
import { scheduleOnMaintenance } from "./scheduler";

/*
 * WORKER_MODE=inline on a long-running server: the app process runs the job
 * loop itself, as crawls ran in the app before the queue existed. One loop per
 * process, on globalThis so a second copy of this module finds it.
 */

const holder = globalThis as unknown as { aborderInlineJobLoop?: JobLoop };

export function inlineJobLoop(): JobLoop | undefined {
  return holder.aborderInlineJobLoop;
}

/** Starts the inline loop when this process should run one. Returns it, or null. */
export function startInlineJobLoop(db: PrismaClient): JobLoop | null {
  if (workerMode() !== "inline" || isServerless()) return null;
  if (holder.aborderInlineJobLoop) return holder.aborderInlineJobLoop;
  const config = queueConfig();
  const loop = new JobLoop(db, new JobRunner(db), {
    mode: "inline",
    ...config,
    onMaintenance: scheduleOnMaintenance(db),
  });
  holder.aborderInlineJobLoop = loop;
  loop.start();
  return loop;
}
