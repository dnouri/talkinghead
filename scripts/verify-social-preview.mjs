import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

const metadata = Object.freeze({
  canonical: 'https://dnouri.github.io/talkinghead/',
  title: 'TalkingHead | Your browser has a mouth now.',
  description: 'Give a 3D avatar your words. It reads them with lip sync and subtitles using local English speech. No API key.',
  imageURL: 'https://dnouri.github.io/talkinghead/social-preview-v1.png',
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: 'Yellow TalkingHead card with a 3D avatar saying "Is this tab on?", the headline "Your browser has a mouth now.", and "Local speech. No API key."',
});
const metaFields = new Map([
  ['description', ['name', metadata.description]],
  ['og:type', ['property', 'website']],
  ['og:url', ['property', metadata.canonical]],
  ['og:site_name', ['property', 'TalkingHead']],
  ['og:title', ['property', metadata.title]],
  ['og:description', ['property', metadata.description]],
  ['og:image', ['property', metadata.imageURL]],
  ['og:image:type', ['property', metadata.type]],
  ['og:image:width', ['property', String(metadata.width)]],
  ['og:image:height', ['property', String(metadata.height)]],
  ['og:image:alt', ['property', metadata.alt]],
  ['twitter:card', ['name', 'summary_large_image']],
  ['twitter:title', ['name', metadata.title]],
  ['twitter:description', ['name', metadata.description]],
  ['twitter:image', ['name', metadata.imageURL]],
  ['twitter:image:alt', ['name', metadata.alt]],
  ['og:locale', ['property', 'en_US']],
]);

function normalize(value) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, name) => {
    if (!name.startsWith('#')) return entities[name.toLowerCase()];
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    assert.ok(point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff), 'Invalid HTML character reference.');
    return String.fromCodePoint(point);
  }).replace(/\s+/g, ' ').trim();
}

function attributes(source) {
  const result = new Map();
  const pattern = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let offset = 0;
  while (offset < source.length) {
    if (/^\s*\/?\s*$/.test(source.slice(offset))) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    assert.ok(match, 'Malformed HTML head attributes.');
    const key = match[1].toLowerCase();
    assert.ok(!result.has(key), `Duplicate HTML attribute ${key}.`);
    result.set(key, normalize(match[2] ?? match[3] ?? match[4] ?? ''));
    offset = pattern.lastIndex;
  }
  return result;
}

