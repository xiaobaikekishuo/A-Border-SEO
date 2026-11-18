import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase } from "../db.mjs";

test("registration migration preserves existing administrator, entitlement and device binding", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-registration-migration-"));
  const filename = path.join(directory, "fixture.sqlite");
  let db = new DatabaseSync(filename);
  try {
    db.exec(readFileSync(new URL("../migrations/001-control-plane.sql", import.meta.url), "utf8"));
    db.exec("PRAGMA user_version = 1");
    db.prepare("INSERT INTO admin(username, password) VALUES (?, ?)").run("existing-admin", "unchanged-fixture-hash");
    db.prepare("INSERT INTO account(product_id, id, label, enabled, expires_at, device_limit, features) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("a-border-seo", "existing-account-100", "Existing customer", 1, 1_900_000_000, 2, '{}');
    db.prepare(`INSERT INTO device(product_id, installation_id, account_id, token_hash, last_seen_at, desktop_version, backend_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run("a-border-seo", "existing-installation-100", "existing-account-100", "unchanged-token-hash", 1_800_000_000, "1.3.0", "1.3.0");
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
    assert.equal(db.prepare("SELECT count(*) AS count FROM hosted_receipt").get().count, 0);
    assert.equal(db.prepare("SELECT password FROM admin").get().password, "unchanged-fixture-hash");
    const account = db.prepare("SELECT * FROM account").get();
    assert.equal(account.enabled, 1);
    assert.equal(account.expires_at, 1_900_000_000);
    assert.equal(account.username, null);
    assert.equal(account.approved_at, null);
    assert.equal(db.prepare("SELECT token_hash FROM device").get().token_hash, "unchanged-token-hash");
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare("SELECT count(*) AS count FROM account").get().count, 1);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    db.close();
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith("aborder-registration-migration-")) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("receipt component migration preserves existing rows as unattributed history", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-receipt-migration-"));
  const filename = path.join(directory, "fixture.sqlite");
  let db = new DatabaseSync(filename);
  try {
    for (const name of ["001-control-plane.sql", "002-user-registration.sql", "003-hosted-workbench.sql"]) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    db.exec("PRAGMA user_version = 3");
    db.prepare("INSERT INTO account(product_id, id, label, enabled, expires_at, device_limit, features) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("a-border-seo", "receipt-owner", "Existing owner", 1, null, 2, '{}');
    db.prepare(`INSERT INTO hosted_receipt(product_id, scope, subject_id, account_id, revision, backend_version,
      status, code, checked_at, valid_until, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("a-border-seo", "account", "receipt-owner", "receipt-owner", 7, "1.5.0", "draining", "fixture", 100, 130, 100);
    db.close(); db = openDatabase(filename);
    const receipt = db.prepare("SELECT * FROM hosted_receipt").get();
    assert.equal(receipt.component, "legacy"); assert.equal(receipt.status, "draining");
    assert.equal(receipt.account_id, "receipt-owner"); assert.equal(receipt.revision, 7);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
    db.prepare(`INSERT INTO hosted_receipt(product_id, scope, subject_id, component, account_id, revision, backend_version,
      status, checked_at, valid_until, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("a-border-seo", "account", "receipt-owner", "ordinary_worker", "receipt-owner", 7, "1.5.0", "blocked", 101, 131, 101);
    assert.equal(db.prepare("SELECT count(*) AS count FROM hosted_receipt").get().count, 2);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith("aborder-receipt-migration-")) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
