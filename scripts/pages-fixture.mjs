import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '4173' }, root: { type: 'string', default: 'dist' } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
const base = process.env.BASE_PATH || '/talkinghead/';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(base)) throw new Error('BASE_PATH must be a slash-terminated project path.');
const root = await realpath(resolve(values.root));
if (!(await stat(root)).isDirectory()) throw new Error('The fixture root must be a directory.');
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'], ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.ico', 'image/x-icon'],
  ['.glb', 'model/gltf-binary'], ['.gltf', 'model/gltf+json'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.wav', 'audio/wav'],
]);

const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const queryAt = request.url.indexOf('?');
    const rawPath = queryAt < 0 ? request.url : request.url.slice(0, queryAt);
    const query = queryAt < 0 ? '' : request.url.slice(queryAt);
    let pathname;
    try { pathname = decodeURIComponent(rawPath); } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) {
      response.writeHead(403).end();
      return;
    }
    if (pathname === base.slice(0, -1)) {
      response.writeHead(301, { Location: `${base}${query}` }).end();
      return;
    }
    if (!pathname.startsWith(base)) {
      response.writeHead(404).end();
      return;
    }
    const file = await realpath(resolve(root, pathname.slice(base.length) || 'index.html'));
    const withinRoot = relative(root, file);
    if (isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': mime.get(extname(file).toLowerCase()) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(file), response);
  } catch (error) {
    if (response.headersSent) response.destroy(error);
    else if (['ENOENT', 'ENOTDIR'].includes(error.code)) response.writeHead(404).end();
    else if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) response.writeHead(403).end();
    else {
      console.error(error);
      response.writeHead(500).end();
    }
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Pages fixture http://127.0.0.1:${server.address().port}${base}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