function parseMetadata(html) {
  const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi, '');
  assert.ok(!/<!--|<(?:script|style)\b/i.test(markup), 'Unterminated comment, script, or style in the HTML.');
  const openings = [...markup.matchAll(/<head\b[^>]*>/gi)];
  const closings = [...markup.matchAll(/<\/head\s*>/gi)];
  assert.equal(openings.length, 1, 'Exactly one raw HTML head is required.');
  assert.equal(closings.length, 1, 'Exactly one raw HTML head closing tag is required.');
  const start = openings[0].index + openings[0][0].length;
  const end = closings[0].index;
  assert.ok(start < end && !/<body\b/i.test(markup.slice(0, end)), 'Metadata must precede the body in the raw HTML head.');
  const head = markup.slice(start, end);
  assert.ok(!/<(?:template|noscript)\b/i.test(head), 'Preview metadata must not depend on template or noscript content.');
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)];
  assert.equal(titles.length, 1, 'Exactly one raw head title is required.');
  const title = normalize(titles[0][1]);
  assert.equal(title, metadata.title, 'Browser title must match the preview title.');
  const tags = head.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '');
  const values = new Map();
  const canonicals = [];
  for (const tag of tags.matchAll(/<(meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = attributes(tag[2]);
    if (tag[1].toLowerCase() === 'link') {
      if (attrs.get('rel')?.toLowerCase().split(' ').includes('canonical')) canonicals.push(attrs.get('href'));
      continue;
    }
    const identifiers = new Set([attrs.get('name')?.toLowerCase(), attrs.get('property')?.toLowerCase()]);
    for (const key of identifiers) {
      if (!metaFields.has(key)) continue;
      const [attribute, expected] = metaFields.get(key);
      assert.ok(!values.has(key), `Duplicate critical metadata ${key}.`);
      assert.equal(attrs.get(attribute)?.toLowerCase(), key, `${key} must use the ${attribute} attribute.`);
      assert.ok(!attrs.has(attribute === 'name' ? 'property' : 'name'), `${key} must have one metadata identifier.`);
      assert.equal(attrs.get('content'), expected, `${key} must match the static preview contract.`);
      values.set(key, attrs.get('content'));
    }
  }
  assert.equal(canonicals.length, 1, 'Exactly one canonical link is required.');
  assert.equal(canonicals[0], metadata.canonical, 'Canonical URL must match the public project URL.');
  for (const key of metaFields.keys()) {
    if (key !== 'og:locale') assert.ok(values.has(key), `Missing raw head metadata ${key}.`);
  }
  const canonical = new URL(canonicals[0]);
  for (const key of ['og:image', 'twitter:image']) {
    const image = new URL(values.get(key));
    assert.equal(image.protocol, 'https:', `${key} must be an absolute HTTPS URL.`);
    assert.equal(image.origin, canonical.origin, `${key} must use the canonical origin.`);
    assert.ok(image.pathname.startsWith(canonical.pathname), `${key} must stay within the canonical project prefix.`);
    assert.equal(image.username + image.password + image.search + image.hash, '', `${key} must not contain credentials, a query, or a fragment.`);
  }
  return {
    canonical: canonicals[0], title, description: values.get('description'),
    imageURL: values.get('og:image'), width: Number(values.get('og:image:width')),
    height: Number(values.get('og:image:height')), type: values.get('og:image:type'), alt: values.get('og:image:alt'),
  };
}

function parsePNG(bytes, preview) {
  assert.ok(bytes.length < 5_000_000, 'PNG must be under 5 MB.');
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG signature.');
  const chunks = {};
  let offset = 8;
  let header;
  let dataBytes = 0;
  let dataEnded = false;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'Truncated PNG chunk header or CRC.');
    const length = bytes.readUInt32BE(offset);
    assert.ok(length <= 0x7fffffff && length <= bytes.length - offset - 12, 'PNG chunk length exceeds the response boundary.');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    assert.match(type, /^[A-Za-z]{2}[A-Z][A-Za-z]$/, 'Invalid PNG chunk type.');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length), `Invalid PNG ${type} CRC.`);
    assert.ok(header || type === 'IHDR', 'IHDR must be the first PNG chunk.');
    assert.ok(!chunks.IEND, 'No PNG bytes may follow IEND.');
    assert.ok(type !== 'tRNS', 'An opaque preview PNG must not have a tRNS transparency chunk.');
    assert.ok(!['acTL', 'fcTL', 'fdAT'].includes(type), 'The preview must be a static PNG.');
    if (type[0] === type[0].toUpperCase()) assert.ok(['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type), `Unknown critical PNG chunk ${type}.`);
    if (type === 'IHDR') {
      assert.ok(!header && offset === 8 && length === 13, 'PNG must have exactly one 13-byte initial IHDR.');
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
      assert.equal(header.width, preview.width, 'PNG width must match metadata.');
      assert.equal(header.height, preview.height, 'PNG height must match metadata.');
      assert.equal(header.bitDepth, 8, 'The preview must be an 8-bit RGB PNG.');
      assert.equal(header.colorType, 2, 'Opaque PNG evidence requires RGB color type 2 with no alpha channel.');
      assert.equal(data[10], 0, 'Invalid PNG compression method.');
      assert.equal(data[11], 0, 'Invalid PNG filter method.');
      assert.ok(header.interlace === 0 || header.interlace === 1, 'Invalid PNG interlace method.');
    } else if (type === 'PLTE') {
      assert.ok(!chunks.PLTE && !chunks.IDAT && length > 0 && length <= 768 && length % 3 === 0, 'Invalid PNG palette or palette order.');
    } else if (type === 'IDAT') {
      assert.ok(!dataEnded, 'PNG IDAT chunks must be consecutive.');
      dataBytes += length;
    } else if (chunks.IDAT) dataEnded = true;
    if (type === 'IEND') assert.ok(length === 0 && dataBytes > 0, 'PNG IEND must be empty and follow image data.');
    chunks[type] = (chunks[type] || 0) + 1;
    offset += length + 12;
  }
  assert.ok(header && chunks.IEND === 1 && dataBytes > 0, 'PNG requires IHDR, nonempty IDAT data, and a final IEND.');
  return {
    ...header, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunks,
    opacityEvidence: 'RGB color type 2 with no alpha channel or tRNS chunk.',
    verification: 'Signature, IHDR, chunk boundaries, order, and CRCs checked. Compressed pixels are not decoded.',
  };
}

