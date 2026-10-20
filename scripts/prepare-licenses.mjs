import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const write = args.includes('--write');
assert(args.every((arg) => arg === '--write'), 'Usage: node scripts/prepare-licenses.mjs [--write]');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const production = Object.entries(lock.packages).filter(([location, entry]) => location && !entry.dev).sort(([a], [b]) => a.localeCompare(b, 'en'));
const closure = production.map(([location, entry]) => ({ location, version: entry.version, license: entry.license ?? null, integrity: entry.integrity ?? null }));
const closureHash = hash(JSON.stringify(closure));
const upstream = JSON.parse(await readFile(path.join(root, 'public/licenses/upstream/sources.json'), 'utf8')).sources;
const inventoryPath = path.join(root, 'public/licenses/packages/index.json');
const cache = path.join(root, 'tmp/publish/assets/prepare-licenses');
const legalName = /^(licen[cs]e|copying|copyright|notice|third.?party.?notices|authors)([._-].*)?$/i;
const escaped = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const assets = JSON.parse(await readFile(path.join(root, 'docs/asset-sources.json'), 'utf8'));
for (const record of [
  assets.avatar.output, assets.avatar.declaration, assets.avatar.licenseText,
  assets.avatar.preparation.toolchainLock, assets.model.declaration,
  assets.voices.declaration, assets.dictionary, assets.vendoredHeadTTS.licenseFile,
  ...assets.model.files, ...assets.voices.files,
]) {
  const bytes = await readFile(path.join(root, record.path));
  assert.equal(hash(bytes), record.sha256, `Asset or declaration hash must match: ${record.path}`);
  assert.equal(bytes.length, record.bytes, `Asset or declaration size must match: ${record.path}`);
}
const dictionary = await readFile(path.join(root, assets.dictionary.path));
const dictionaryNotice = await readFile(path.join(root, assets.dictionary.notice));
assert(dictionaryNotice.length > 0 && dictionary.subarray(0, dictionaryNotice.length).equals(dictionaryNotice), 'CMU notice must remain an exact copy of the dictionary header');
assert((await readFile(path.join(root, assets.model.licenseText))).equals(await readFile(path.join(root, 'node_modules/@huggingface/transformers/LICENSE'))), 'Standard Apache text must match its recorded package source');

