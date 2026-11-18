import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { databaseSettings, parseEnvironment, sha256, validateMigrations, verifyBundle } from "../deploy/common.mjs";

test("environment parser retains opaque values and rejects ambiguous or duplicate entries", () => {
  assert.deepEqual(parseEnvironment('# fixture\nNEXTAUTH_SECRET=abc==\nDATABASE_URL=postgresql://u:p%40x@127.0.0.1:5432/db\nLABEL="test value"\n'), {
    NEXTAUTH_SECRET: "abc==", DATABASE_URL: "postgresql://u:p%40x@127.0.0.1:5432/db", LABEL: "test value",
  });
  for (const value of ["A=x\nA=y", "export A=x", "A=x # trailing ambiguity", "A='single quoted'", 'A="line\\nnext"']) {
    assert.throws(() => parseEnvironment(value));
  }
});

test("database backup inputs require exact loopback, safe identifiers and the same public Prisma schema", () => {
  const settings = databaseSettings({ DATABASE_URL: "postgresql://app:p%3Ass@127.0.0.1:5432/aborder?schema=public" });
  assert.equal(settings.password, "p:ss");
  assert.equal(settings.database, "aborder");
  for (const value of ["postgresql://app:pw@remote.example/aborder", "postgresql://app:pw@localhost/aborder",
    "postgresql://app:pw@127.0.0.1/a%22b", "postgresql://app:pw@127.0.0.1/aborder?schema=another", "postgresql://app@127.0.0.1/aborder"]) {
    assert.throws(() => databaseSettings({ DATABASE_URL: value }));
  }
});

test("migration validation permits forward additions but never unchecked schema downgrade or failed migrations", () => {
  const old = { name: "001_first", sha256: "a".repeat(64) };
  const next = { name: "002_next", sha256: "b".repeat(64) };
  const applied = [{ name: old.name, checksum: old.sha256, finished: true, rolledBack: false }];
  assert.deepEqual(validateMigrations(applied, [old, next]), [[old.name, old.sha256]]);
  assert.throws(() => validateMigrations(applied, [old, next], true), /exactly/);
  assert.throws(() => validateMigrations(applied, [next]), /applied/);
  assert.throws(() => validateMigrations([{ ...applied[0], finished: false }], [old]), /unfinished/);
  assert.throws(() => validateMigrations([{ ...applied[0], checksum: "c".repeat(64) }], [old]), /applied/);
  assert.deepEqual(validateMigrations([{ ...applied[0], finished: false, rolledBack: true }], []), []);
});

test("bundle verification rejects tampered files, extra files and escaping manifest paths", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aborder-bundle-test-"));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("aborder-bundle-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const names = ["app/server.js", "app/worker.cjs", "app/node_modules/prisma/build/index.js", "app/prisma/schema.prisma", "server/deploy/service.mjs"];
  for (const name of names) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "fixture\n");
  }
  const manifest = { v: 1, version: "1.5.0", migrations: [], files: names.map(name => ({ path: name, sha256: sha256(path.join(root, name)) })) };
  const write = () => fs.writeFileSync(path.join(root, "server-bundle.json"), JSON.stringify(manifest));
  write();
  assert.equal(verifyBundle(root, false).version, "1.5.0");
  fs.writeFileSync(path.join(root, "extra.txt"), "unexpected");
  assert.throws(() => verifyBundle(root, false), /Unexpected/);
  fs.unlinkSync(path.join(root, "extra.txt"));
  fs.writeFileSync(path.join(root, "app/server.js"), "changed");
  assert.throws(() => verifyBundle(root, false), /checksum/);
  fs.writeFileSync(path.join(root, "app/server.js"), "fixture\n");
  manifest.files.push({ path: "../outside", sha256: "a".repeat(64) });
  write();
  assert.throws(() => verifyBundle(root, false), /Unsafe/);
});
