import { storedUsage, tokenFields, type AiUsage } from "./schema";

export type UsageProvider = "CHATGPT_APP" | "CODEX_LOCAL" | "UNKNOWN";
export type UsageTask = {
  id: string; kind: string; title: string; domain: string;
  provider: UsageProvider; model: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  usage: AiUsage | null;
};
type TokenTotals = Record<typeof tokenFields[number], number | null>;
export type AiUsageReport = {
  period: { days: number; start: string; end: string };
  scope: { siteId: string | null };
  quota: { available: false; manageUrl: string };
  summary: TokenTotals & { tasks: number; succeeded: number; failed: number; queued: number; running: number; withUsage: number; withoutUsage: number };
  providers: { provider: UsageProvider; tasks: number; withUsage: number; totalTokens: number | null }[];
  recent: UsageTask[];
};

function totals(tasks: UsageTask[]): TokenTotals {
  return Object.fromEntries(tokenFields.map(key => {
    const values = tasks.flatMap(task => task.usage?.[key] !== null && task.usage?.[key] !== undefined ? [task.usage[key] as number] : []);
    const sum = values.reduce((a, b) => a + b, 0);
    return [key, values.length && Number.isSafeInteger(sum) ? sum : null];
  })) as TokenTotals;
}

export function buildUsageReport(tasks: UsageTask[], days: number, siteId: string | null, now: Date): AiUsageReport {
  // Validate stored JSON again. Unknown/malformed records are not zero usage.
  const rows = tasks.map(task => {
    const usage = storedUsage(task.usage);
    const matches = usage && ((task.provider === "CHATGPT_APP" && usage.source === "CHATGPT_RESPONSE") || (task.provider === "CODEX_LOCAL" && usage.source === "CODEX_CLI"));
    return { ...task, usage: matches ? usage : null };
  });
  const withUsage = rows.filter(task => task.usage !== null).length;
  const providers: UsageProvider[] = ["CHATGPT_APP", "CODEX_LOCAL", "UNKNOWN"];
  return {
    period: { days, start: new Date(now.getTime() - days * 86400000).toISOString(), end: now.toISOString() },
    scope: { siteId },
    quota: { available: false, manageUrl: "https://chatgpt.com/settings/usage" },
    summary: { tasks: rows.length, succeeded: rows.filter(task => task.status === "SUCCEEDED").length,
      failed: rows.filter(task => task.status === "FAILED").length, queued: rows.filter(task => task.status === "QUEUED").length,
      running: rows.filter(task => task.status === "RUNNING").length, withUsage, withoutUsage: rows.length - withUsage, ...totals(rows) },
    providers: providers.map(provider => {
      const selected = rows.filter(task => task.provider === provider);
      return { provider, tasks: selected.length, withUsage: selected.filter(task => task.usage !== null).length, totalTokens: totals(selected).totalTokens };
    }).filter(group => group.tasks > 0),
    recent: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 20),
  };
}
