import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { readJson, saveJson } from "./runtime.mjs";

const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const credential = /^[a-zA-Z0-9_-]{32,200}$/;
const activationCode = /^[a-zA-Z0-9_-]{8,200}$/;
const publicError = new Set(["activation_invalid", "activation_expired", "device_limit", "device_conflict",
  "account_pending", "account_expired", "username_taken", "user_exists", "invalid_registration", "invalid_user_credentials", "invalid_credentials", "invalid_username", "invalid_password", "registration_unavailable", "account_already_registered", "device_unavailable", "rate_limited",
  "account_disabled", "activation_unavailable", "device_disabled", "device_revoked", "device_limit_reached", "invalid_activation",
  "account_unavailable", "installation_already_bound", "device_requires_reactivation", "device_authentication_failed"]);
const states = new Set(["received", "draining", "effective", "failed", "upgrading"]);

export class ManagedClient {
  constructor({ protocol, config, file, dataRoot, desktopVersion, seal, open, versions, onChange,
    fetcher = globalThis.fetch, time = () => Math.floor(Date.now() / 1000), random = Math.random, requireUser = false }) {
    Object.assign(this, { protocol, config, file, desktopVersion, seal, open, versions, onChange, fetcher, time, random, requireUser });
    this.identity = readJson(file, null) ?? {
      v: 1, issuer: config.issuer, productId: config.productId, installationId: randomUUID(), accountId: null,
      sealedCredential: null, lease: null, receivedAt: 0, highestWallTime: time(), sequence: 0, revision: 0,
    };
    if (this.identity.v !== 1 || this.identity.issuer !== config.issuer || this.identity.productId !== config.productId
      || !id.test(this.identity.installationId) || (this.identity.accountId !== null && !id.test(this.identity.accountId))
      || !Number.isSafeInteger(this.identity.highestWallTime) || !Number.isSafeInteger(this.identity.receivedAt)
      || !Number.isSafeInteger(this.identity.sequence) || !Number.isSafeInteger(this.identity.revision)) {
      throw new Error("management_identity_invalid");
    }
    this.dataRoot = dataRoot;
    this.connection = "idle";
    this.failures = 0;
    this.nextPoll = 0;
    this.lastReport = null;
    this.lastProjection = null;
    this.persist();
  }

  state() {
    const { v, installationId, accountId, lease, receivedAt, highestWallTime } = this.identity;
    return { v, installationId, accountId, lease: this.requireUser && !this.identity.user ? null : lease,
      desktopVersion: this.desktopVersion, receivedAt, highestWallTime };
  }

  snapshot() {
    const { backendVersion } = this.versions();
    const state = this.state();
    const decision = this.protocol.readManagedState(this.config, state, { backendVersion, now: this.time() });
    return {
      connection: this.connection, server: new URL(this.config.serverUrl).host,
      installationId: state.installationId, accountId: state.accountId,
      user: this.identity.user ?? null, pendingUsername: this.identity.pendingUsername ?? null,
      signedIn: Boolean(this.identity.user && this.identity.sealedCredential),
      decision, expiresAt: this.identity.expiresAt ?? null, lastContact: state.receivedAt || null,
    };
  }

  setDataRoot(dataRoot) {
    if (this.dataRoot === dataRoot) return;
    // A previously selected installation must stop receiving authority when we leave it.
    saveJson(path.join(this.dataRoot, "private", "managed", "state.json"), { ...this.state(), lease: null });
    this.dataRoot = dataRoot;
    this.lastProjection = null;
    this.lastReport = null;
    this.projectState();
  }

