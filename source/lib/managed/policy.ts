import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "@/lib/version";
import { readManagedState, validateConfig, type ManagedState } from "./protocol.mjs";
import { hostedMode } from "@/lib/hosted/control";
import { hostedContext } from "@/lib/hosted/context";

export type ManagedFeature = "jobs" | "codex" | "manus" | "geo";

const allowedFeatures = { jobs: true, codex: true, manus: true, geo: true };
const deniedFeatures = { jobs: false, codex: false, manus: false, geo: false };

export function managedDecision() {
  if (hostedMode()) {
    const snapshot = hostedContext.getStore()?.snapshot;
    // Hosted HTTP requests are gated per session by proxy/auth; background jobs
    // have explicit per-owner asynchronous gates. A shared local lease is never used.
    return { enabled: Boolean(snapshot), allowed: snapshot?.allowed ?? true, reason: snapshot?.reason ?? "hosted",
      features: snapshot?.features ?? allowedFeatures, revision: snapshot?.revision ?? null, sequence: null,
      maintenanceMessage: snapshot?.maintenanceMessage ?? "", release: null };
  }
  if (process.env.ABORDER_MANAGED !== "1") {
    return {
      enabled: false, allowed: true, reason: "unmanaged", features: allowedFeatures,
      revision: null, sequence: null, maintenanceMessage: "", release: null,
    };
  }
  const directory = process.env.ABORDER_MANAGED_POLICY_DIR;
  if (directory) {
    try {
      const config = validateConfig(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")), { allowHttpLoopback: true });
      const state: ManagedState = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
      return { enabled: true, ...readManagedState(config, state, { backendVersion: APP_VERSION }) };
    } catch { /* Absent, invalid and unreadable local grants all restrict use. */ }
  }
  return {
    enabled: true, allowed: false, reason: "verification_required", features: deniedFeatures,
    revision: null, sequence: null, maintenanceMessage: "", release: null,
  };
}

export function managedAllows(feature?: ManagedFeature): boolean {
  const decision = managedDecision();
  return decision.allowed && (feature === undefined || decision.features[feature]);
}

export function managedAllowsJob(type: string, decision = managedDecision()): boolean {
  return decision.allowed && decision.features.jobs
    && (!type.startsWith("geo-") || decision.features.geo);
}

export function decisionFingerprint(decision = managedDecision()): string | null {
  if (!decision.enabled) return null;
  return JSON.stringify([
    decision.revision, decision.allowed, decision.reason,
    decision.features.jobs, decision.features.codex, decision.features.manus, decision.features.geo,
  ]);
}
