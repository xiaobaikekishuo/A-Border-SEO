import { MAX_CLAIM_CHARS } from "../tools/common";
import { MODEL_ID, REASONING_EFFORTS, type ReasoningEffort, type WorkerModel } from "./limits";

/*
 * Which model and reasoning effort a Codex task runs with. Tasks with a fixed
 * output shape (titles, emails, clusters, structured data, briefs, keyword
 * ideas) are "light": a lighter model gets many more of them out of the same
 * allowance. Articles, fix plans, reports and analyses are "main". The hint
 * goes only to workers that announced "routing-v1"; older workers keep their
 * own ABORDER_CODEX_MODEL and ABORDER_CODEX_REASONING.
 */

export const LIGHT_KINDS = ["META_REWRITE", "OUTREACH_EMAILS", "QUERY_CLUSTERS", "SCHEMA_MARKUP", "TOPIC_BRIEF", "KEYWORD_RESEARCH"] as const;
export type Tier = "light" | "main";
export function tierOf(kind: string): Tier {
  return (LIGHT_KINDS as readonly string[]).includes(kind) ? "light" : "main";
}

export type TierSetting = { model: string | null; reasoning: ReasoningEffort | null };
export type Routing = { light: TierSetting; main: TierSetting };
export const DEFAULT_ROUTING: Routing = { light: { model: null, reasoning: "low" }, main: { model: null, reasoning: "medium" } };

const isEffort = (value: unknown): value is ReasoningEffort => typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);

/** The stored settings of a user as routing; anything malformed falls back to the worker's own choice. */
export function routingFrom(row: { lightModel: string | null; lightReasoning: string | null; mainModel: string | null; mainReasoning: string | null } | null): Routing {
  if (!row) return DEFAULT_ROUTING;
  const tier = (model: string | null, reasoning: string | null): TierSetting => ({
    model: model && MODEL_ID.test(model) ? model : null, reasoning: isEffort(reasoning) ? reasoning : null,
  });
  return { light: tier(row.lightModel, row.lightReasoning), main: tier(row.mainModel, row.mainReasoning) };
}

export type RoutingHint = { model?: string; reasoning?: ReasoningEffort };

/**
 * The hint for a task: the tier's model when this Codex account still offers
 * it, and its reasoning effort when that model supports it. With no model
 * list (an older worker or a failed reading) the settings are sent as they
 * are, since they were chosen from the list the worker reported earlier.
 */
export function routingHint(kind: string, routing: Routing, models: WorkerModel[]): RoutingHint {
  const setting = routing[tierOf(kind)];
  const offered = models.length ? models.find(model => model.id === setting.model) : undefined;
  const model = setting.model && (!models.length || offered) ? setting.model : null;
  const target = model ? offered : models.find(item => item.isDefault);
  const reasoning = setting.reasoning && (!target || !target.efforts.length || target.efforts.includes(setting.reasoning)) ? setting.reasoning : null;
  return { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) };
}

/** A claim response with the hint on its job, unless that would make it too long for a worker. */
export function withHint<T extends { job?: unknown }>(response: T, hint: RoutingHint): T {
  if (!response.job || typeof response.job !== "object" || !Object.keys(hint).length) return response;
  const hinted = { ...response, job: { ...(response.job as object), ...hint } };
  return JSON.stringify(hinted).length <= MAX_CLAIM_CHARS ? hinted : response;
}