for (const source of upstream) {
  let bytes;
  try {
    bytes = await readFile(path.join(root, source.path));
  } catch (error) {
    if (!write || error.code !== 'ENOENT') throw error;
    const response = await fetch(source.url, { signal: AbortSignal.timeout(60_000) });
    assert(response.ok, `HTTP ${response.status}: ${source.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), source.sha256, `Upstream notice hash must match: ${source.url}`);
    await mkdir(path.dirname(path.join(root, source.path)), { recursive: true });
    await writeFile(path.join(root, source.path), bytes);
  }
  assert.equal(hash(bytes), source.sha256, `Upstream notice must retain its exact text: ${source.path}`);
}

if (!write) {
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.equal(inventory.productionClosureSha256, closureHash, 'Production dependencies changed. Regenerate notices with --write.');
  assert((await readFile(path.join(root, 'public/licenses/asset-sources.json'))).equals(await readFile(path.join(root, 'docs/asset-sources.json'))), 'Published asset manifest must exactly match the source manifest');
  assert.deepEqual(inventory.packages.map((entry) => entry.location), closure.map((entry) => entry.location), 'Every production lock entry must have a notice record');
  for (const entry of inventory.packages) {
    assert(entry.texts.length || entry.upstreamTexts.length || entry.status === 'declaration-only', `Missing license evidence: ${entry.name}`);
    for (const record of [entry.declaration, ...(entry.declarationNotice ? [entry.declarationNotice] : []), ...entry.upstreamTexts]) {
      assert.equal(hash(await readFile(path.join(root, record.path))), record.sha256, `Declaration or supplemental notice hash must match: ${record.path}`);
    }
    for (const text of entry.texts) {
      assert.equal(hash(await readFile(path.join(root, text.path))), text.sha256, `Copied notice hash must match: ${text.path}`);
      if (text.source.type === 'installed') {
        let original;
        try {
          original = await readFile(path.join(root, text.source.path));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (original) assert.equal(hash(original), text.sha256, `Installed upstream text must match its public copy: ${text.source.path}`);
      }
    }
  }
  console.log(JSON.stringify({ verifiedPackages: inventory.packages.length, productionClosureSha256: closureHash, qualifications: inventory.qualifications }, null, 2));
  process.exit(0);
}

await mkdir(cache, { recursive: true });
const stage = await mkdtemp(path.join(cache, 'packages-'));
const records = [];
const qualifications = [];

async function legalFiles(directory, relative = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await legalFiles(path.join(directory, entry.name), child));
    else if (entry.isFile() && legalName.test(entry.name)) files.push(child);
  }
  return files;
}

for (const [location, entry] of production) {
  const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const id = `${name.replaceAll('/', '__').replaceAll('@', '')}@${entry.version}`;
  const destination = path.join(stage, id);
  await mkdir(destination, { recursive: true });
  let metadata;
  let originals = [];
  let tarball;
  try {
    metadata = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
    assert.equal(metadata.version, entry.version, `Installed version must match lock: ${location}`);
    originals = await legalFiles(path.join(root, location));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    assert(entry.resolved?.startsWith('https://registry.npmjs.org/'), `Missing package must have a pinned npm registry URL: ${location}`);
    assert(entry.integrity, `Missing package must have a lockfile integrity hash: ${location}`);
    tarball = path.join(cache, `${id}.tgz`);
    let bytes;
    try {
      bytes = await readFile(tarball);
    } catch (cacheError) {
      if (cacheError.code !== 'ENOENT') throw cacheError;
      const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(120_000) });
      assert(response.ok, `HTTP ${response.status}: ${entry.resolved}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(tarball, bytes);
    }
    const integrity = entry.integrity.split(' ').find((value) => value.startsWith('sha512-') || value.startsWith('sha256-'));
    assert(integrity, `Unsupported integrity algorithm: ${location}`);
    const separator = integrity.indexOf('-');
    const digest = createHash(integrity.slice(0, separator)).update(bytes).digest('base64');
    assert.equal(digest, integrity.slice(separator + 1), `Pinned npm archive integrity must match: ${location}`);
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.equal(listing.status, 0, `Archive listing must succeed: ${location}`);
    const members = listing.stdout.trim().split('\n');
    assert(members.every((member) => member.startsWith('package/') && !member.split('/').includes('..')), 'npm archive paths must remain inside package/');
    originals = members.filter((member) => legalName.test(path.posix.basename(member)) && !member.endsWith('/'));
    const result = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'Archive metadata must be readable');
    metadata = JSON.parse(result.stdout);
    assert.equal(metadata.version, entry.version, 'Archive version must match lock');
  }
  const texts = [];
  for (const original of originals) {
    let bytes;
    let source;
    let relative;
    if (tarball) {
      const result = spawnSync('tar', ['-xOzf', tarball, original], { maxBuffer: 20 * 1024 * 1024 });
      assert.equal(result.status, 0, `Archive notice must be readable: ${original}`);
      bytes = result.stdout;
      relative = original.slice('package/'.length);
      source = { type: 'npm-archive', url: entry.resolved, integrity: entry.integrity, member: original };
    } else {
      relative = original;
      source = { type: 'installed', path: `${location}/${original.split(path.sep).join('/')}` };
      bytes = await readFile(path.join(root, location, original));
    }
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    texts.push({ path: `public/licenses/packages/${id}/${relative.split(path.sep).join('/')}`, sha256: hash(bytes), source });
  }
  const declaration = Object.fromEntries(['name', 'version', 'license', 'author', 'contributors', 'repository', 'homepage'].filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]));
  const declarationBytes = Buffer.from(`${JSON.stringify(declaration, null, 2)}\n`);
  await writeFile(path.join(destination, 'package-metadata.json'), declarationBytes);
  const sources = upstream.filter((source) => source.packages?.includes(name) || source.packagePaths?.includes(location) || source.packagePrefixes?.some((prefix) => name.startsWith(prefix)));
  const status = texts.length ? 'package-texts' : sources.length ? 'upstream-texts' : 'declaration-only';
  let declarationNotice;
  if (status === 'declaration-only') {
    assert.equal(name, 'guid-typescript', `A newly missing license body needs review, not a generated grant: ${name}`);
    const note = `${name} ${entry.version}\n\nThe exact npm package declares ISC and author "nicolas". It supplies no copyright or license body. The repository at the npm gitHead is unavailable. The inspected current repository also has no license file. This file preserves the declaration and does not invent a copyright owner, year, or license grant.\n\nSee package-metadata.json and the archive integrity in ../index.json.\n`;
    await writeFile(path.join(destination, 'DECLARATION-NOTICE.txt'), note);
    declarationNotice = { path: `public/licenses/packages/${id}/DECLARATION-NOTICE.txt`, sha256: hash(note) };
    qualifications.push({ package: name, version: entry.version, issue: 'ISC declaration only. No upstream copyright/license body supplied by the exact npm package or inspected repository.' });
  }
  for (const source of sources.filter((source) => source.qualification)) qualifications.push({ package: name, version: entry.version, issue: source.qualification });
  records.push({ name, version: entry.version, location, declaredLicense: entry.license ?? metadata.license ?? null, optional: Boolean(entry.optional), status, npmTarball: entry.resolved, npmIntegrity: entry.integrity, declaration: { path: `public/licenses/packages/${id}/package-metadata.json`, sha256: hash(declarationBytes) }, ...(declarationNotice ? { declarationNotice } : {}), texts, upstreamTexts: sources.map((source) => ({ path: source.path, sha256: source.sha256, url: source.url, ...(source.qualification ? { qualification: source.qualification } : {}) })) });
}

