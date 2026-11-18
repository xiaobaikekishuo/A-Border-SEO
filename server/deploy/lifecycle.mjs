import { insist, units } from "./common.mjs";

// Keep service selection in the same function used by deployment and recovery.
// In particular, an inactive worker must never briefly claim work on rollback.
export async function startReleaseServices(release, active = [true, true], dependencies) {
  insist(Array.isArray(active) && active.length === 2 && active.every(value => typeof value === "boolean"), "Invalid service recovery state.");
  const selected = units.filter((_, index) => active[index]);
  if (!selected.length) return;
  const manifest = dependencies.verifyRelease(release);
  await dependencies.resetFailed(selected);
  if (active[0]) {
    await dependencies.startUnit(units[0]);
    await dependencies.checkApp(manifest.version);
  }
  if (active[1]) {
    const since = Date.now();
    await dependencies.startUnit(units[1]);
    await dependencies.checkWorker(since);
  }
}

export async function restorePreviousRelease({ previous, active, environmentHash, beforeMigrations, migrationStarted,
  readEnvironmentHash, readMigrations, switchRelease, startRelease }) {
  if (!previous || !active.some(Boolean)) return false;
  try {
    if (readEnvironmentHash() !== environmentHash) return false;
    if (migrationStarted && JSON.stringify(readMigrations()) !== JSON.stringify(beforeMigrations)) return false;
    // Recheck after inspecting the database, immediately before changing the
    // program pointer. No saved credentials or changed environment are applied.
    if (readEnvironmentHash() !== environmentHash) return false;
  } catch { return false; }
  switchRelease(previous);
  await startRelease(previous, active);
  return true;
}
