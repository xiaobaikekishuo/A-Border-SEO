#!/usr/bin/env node
/**
 * Stages the Prisma CLI and its FULL runtime dependency closure into a
 * directory the Dockerfile runner stage can COPY wholesale.
 *
 * Why: copying only `node_modules/prisma` and `node_modules/@prisma/engines`
 * misses dozens of transitive packages (`@prisma/debug`, `@prisma/config`,
 * `effect`, ...), and `prisma migrate deploy` then crashes with
 * MODULE_NOT_FOUND inside the image. A hand-kept COPY list drifts the same way
 * on any Prisma upgrade, so this walks the dependency graph of the tree that
 * is actually installed, at build time. Do not replace it with a hand list.
 *
 * Runs in the builder stage with plain node, so the runner stage needs no
 * second npm install (slow, and fragile under emulated architectures).
 *
 * Usage: node scripts/stage-prisma-cli.mjs <dest-dir>
 */
import fs from "fs";
import path from "path";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: node scripts/stage-prisma-cli.mjs <dest-dir>");
  process.exit(1);
}

// Breadth-first walk of dependencies + optionalDependencies from `prisma`.
const seen = new Set();
const queue = ["prisma"];
while (queue.length > 0) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  const pkgPath = path.join("node_modules", name, "package.json");
  if (!fs.existsSync(pkgPath)) continue; // unfulfilled optional dep
  seen.add(name);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  queue.push(
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {})
  );
}

for (const name of [...seen].sort()) {
  fs.cpSync(path.join("node_modules", name), path.join(dest, name), {
    recursive: true,
    // Flatten symlinks now so the staged tree is exactly what the runner
    // gets: Docker COPY dereferences symlinks anyway (a flattened .bin-style
    // link makes the CLI look for its WASM files in the wrong directory).
    dereference: true,
  });
}

console.log(`staged ${seen.size} packages into ${dest}`);