const inventory = {
  schemaVersion: 1,
  scope: 'All non-development entries of package-lock.json, including optional native and Node-only dependencies and packages not imported by the browser. This is a conservative dependency inventory, not an assertion that every package is bundled.',
  productionClosureSha256: closureHash,
  generator: 'node scripts/prepare-licenses.mjs --write',
  qualifications,
  packages: records,
};
await writeFile(path.join(stage, 'index.json'), `${JSON.stringify(inventory, null, 2)}\n`);
const publicPackages = path.dirname(inventoryPath);
try {
  await stat(publicPackages);
  await rename(publicPackages, path.join(cache, `previous-packages-${Date.now()}`));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await rename(stage, publicPackages);
await writeFile(path.join(root, 'public/licenses/asset-sources.json'), await readFile(path.join(root, 'docs/asset-sources.json')));

const relativeLink = (filename) => escaped(filename.replace(/^public\/licenses\//, ''));
const rows = records.map((entry) => {
  const documents = [...entry.texts, ...entry.upstreamTexts];
  const links = documents.map((text) => `<a href="${relativeLink(text.path)}">${escaped(text.path.split('/').slice(3).join('/'))}</a>`).join('<br>');
  return `<tr><td>${escaped(entry.name)}<br><small>${escaped(entry.version)}</small></td><td>${escaped(entry.declaredLicense)}${entry.optional ? '<br><small>Optional dependency</small>' : ''}</td><td>${links || `<a href="${relativeLink(entry.declaration.path.replace('package-metadata.json', 'DECLARATION-NOTICE.txt'))}">Declaration only. No upstream license body supplied.</a>`}<br><a href="${relativeLink(entry.declaration.path)}">Package metadata</a></td></tr>`;
}).join('\n');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Third-party licenses and asset sources</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#18212b}h1,h2{line-height:1.2}a{color:#1557a0}table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{padding:.65rem;border:1px solid #ccd2da;text-align:left;vertical-align:top}td{overflow-wrap:anywhere}th{background:#eef2f6}small{color:#505c69}.notice{padding:1rem;border-left:4px solid #986400;background:#fff8e8}</style></head><body>
<h1>Third-party licenses and asset sources</h1>
<p class="notice">No license has been selected for the original application code. Public visibility does not grant a license. Each third-party component retains its own terms.</p>
<h2>Assets are separate from package code</h2>
<ul><li>The TalkingHead MPFB avatar is CC0 according to its <a href="avatar/TalkingHead-README.md">pinned asset-specific upstream declaration</a>. The <a href="avatar/CC0-1.0.txt">CC0 text</a> accompanies it.</li>
<li>The Kokoro timestamped model and nine voice files match upstream SHA-256 identities. Their separate <a href="assets/Kokoro-timestamped-model-card.md">model card</a> and <a href="assets/Kokoro-voice-model-card.md">voice model card</a> declare Apache-2.0. The <a href="assets/Apache-2.0.txt">standard Apache-2.0 text</a> accompanies them. No standalone upstream model repository LICENSE file was available.</li>
<li>The dictionary retains the <a href="assets/CMUdict-NOTICE.txt">Carnegie Mellon notice</a> in its original header.</li>
<li>The modified vendored HeadTTS code retains its <a href="../headtts/LICENSE">MIT license</a> and <a href="../headtts/NOTICE.txt">modification notice</a>.</li>
<li>Space Grotesk and IBM Plex Mono font texts appear under their @fontsource packages below. Their fonts retain OFL-1.1, not the application code terms.</li></ul>
<p>The <a href="asset-sources.json">asset manifest</a> records pinned URLs, revisions, exact file hashes, and the avatar preparation command. These records identify sources and declarations. They are not a blanket legal clearance of model training data, voice likeness, or every underlying right.</p>
<h2>Inventory scope and qualifications</h2>
<p>The ${records.length} package records cover every non-development lockfile entry, including unused packages, server-only code, and optional native binaries. The deployed browser does not necessarily contain all of them. This inventory includes upstream embedded notices, including ONNX Runtime's complete ThirdPartyNotices.txt and Victory's vendored-library texts.</p>
<ul>${qualifications.map((entry) => `<li>${escaped(entry.package)} ${escaped(entry.version)}. ${escaped(entry.issue)}</li>`).join('')}</ul>
<p><a href="packages/index.json">Machine-readable inventory and exact text hashes</a>. Reproduce with <code>node scripts/prepare-licenses.mjs --write</code>. Verify with <code>node scripts/prepare-licenses.mjs</code>.</p>
<h2>Package license texts</h2><table><thead><tr><th>Package</th><th>Declared terms</th><th>Original texts and metadata</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>\n`;
await writeFile(path.join(root, 'public/licenses/index.html'), html);
console.log(JSON.stringify({ generatedPackages: records.length, productionClosureSha256: closureHash, qualifications }, null, 2));