  projectState() {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.lastProjection) return;
    const directory = path.join(this.dataRoot, "private", "managed");
    mkdirSync(directory, { recursive: true });
    saveJson(path.join(directory, "config.json"), this.config);
    saveJson(path.join(directory, "state.json"), state);
    this.lastProjection = key;
  }

  persist() {
    saveJson(this.file, this.identity);
    this.projectState();
  }

  metadata() {
    const { backendVersion } = this.versions();
    return {
      productId: this.config.productId, installationId: this.identity.installationId,
      desktopVersion: this.desktopVersion, backendVersion: backendVersion ?? null, platform: "win32-x64",
    };
  }

  async request(endpoint, payload, token) {
    const response = await this.fetcher(new URL(endpoint, this.config.serverUrl), {
      method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
    });
    if (response.status === 204) return null;
    if (!response.body) throw new Error("management_unavailable");
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 48_000) {
        await reader.cancel();
        throw new Error("management_unavailable");
      }
      parts.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!response.ok) {
      const code = data?.code ?? data?.error;
      throw new Error(publicError.has(code) ? code : "management_unavailable");
    }
    return data;
  }

  accept(lease, accountId, sealedCredential) {
    const now = this.time();
    const clockReversed = now + this.protocol.clockToleranceSeconds < this.identity.highestWallTime;
    const claims = this.protocol.verifyLease(lease, {
      config: this.config, installationId: this.identity.installationId, accountId,
      now: clockReversed ? now : Math.max(now, this.identity.highestWallTime),
    });
    if (claims.revision < this.identity.revision || claims.sequence <= this.identity.sequence) {
      throw new Error("old_management_policy");
    }
    // Only a newly issued lease from the pinned service can confirm a clock
    // correction. Offline restarts and old leases retain the saved time floor.
    if (clockReversed && Math.abs(claims.iat - now) > this.protocol.clockToleranceSeconds) throw new Error("clock_invalid");
    this.identity = { ...this.identity, ...(this.identity.accountId !== accountId ? { verifiedRelease: null, pendingUpdate: null } : {}),
      accountId, sealedCredential, lease, receivedAt: now,
      highestWallTime: clockReversed ? now : Math.max(now, this.identity.highestWallTime), sequence: claims.sequence,
      revision: claims.revision, expiresAt: claims.exp };
    this.persist();
    this.connection = "online";
    this.failures = 0;
    this.nextPoll = now + 55 + Math.floor(this.random() * 11);
    this.lastReport = null;
    this.onChange();
  }

  async activate(code) {
    if (typeof code !== "string" || !activationCode.test(code.trim())) throw new Error("activation_invalid");
    if (this.activating) throw new Error("activation_unavailable");
    this.activating = true;
    try {
      await this.polling;
      // Test access to the OS credential store before consuming a one-time code.
      await this.seal("availability-check");
      const result = await this.request("/v1/activate", { ...this.metadata(), code: code.trim() });
      if (typeof result?.accountId !== "string" || !id.test(result.accountId) || typeof result?.deviceToken !== "string"
        || !credential.test(result.deviceToken)) throw new Error("management_unavailable");
      this.accept(result.lease, result.accountId, await this.seal(result.deviceToken));
      await this.report("received");
    } finally { this.activating = false; }
  }

  async getCredential() {
    if (!this.identity.sealedCredential) return null;
    const token = await this.open(this.identity.sealedCredential);
    if (!credential.test(token)) throw new Error("device_credential_unavailable");
    return token;
  }

  async userAction(action, input) {
    const username = input?.username?.trim();
    const password = input?.password;
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username ?? "") || typeof password !== "string"
      || password.length < 8 || password.length > 128) throw new Error("invalid_user_credentials");
    if (this.activating) throw new Error("activation_unavailable");
    this.activating = true;
    try {
      await this.polling;
      await this.seal("availability-check");
      const token = action === "register" ? await this.getCredential() : null;
      const result = await this.request(`/v1/user/${action}`, { ...this.metadata(), username, password }, token);
      if (action === "register") {
        if (result?.registered !== true || result.approval !== "pending") throw new Error("management_unavailable");
        this.identity = { ...this.identity, lease: null, sealedCredential: null, user: null, pendingUsername: username, expiresAt: null };
        this.persist();
        this.onChange();
        return;
      }
      if (!id.test(result?.accountId ?? "") || !credential.test(result?.deviceToken ?? "")
        || !/^[a-zA-Z0-9_.-]{3,64}$/.test(result?.user?.username ?? "")) throw new Error("management_unavailable");
      const previous = this.identity;
      try {
        this.identity = { ...this.identity, user: { username: result.user.username }, pendingUsername: null };
        this.accept(result.lease, result.accountId, await this.seal(result.deviceToken));
      } catch (failure) { this.identity = previous; throw failure; }
      await this.report("received");
    } finally { this.activating = false; }
  }

  register(input) { return this.userAction("register", input); }
  login(input) { return this.userAction("login", input); }

  async logout() {
    this.activating = true;
    try {
      await this.polling;
      await this.reporting;
      this.identity = { ...this.identity, user: null, pendingUsername: null, sealedCredential: null,
        lease: null, receivedAt: 0, expiresAt: null, pendingUpdate: null };
      this.connection = "idle";
      this.lastReport = null;
      this.persist();
      this.onChange();
    } finally { this.activating = false; }
  }

  poll({ force = false } = {}) {
    if (this.polling) return this.polling;
    if (this.activating || !this.identity.sealedCredential || (this.requireUser && !this.identity.user)
      || (!force && this.time() < this.nextPoll)) return Promise.resolve();
    this.polling = this.refreshLease().finally(() => { this.polling = null; });
    return this.polling;
  }

  async refreshLease() {
    this.connection = "checking";
    this.onChange();
    try {
      const token = await this.getCredential();
      const result = await this.request("/v1/lease", this.metadata(), token);
      this.accept(result?.lease, this.identity.accountId, this.identity.sealedCredential);
      await this.report("received");
    } catch {
      this.connection = "offline";
      this.failures = Math.min(this.failures + 1, 6);
      this.nextPoll = this.time() + Math.min(300, 8 * 2 ** this.failures) + Math.floor(this.random() * 8);
      this.onChange();
    }
  }

  tick() {
    const now = this.time();
    if (now - this.identity.highestWallTime >= 30) {
      this.identity = { ...this.identity, highestWallTime: now };
      this.persist();
    } else {
      this.projectState();
    }
    this.onChange();
    return this.poll();
  }

  async observeHostedUpdate(health) {
    const { decision, expiresAt } = this.snapshot();
    const target = decision.release?.version;
    if (!target || !decision.allowed || expiresAt <= this.time() || this.desktopVersion !== target ||
      !health?.hosted || health.issue || health.services?.app !== "healthy" || health.backendVersion !== target ||
      this.versions().backendVersion !== target) return false;
    // A manual reinstall has no updater journal. The signed assignment and both
    // actually running versions provide the same evidence for either install path.
    if (this.identity.verifiedRelease !== target) await this.report("effective", "update_verified", target);
    return this.identity.verifiedRelease === target;
  }

  async report(status, code, releaseVersion) {
    if (!states.has(status) || !this.identity.sequence) return;
    if (releaseVersion && code?.startsWith("update_")) {
      const updateReceipt = { status, code, releaseVersion };
      if (JSON.stringify(updateReceipt) !== JSON.stringify(this.identity.pendingUpdate)) {
        this.identity = { ...this.identity, pendingUpdate: updateReceipt };
        try { saveJson(this.file, this.identity); } catch { /* the current process can still retry */ }
      }
    }
    if (this.reporting) return this.reporting;
    this.reporting = this.sendReports(status, code, releaseVersion).finally(() => { this.reporting = null; });
    return this.reporting;
  }

  async sendReports(status, code, releaseVersion) {
    const pending = this.identity.pendingUpdate;
    const decision = this.snapshot().decision;
    const canSend = pending && decision.release?.version === pending.releaseVersion &&
      (pending.code !== "update_verified" || (decision.allowed && this.desktopVersion === pending.releaseVersion &&
        this.versions().backendVersion === pending.releaseVersion));
    if (canSend) {
      if (!await this.sendReceipt(pending.status, pending.code)) return;
      if (this.identity.pendingUpdate === pending) {
        this.identity = { ...this.identity, pendingUpdate: null,
          ...(pending.code === "update_verified" ? { verifiedRelease: pending.releaseVersion } : {}) };
        try { saveJson(this.file, this.identity); } catch { /* repeat idempotently after restart */ }
      }
      // Give the update result its own visible transition before reporting policy again.
      return;
    }
    if (!releaseVersion) await this.sendReceipt(status, code);
  }

  async sendReceipt(status, code) {
    const { sequence, revision } = this.identity;
    const receipt = { ...this.metadata(), sequence, revision, status, ...(code ? { code } : {}) };
    const key = JSON.stringify(receipt);
    if (key === this.lastReport) return true;
    try {
      const token = await this.getCredential();
      if (!token) return false;
      await this.request("/v1/receipt", receipt, token);
      if (sequence !== this.identity.sequence) return false;
      this.lastReport = key;
      return true;
    } catch { return false; }
  }
}
