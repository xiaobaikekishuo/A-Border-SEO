const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const publisher = process.env.ABORDER_WINDOWS_PUBLISHER?.trim();
const manifest = path.join(__dirname, "release-manifest.json");
const powerShell = path.join(__dirname, "build", "powershell");
const management = path.join(__dirname, "build", "management-config.json");
const hosted = path.join(__dirname, "hosted-workspace.json");
const mode = process.env.ABORDER_DESKTOP_MODE ?? "hosted";
if (!["hosted", "local-docker"].includes(mode)) throw new Error("Invalid ABORDER_DESKTOP_MODE.");
const isHosted = mode === "hosted";
if (isHosted) {
  const config = JSON.parse(readFileSync(hosted, "utf8"));
  const trust = existsSync(management) && JSON.parse(readFileSync(management, "utf8"));
  if (config.schemaVersion !== 1 || config.productId !== "a-border-seo" || config.workspaceOrigin !== "https://aborder.tuitehao.shop" ||
      !trust || trust.productId !== config.productId || trust.serverUrl !== config.workspaceOrigin) {
    throw new Error("Hosted builds require the trusted workspace origin and bundled management configuration.");
  }
}

if (!isHosted && !existsSync(path.join(powerShell, "pwsh.exe"))) {
  throw new Error("Stage PowerShell with scripts/stage-powershell.ps1 before building the Windows installer.");
}
if (!isHosted && publisher && existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).localImageId) {
  throw new Error("A signed release requires the official GHCR manifest.");
}

module.exports = {
  appId: "com.aborder.seo",
  productName: "A-Border SEO",
  copyright: "Copyright © A-Border SEO and CrawlSEO contributors",
  directories: { output: "dist" },
  artifactName: "A-Border-SEO-Setup-${version}-${arch}.${ext}",
  files: ["*.mjs", "*.cjs", "ui/**", "package.json", "!electron-builder.cjs"],
  extraResources: [
    { from: "../LICENSE", to: "LICENSE.txt" },
    { from: "../source/public/brand/a-border-symbol-512.png", to: "icon.png" },
    ...(!isHosted ? [{ from: powerShell, to: "powershell" }] : []),
    { from: "../source/lib/managed/protocol.mjs", to: "managed-protocol.mjs" },
    ...(existsSync(management) ? [{ from: management, to: "management-config.json" }] : []),
    ...(isHosted ? [
      { from: hosted, to: "hosted-workspace.json" },
      { from: "../source/local-worker", to: "local-worker", filter: ["index.mjs", "lib.mjs", "app-server.mjs"] },
    ] : [{
      from: "../windows",
      to: "windows",
      filter: ["compose*.yml", ".env.example", "scripts/*.ps1"],
    }]),
    ...(!isHosted && existsSync(manifest) ? [{ from: manifest, to: "release-manifest.json" }] : []),
  ],
  publish: { provider: "github", owner: "xiaobaikekishuo", repo: "A-Border-SEO", releaseType: "release" },
  forceCodeSigning: Boolean(publisher),
  win: {
    target: ["nsis"],
    icon: "../source/public/brand/a-border-symbol-512.png",
    verifyUpdateCodeSignature: true,
    ...(publisher ? { signtoolOptions: { publisherName: publisher } } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: "always",
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
};
