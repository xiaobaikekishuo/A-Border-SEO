import { existsSync } from "node:fs";

/** The desktop controller mounts this directory read-only in the app and worker. */
export function desktopMaintenanceActive(): boolean {
  const marker = process.env.ABORDER_DESKTOP_MAINTENANCE_FILE;
  return Boolean(marker && existsSync(marker));
}
