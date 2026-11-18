import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const templateDir = path.join(root, 'desktop', 'website');
const brandDir = path.join(root, 'source', 'public', 'brand');
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node scripts/build-software-page.mjs <verified-windows-release-dir> <software-output-dir>');
  process.exit(2);
}
const [release, output] = args.map(p => path.resolve(p));

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(name) {
  return JSON.parse((await readFile(path.join(release, name), 'utf8')).replace(/^\uFEFF/, ''));
}

const manifest = await readJson('desktop-release.json');
const verified = await readJson('verified-payload.json');
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.schemaVersion !== 1 ||
    manifest.platform !== 'win32-x64' || manifest.desktopMode !== 'hosted' ||
    manifest.workspaceOrigin !== 'https://aborder.tuitehao.shop') {
  throw new Error('Expected a versioned Windows x64 hosted A-Border SEO release.');
}
const name = `A-Border-SEO-Setup-${version}-x64.exe`;
const exe = path.join(release, name);
const checksums = (await readFile(path.join(release, 'SHA256SUMS.txt'), 'utf8')).replace(/^\uFEFF/, '');
const entries = checksums.split(/\r?\n/).map(l => l.match(/^([a-f\d]{64})\s+\*?(.+)$/i)).filter(m => m?.[2] === name);
const digest = await sha256(exe);
if (entries.length !== 1 || entries[0][1].toLowerCase() !== digest ||
    verified.version !== version || verified.installerSha256 !== digest ||
    verified.modulesAndUiMatch !== true || verified.workerAndTrustMatch !== true) {
  throw new Error('Installer, SHA256SUMS.txt and hosted payload verification must match.');
}

// Inspect the actual installer. A failed signature must never be labeled unsigned.
const sig = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$ErrorActionPreference="Stop"; $env:PSModulePath="$PSHOME\\Modules"; (Get-AuthenticodeSignature -LiteralPath $env:ABORDER_SITE_INSTALLER).Status.ToString()'],
{ env: { ...process.env, ABORDER_SITE_INSTALLER: exe }, encoding: 'utf8', windowsHide: true }).trim();
if (!['Valid', 'NotSigned'].includes(sig)) throw new Error(`Unexpected Windows signature status: ${sig}`);

// Copy to an unpublished staging file and verify it before giving it an immutable public name.
async function installImmutable(pending, target, expected) {
  try {
    await copyFile(pending, target, constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (await sha256(target) !== expected) throw new Error(`Published filename already has different contents: ${target}`);
  }
}

const rel = `releases/a-border-seo/${version}`;
const assets = path.join(output, 'assets');
const page = path.join(output, 'seo');
const directory = path.join(output, rel);
await Promise.all([page, assets, directory].map(folder => mkdir(folder, { recursive: true })));
const staging = await mkdtemp(path.join(output, '.seo-build-'));
try {
  const snapshot = path.join(staging, name);
  await copyFile(exe, snapshot);
  if (await sha256(snapshot) !== digest) throw new Error('Installer changed during build.');
  await installImmutable(snapshot, path.join(directory, name), digest);
  const sum = name + '.sha256';
  await writeFile(path.join(staging, sum), `${digest}  ${name}\n`);
  await installImmutable(path.join(staging, sum), path.join(directory, sum), await sha256(path.join(staging, sum)));
  async function asset(source, stem) {
    const pending = path.join(staging, stem);
    await copyFile(source, pending);
    const hash = await sha256(pending);
    const file = `seo-${stem}.${hash.slice(0, 12)}${path.extname(source)}`;
    await installImmutable(pending, path.join(assets, file), hash);
    return '/software/assets/' + file;
  }
  const [css, logo, icon] = await Promise.all([
    asset(path.join(templateDir, 'seo.css'), 'styles'),
    asset(path.join(brandDir, 'a-border-logo.png'), 'logo'),
    asset(path.join(brandDir, 'a-border-symbol-192.png'), 'symbol'),
  ]);
  const values = {
    version, name, size: ((await stat(snapshot)).size / 1024 ** 2).toFixed(2), digest, css, logo, icon,
    url: `/software/${rel}/${name}`,
    signature: sig === 'Valid' ? '已签名' : '未签名',
  };
  const template = await readFile(path.join(templateDir, 'seo.html'), 'utf8');
  const html = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown template field: ${key}`);
    return values[key];
  });
  await writeFile(path.join(staging, 'index.html'), html);
  await rename(path.join(staging, 'index.html'), path.join(page, 'index.html'));
  console.log(JSON.stringify({ version, installer: name, sha256: digest, signature: sig, output }));
} finally {
  // Remove only the files generated by this run in its unique staging directory.
  for (const filename of await readdir(staging)) await unlink(path.join(staging, filename));
  await rmdir(staging);
}
