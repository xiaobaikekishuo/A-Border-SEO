import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = path.join(root, "desktop");
const require = createRequire(path.join(desktop, "package.json"));
const { extractFile, listPackage, statFile } = require("@electron/asar");
const resources = path.resolve(process.argv[2]);
const archive = path.join(resources, "app.asar");
const modules = readdirSync(desktop).filter(name => /\.(cjs|mjs)$/.test(name) && name !== "electron-builder.cjs");
const ui = readdirSync(path.join(desktop, "ui"), { recursive: true })
  .map(name => path.join("ui", name)).filter(name => statSync(path.join(desktop, name)).isFile());
for (const name of [...modules, ...ui]) {
  if (!readFileSync(path.join(desktop, name)).equals(extractFile(archive, name))) {
    throw new Error(`Packaged desktop file differs: ${name}`);
  }
}
const built = JSON.parse(extractFile(archive, "package.json"));
const source = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
if (built.version !== source.version || built.main !== source.main) throw new Error("Packaged version or entry point differs.");
const resourcesToCheck = [
  ["source/lib/managed/protocol.mjs", "managed-protocol.mjs"],
  ["source/local-worker/index.mjs", "local-worker/index.mjs"],
  ["source/local-worker/lib.mjs", "local-worker/lib.mjs"],
  ["desktop/hosted-workspace.json", "hosted-workspace.json"],
  ["desktop/build/management-config.json", "management-config.json"],
];
for (const [input, output] of resourcesToCheck) {
  if (!readFileSync(path.join(root, input)).equals(readFileSync(path.join(resources, output)))) {
    throw new Error(`Packaged hosted resource differs: ${output}`);
  }
}
console.log(`Verified ${modules.length + ui.length} desktop modules/UI assets, version ${built.version} and ${resourcesToCheck.length} runtime resources.`);

if (process.argv[3] === "--public-release") {
  const trust = JSON.parse(readFileSync(path.join(resources, "management-config.json"), "utf8"));
  if (trust.serverUrl !== "https://aborder.tuitehao.shop" || trust.productId !== "a-border-seo" ||
      Object.keys(trust).sort().join() !== "issuer,keys,productId,serverUrl" ||
      !Object.keys(trust.keys).length || Object.hasOwn(trust.keys, "fixture") ||
      Object.values(trust.keys).some(key => typeof key !== "string" || !key.startsWith("-----BEGIN PUBLIC KEY-----"))) {
    throw new Error("Public installer requires the production management origin and public trust keys.");
  }
  const expected = new Set([...modules, ...ui, "package.json"].map(name => path.normalize(name)));
  const sensitivePath = /(?:^|[/\\])(?:\.env(?:\..*)?|\.git|id_(?:rsa|ed25519)|auth\.json|session\.json|credentials\.json|.*\.(?:pem|key|p12|pfx|sqlite|sql|dump|bak))$/i;
  const credentials = [
    /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{36,}/,
    /gh[pousr]_[A-Za-z0-9]{35,}/, /sk-(?:proj-)?[a-zA-Z0-9_-]{40,}/, /AKIA[0-9A-Z]{16}/,
    /(?:password|access_token|refresh_token|client_secret)\s*[:=]\s*["'][^\s"'{}]{8,}["']/i,
  ];
  const checkText = (name, data) => {
    if (credentials.some(pattern => pattern.test(data.toString("utf8")))) throw new Error("Credential marker in " + name);
  };
  for (const entry of listPackage(archive)) {
    const name = path.normalize(entry.replace(/^[/\\]/, ""));
    if (sensitivePath.test(name)) throw new Error("Unexpected sensitive filename in package: " + name);
    if (statFile(archive, name).files || name.startsWith("node_modules" + path.sep)) continue;
    if (!expected.delete(name)) throw new Error("Unexpected first-party file in ASAR: " + name);
    checkText(name, extractFile(archive, name));
  }
  if (expected.size) throw new Error("Missing first-party files in ASAR.");
  for (const [, name] of resourcesToCheck) checkText(name, readFileSync(path.join(resources, name)));
}
