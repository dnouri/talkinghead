import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const write = args.includes('--write');
assert(args.every((arg) => arg === '--write'), 'Usage: node scripts/prepare-avatar.mjs [--write]');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/asset-sources.json'), 'utf8'));
const avatar = manifest.avatar;
const cache = path.join(root, 'tmp/publish/assets/prepare-avatar');
const tool = path.join(cache, 'tool');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(tool, { recursive: true });

async function verifiedDownload(record, destination) {
  let bytes;
  try {
    bytes = await readFile(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(record.url, { signal: AbortSignal.timeout(120_000) });
    assert(response.ok, `Download failed with HTTP ${response.status}: ${record.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(bytes), record.sha256, `Upstream hash mismatch: ${record.url}`);
    await writeFile(`${destination}.download`, bytes);
    await rename(`${destination}.download`, destination);
  }
  assert.equal(sha256(bytes), record.sha256, `Cached input hash mismatch. Remove ${destination} and retry.`);
  return bytes;
}

function glb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'Input must be a GLB');
  assert.equal(bytes.readUInt32LE(4), 2, 'Input must use glTF 2.0');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length must match its header');
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'First GLB chunk must contain JSON');
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
}

const source = await verifiedDownload(avatar.source, path.join(cache, 'source.glb'));
assert.equal(source.length, avatar.source.bytes, 'Source size must match');
const declaration = await verifiedDownload(avatar.declaration, path.join(cache, 'TalkingHead-README.md'));
assert(declaration.toString('utf8').includes(avatar.declaration.quote), 'Pinned README must contain the asset-specific CC0 declaration');

const lock = await readFile(path.join(root, avatar.preparation.toolchainLock.path));
assert.equal(sha256(lock), avatar.preparation.toolchainLock.sha256, 'Toolchain lock hash must match');
const toolPackage = { private: true, dependencies: { [avatar.preparation.tool]: avatar.preparation.version } };
await writeFile(path.join(tool, 'package.json'), `${JSON.stringify(toolPackage, null, 2)}\n`);
await writeFile(path.join(tool, 'package-lock.json'), lock);
let installed;
try {
  installed = JSON.parse(await readFile(path.join(tool, 'node_modules/@gltf-transform/cli/package.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (installed?.version !== avatar.preparation.version) {
  const result = spawnSync('npm', ['ci', '--prefix', tool, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: cache, stdio: 'inherit' });
  assert.equal(result.status, 0, 'Isolated, locked tool installation must succeed');
}
for (const [name, expected] of [
  ['@gltf-transform/cli', avatar.preparation.version],
  ['@gltf-transform/core', avatar.preparation.environment.gltfTransformCore],
  ['sharp', avatar.preparation.environment.sharp],
  ['meshoptimizer', avatar.preparation.environment.meshoptimizer],
]) {
  const metadata = JSON.parse(await readFile(path.join(tool, 'node_modules', name, 'package.json'), 'utf8'));
  assert.equal(metadata.version, expected, `${name} version must match the recorded toolchain`);
}

const outputs = [];
for (const pass of [1, 2]) {
  const destination = path.join(cache, `avatar-${pass}.glb`);
  const result = spawnSync(process.execPath, [
    path.join(tool, 'node_modules/@gltf-transform/cli/bin/cli.js'),
    'optimize', path.join(cache, 'source.glb'), destination, ...avatar.preparation.arguments,
  ], { cwd: cache, stdio: 'inherit' });
  assert.equal(result.status, 0, 'Avatar optimization must succeed');
  const bytes = await readFile(destination);
  assert.equal(sha256(bytes), avatar.output.sha256, `Conversion pass ${pass} must reproduce the recorded output hash`);
  assert.equal(bytes.length, avatar.output.bytes, 'Optimized size must match');
  outputs.push(bytes);
}
assert(outputs[0].equals(outputs[1]), 'Two independent conversions must be byte-identical');
const before = glb(source);
const after = glb(outputs[0]);
assert.deepEqual(after.nodes.map((node) => node.name), before.nodes.map((node) => node.name), 'Node names and order must survive');
for (const [index, node] of before.nodes.entries()) {
  const result = after.nodes[index];
  assert.deepEqual(result.children ?? [], node.children ?? [], `Node hierarchy must survive: ${node.name}`);
  if (node.mesh === undefined) {
    for (const [field, fallback] of [['translation', [0, 0, 0]], ['rotation', [0, 0, 0, 1]], ['scale', [1, 1, 1]]]) {
      const actual = result[field] ?? fallback;
      for (const [axis, value] of (node[field] ?? fallback).entries()) {
        assert(Math.abs(actual[axis] - value) <= 1e-5, `Rig transform must survive: ${node.name}.${field}`);
      }
    }
  }
  if (node.skin !== undefined) {
    assert.deepEqual(after.skins[result.skin].joints, before.skins[node.skin].joints, `Skin joint order must survive: ${node.name}`);
  }
}
assert.equal(after.meshes.length, before.meshes.length, 'Mesh count must survive');
for (const [index, mesh] of before.meshes.entries()) {
  const result = after.meshes[index];
  assert.equal(result.name, mesh.name, 'Mesh names must survive');
  assert.deepEqual(result.extras, mesh.extras, `Morph names must survive: ${mesh.name}`);
  assert.equal(result.primitives.length, mesh.primitives.length, 'Primitive count must survive');
  for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
    const output = result.primitives[primitiveIndex];
    assert.equal(after.accessors[output.indices].count, before.accessors[primitive.indices].count, 'Index count must survive');
    assert.equal(after.accessors[output.attributes.POSITION].count, before.accessors[primitive.attributes.POSITION].count, 'Vertex count must survive');
    assert.equal(output.targets?.length ?? 0, primitive.targets?.length ?? 0, 'Morph target count must survive');
  }
}
assert.deepEqual(after.images.map((image) => image.name), before.images.map((image) => image.name), 'Texture names must survive');
assert(after.images.every((image) => image.mimeType === 'image/webp'), 'Textures must use WebP');
assert.deepEqual(after.extensionsRequired, ['EXT_meshopt_compression', 'EXT_texture_webp', 'KHR_mesh_quantization'], 'Existing loader extensions must remain sufficient');

const destination = path.join(root, avatar.path);
if (write) {
  await copyFile(path.join(cache, 'avatar-1.glb'), `${destination}.prepared`);
  await rename(`${destination}.prepared`, destination);
} else {
  assert.equal(sha256(await readFile(destination)), avatar.output.sha256, 'Public avatar must match the manifest. Use --write to replace it after verification.');
}
console.log(JSON.stringify({
  action: write ? 'verified and replaced' : 'verified',
  path: avatar.path,
  bytes: outputs[0].length,
  sha256: sha256(outputs[0]),
  deterministicPasses: outputs.length,
  nodes: after.nodes.length,
  meshes: after.meshes.length,
  morphTargets: after.meshes.map((mesh) => ({ mesh: mesh.name, count: mesh.primitives[0].targets?.length ?? 0 })),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
}, null, 2));
