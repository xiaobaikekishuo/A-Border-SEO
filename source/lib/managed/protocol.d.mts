import type { KeyObject } from "node:crypto";

export interface ManagementConfig {
  serverUrl: string;
  issuer: string;
  productId: string;
  keys: Record<string, string>;
}
export type ManagedFeature = "jobs" | "codex" | "manus" | "geo";
export interface ManagedRelease {
  version: string;
  notes: string;
  deadline: number | null;
}
export interface LeasePolicy {
  productDisabled: boolean;
  accountDisabled: boolean;
  deviceDisabled: boolean;
  entitlementExpiresAt: number | null;
  maintenance: { active: boolean; message: string };
  features: Record<ManagedFeature, boolean>;
  minimumDesktopVersion: string | null;
  minimumBackendVersion: string | null;
  release: ManagedRelease | null;
}
export interface LeaseClaims {
  v: 1; iss: string; aud: string; productId: string; installationId: string; accountId: string;
  iat: number; exp: number; sequence: number; revision: number; policy: LeasePolicy;
}
export interface ManagedState {
  v: 1; installationId: string; accountId: string; lease: string | null;
  desktopVersion: string; receivedAt: number; highestWallTime: number;
}
export type DeniedReason = "activation_required" | "product_disabled" | "account_disabled" | "device_disabled"
  | "clock_invalid" | "entitlement_expired" | "lease_expired" | "update_required" | "maintenance" | "invalid_lease";
export interface ManagedDecision {
  allowed: boolean;
  reason: DeniedReason | null;
  features: Record<ManagedFeature, boolean>;
  revision: number | null;
  sequence: number | null;
  maintenanceMessage: string;
  release: ManagedRelease | null;
}

export const audience: string;
export const maxLeaseSeconds: number;
export const clockToleranceSeconds: number;
export const managedFeatures: readonly ManagedFeature[];
export function compareVersions(left: string, right: string): -1 | 0 | 1;
export function validateConfig(config: unknown, options?: { allowHttpLoopback?: boolean }): ManagementConfig;
export function signLease(claims: LeaseClaims, kid: string, privateKey: KeyObject | Buffer | string): string;
export function verifyLease(token: unknown, options: {
  config: ManagementConfig; installationId: string; accountId: string; now?: number; allowExpired?: boolean;
}): LeaseClaims;
export function denied(reason: DeniedReason): ManagedDecision;
export function evaluateLease(claims: LeaseClaims | null, options: {
  desktopVersion: string; backendVersion?: string | null; now?: number; clockInvalid?: boolean;
}): ManagedDecision;
export function readManagedState(config: ManagementConfig, state: ManagedState | null, options: {
  backendVersion?: string | null; now?: number;
}): ManagedDecision;