function parseTarget(input) {
  const url = new URL(input);
  const canonical = new URL(metadata.canonical);
  assert.equal(url.pathname, canonical.pathname, 'Target must use the canonical project path and trailing slash.');
  assert.equal(url.username + url.password + url.search + url.hash, '', 'Target must not contain credentials, a query, or a fragment.');
  if (url.href === canonical.href) return { url, mode: 'production' };
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Target must be the production URL or an HTTP loopback fixture.');
  return { url, mode: 'loopback-fixture' };
}

async function getBytes(url, expectedType, limit) {
  const response = await fetch(url, {
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { Accept: expectedType, 'Accept-Encoding': 'identity', 'User-Agent': 'TalkingHead-social-preview-check/1.0' },
  });
  assert.equal(response.status, 200, `${url} must return HTTP 200 without redirects.`);
  const contentType = response.headers.get('content-type') || '';
  assert.equal(contentType.split(';')[0].trim().toLowerCase(), expectedType, `${url} must return ${expectedType}.`);
  const encoding = response.headers.get('content-encoding');
  assert.ok(!encoding || encoding.toLowerCase() === 'identity', 'The raw-response check requires an uncompressed HTTP transfer.');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    assert.match(declaredLength, /^\d+$/, 'Invalid HTTP Content-Length.');
    assert.ok(Number(declaredLength) < limit, `Response must be under ${limit} bytes.`);
  }
  const parts = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.length;
    assert.ok(length < limit, `Response must be under ${limit} bytes.`);
    parts.push(part);
  }
  if (declaredLength !== null) assert.equal(length, Number(declaredLength), 'HTTP Content-Length must match the received bytes.');
  return { body: Buffer.concat(parts), status: response.status, contentType, bytes: length };
}

const proof = { ok: false, target: process.argv[2] || process.env.APP_URL || metadata.canonical };
try {
  assert.ok(process.argv.length <= 3, 'Usage: node scripts/verify-social-preview.mjs [URL]');
  const target = parseTarget(proof.target);
  proof.mode = target.mode;
  const page = await getBytes(target.url, 'text/html', 1_000_000);
  proof.html = { status: page.status, contentType: page.contentType, bytes: page.bytes, source: 'Raw HTTP head, no JavaScript rendering.' };
  proof.metadata = parseMetadata(new TextDecoder('utf-8', { fatal: true }).decode(page.body));
  const publishedImage = new URL(proof.metadata.imageURL);
  const imageTarget = target.mode === 'production' ? publishedImage : new URL(publishedImage.pathname, target.url.origin);
  proof.imageMapping = { publishedURL: publishedImage.href, fetchedURL: imageTarget.href };
  const image = await getBytes(imageTarget, proof.metadata.type, 5_000_000);
  proof.image = { status: image.status, contentType: image.contentType, ...parsePNG(image.body, proof.metadata) };
  proof.ok = true;
} catch (error) {
  proof.error = error.message;
  process.exitCode = 1;
}
console.log(JSON.stringify(proof));
