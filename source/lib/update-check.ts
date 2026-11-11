import { request } from "node:https";
import { APP_VERSION } from "@/lib/version";

/**
 * Optional update check. It is off unless UPDATE_CHECK_REPO names the GitHub
 * repository ("owner/name") that publishes this deployment's releases. Once a
 * day the server then asks the GitHub releases API for that repository's
 * latest release, and the sidebar footer says when it is newer than this
 * version.
 *
 * The request carries only a User-Agent header ("a-border-seo/<version>"): no
 * instance id, no cookies, no data about the user. UPDATE_CHECK=false turns it
 * off even when a repository is set. It never blocks rendering: a page reads
 * the last result and, when that is older than a day, starts a new check in
 * the background. Any failure (offline, timeout, rate limit, odd response)
 * just means nothing is shown.
 */

const API_BASE = "https://api.github.com/repos/";
const RELEASES_BASE = "https://github.com/";
const TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Up to an hour on top of the day, so instances started together do not all ask at once. */
const MAX_JITTER_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
/** GitHub owner and repository names: letters, digits, "-", "_" and "." (not "." or ".."). */
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/((?!\.\.?$)[A-Za-z0-9._-]{1,100})$/;

export type AvailableUpdate = { version: string; url: string };
type Env = Record<string, string | undefined>;

/** GETs a URL with exactly these headers and resolves with the status and body. */
export type HttpGet = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<{ status: number; body: string }>;

/** The configured "owner/name", or null when none (or an invalid one) is set. */
export function updateRepository(env: Env = process.env): string | null {
  const value = env.UPDATE_CHECK_REPO?.trim() ?? "";
  return REPO.test(value) ? value : null;
}

export function updateCheckEnabled(env: Env = process.env): boolean {
  return env.UPDATE_CHECK?.trim().toLowerCase() !== "false" && updateRepository(env) !== null;
}

export function latestReleaseUrl(repository: string): string {
  return `${API_BASE}${repository}/releases/latest`;
}

/** "1.2.3" or "v1.2.3" to [1, 2, 3]; anything else (pre-releases included) is null. */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: [number, number, number], current: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

/** The newer release from a releases/latest response body, or null. */
export function newerRelease(body: string, currentVersion: string, repository: string): AvailableUpdate | null {
  const current = parseVersion(currentVersion);
  if (!current) return null;
  let tag: unknown;
  try {
    tag = (JSON.parse(body) as { tag_name?: unknown } | null)?.tag_name;
  } catch {
    return null;
  }
  const latest = parseVersion(tag);
  if (!latest || !isNewer(latest, current)) return null;
  const version = latest.join(".");
  // The link is built from the configured repository, never taken from the response.
  return { version, url: `${RELEASES_BASE}${repository}/releases/tag/${encodeURIComponent(String(tag).trim())}` };
}

/** node:https GET, so no header is added beyond the ones given (fetch adds its own). */
export const httpsGet: HttpGet = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error("Response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", reject);
    });
    // The whole request, connect to last byte, has timeoutMs.
    const timer = setTimeout(() => req.destroy(new Error("Timed out")), timeoutMs);
    timer.unref();
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });

/** One check. Never throws: a failure is null. */
export async function checkForUpdate(
  repository: string,
  get: HttpGet = httpsGet,
  currentVersion: string = APP_VERSION
): Promise<AvailableUpdate | null> {
  try {
    const res = await get(latestReleaseUrl(repository), { "User-Agent": `a-border-seo/${currentVersion}` }, TIMEOUT_MS);
    if (res.status !== 200) return null;
    return newerRelease(res.body, currentVersion, repository);
  } catch {
    return null;
  }
}

type State = { result: AvailableUpdate | null; nextCheckAt: number; running: Promise<void> | null };

/** The cache for one server process. */
export function createUpdateChecker({
  get = httpsGet,
  currentVersion = APP_VERSION,
  env = process.env,
  now = Date.now,
  random = Math.random,
}: {
  get?: HttpGet;
  currentVersion?: string;
  env?: Env;
  now?: () => number;
  random?: () => number;
} = {}) {
  const state: State = { result: null, nextCheckAt: 0, running: null };

  return {
    /**
     * The last known newer release, or null. Starts a background check when
     * the last one is a day (plus jitter) old; never waits for it.
     */
    current(): AvailableUpdate | null {
      const repository = updateRepository(env);
      if (!repository || !updateCheckEnabled(env)) return null;
      if (!state.running && now() >= state.nextCheckAt) {
        state.running = checkForUpdate(repository, get, currentVersion).then((result) => {
          state.result = result;
          state.nextCheckAt = now() + DAY_MS + Math.floor(random() * MAX_JITTER_MS);
          state.running = null;
        });
      }
      return state.result;
    },
    /** For tests: the check started by current(), if any. */
    settled(): Promise<void> {
      return state.running ?? Promise.resolve();
    },
  };
}

const globalForUpdate = globalThis as unknown as { aborderUpdateChecker?: ReturnType<typeof createUpdateChecker> };

/** The process-wide checker (kept on globalThis so dev reloads do not ask again). */
export function availableUpdate(): AvailableUpdate | null {
  globalForUpdate.aborderUpdateChecker ??= createUpdateChecker();
  return globalForUpdate.aborderUpdateChecker.current();
}
