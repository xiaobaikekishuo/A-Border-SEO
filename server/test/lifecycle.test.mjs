import assert from "node:assert/strict";
import test from "node:test";
import { units } from "../deploy/common.mjs";
import { restorePreviousRelease, startReleaseServices } from "../deploy/lifecycle.mjs";

function serviceFixture() {
  const calls = [];
  const dependencies = {
    verifyRelease: release => { calls.push(["verify", release]); return { version: "1.4.3" }; },
    resetFailed: selected => { calls.push(["reset", ...selected]); },
    startUnit: unit => { calls.push(["start", unit]); },
    checkApp: version => { calls.push(["app-health", version]); },
    checkWorker: () => { calls.push(["worker-health"]); },
  };
  return { calls, dependencies };
}

test("recovering an app-only installation never starts or probes the inactive worker", async () => {
  const f = serviceFixture();
  await startReleaseServices("old-release", [true, false], f.dependencies);
  assert.deepEqual(f.calls, [["verify", "old-release"], ["reset", units[0]], ["start", units[0]], ["app-health", "1.4.3"]]);
});

test("recovering a worker-only installation never starts the app or waits for an app endpoint", async () => {
  const f = serviceFixture();
  await startReleaseServices("old-release", [false, true], f.dependencies);
  assert.deepEqual(f.calls, [["verify", "old-release"], ["reset", units[1]], ["start", units[1]], ["worker-health"]]);
});

test("initial start validates app before starting worker, and failed app health cannot launch jobs", async () => {
  const f = serviceFixture();
  f.dependencies.checkApp = () => { throw new Error("fixture health failure"); };
  await assert.rejects(startReleaseServices("new-release", [true, true], f.dependencies), /health failure/);
  assert.equal(f.calls.some(call => call[0] === "start" && call[1] === units[1]), false);
  assert.equal(f.calls.some(call => call[0] === "worker-health"), false);
  const idle = serviceFixture();
  await startReleaseServices("old-release", [false, false], idle.dependencies);
  assert.deepEqual(idle.calls, []);
});

function recoveryFixture(overrides = {}) {
  const services = serviceFixture();
  const switched = [];
  return { services, switched, options: {
    previous: "old-release", active: [true, false], environmentHash: "before", beforeMigrations: [{ name: "001" }],
    migrationStarted: true, readEnvironmentHash: () => "before", readMigrations: () => [{ name: "001" }],
    switchRelease: release => { switched.push(release); },
    startRelease: (release, active) => startReleaseServices(release, active, services.dependencies), ...overrides,
  } };
}

test("changed/unreadable environment prevents pointer switch and all startup, even before migrations", async () => {
  for (const migrationStarted of [false, true]) {
    for (const readEnvironmentHash of [() => "changed", () => { throw new Error("file unavailable"); }]) {
      const f = recoveryFixture({ migrationStarted, readEnvironmentHash });
      assert.equal(await restorePreviousRelease(f.options), false);
      assert.deepEqual(f.switched, []);
      assert.deepEqual(f.services.calls, []);
    }
  }
});

test("environment change during migration inspection is rechecked before restoring any program", async () => {
  let changed = false;
  const f = recoveryFixture({ readEnvironmentHash: () => changed ? "changed" : "before",
    readMigrations: () => { changed = true; return [{ name: "001" }]; } });
  assert.equal(await restorePreviousRelease(f.options), false);
  assert.deepEqual(f.switched, []);
  assert.deepEqual(f.services.calls, []);
});

test("changed/unknown migration history stays stopped, while an unchanged state restores only prior active services", async () => {
  for (const readMigrations of [() => [{ name: "001" }, { name: "002" }], () => { throw new Error("database unavailable"); }]) {
    const f = recoveryFixture({ readMigrations });
    assert.equal(await restorePreviousRelease(f.options), false);
    assert.deepEqual(f.switched, []);
    assert.deepEqual(f.services.calls, []);
  }
  const good = recoveryFixture();
  assert.equal(await restorePreviousRelease(good.options), true);
  assert.deepEqual(good.switched, ["old-release"]);
  assert.deepEqual(good.services.calls.filter(call => call[0] === "start"), [["start", units[0]]]);
  assert.equal(good.services.calls.some(call => call[0] === "worker-health"), false);
});
