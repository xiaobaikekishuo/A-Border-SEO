import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { validateConfig } from "../source/lib/managed/protocol.mjs";

try {
  const file = process.argv[2];
  const fixture = file === "--ci-fixture";
  if (fixture && (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF_TYPE === "tag")) {
    throw new Error("The disposable trust key is only for non-release CI.");
  }
  const raw = fixture ? JSON.stringify({ productId: "a-border-seo", serverUrl: "https://aborder.tuitehao.shop",
    keys: { fixture: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) } })
    : file ? readFileSync(file, "utf8") : process.env.ABORDER_MANAGEMENT_CONFIG_JSON;
  if (!raw) throw new Error("Provide a management trust JSON file or ABORDER_MANAGEMENT_CONFIG_JSON.");
  const config = validateConfig(JSON.parse(raw.replace(/^\uFEFF/, "")));
  if (config.productId !== "a-border-seo") throw new Error("Management configuration must target a-border-seo.");
  mkdirSync(new URL("../desktop/build/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../desktop/build/management-config.json", import.meta.url), JSON.stringify(config, null, 2) + "\n");
  console.log("Validated and staged the public management trust configuration.");
} catch (error) {
  console.error("Management configuration could not be staged. " + (error.message.startsWith("Provide") ? error.message : "Check HTTPS origin, product and Ed25519 public keys."));
  process.exitCode = 1;
}
