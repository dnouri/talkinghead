import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = new URL(process.env.CARD_URL || 'http://127.0.0.1:3000/docs/social-preview/card.html');
assert.ok(source.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname), 'Render the local card source.');
const output = fileURLToPath(new URL('../../tmp/social-preview/render/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  await page.goto(source.href, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
  });
  const layout = await page.evaluate(() => ({
    fontsLoaded: document.fonts.check('700 102px "Space Grotesk"') && document.fonts.check('500 26px "Space Grotesk"'),
    resources: performance.getEntriesByType('resource').map(resource => resource.name),
    text: [...document.querySelectorAll('[data-safe]')].map(element => {
      const rect = element.getBoundingClientRect();
      return { name: element.dataset.safe, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  }));
  assert.ok(layout.fontsLoaded, 'Packaged fonts must load.');
  assert.deepEqual(errors, []);
  assert.ok(layout.resources.every(url => new URL(url).origin === source.origin), 'Use only local artwork and fonts.');
  for (const rect of layout.text) assert.ok(rect.left >= 36 && rect.top >= 19 && rect.right <= 1164 && rect.bottom <= 611, `${rect.name} must survive a small edge crop.`);
  const png = await page.screenshot({ path: `${output}card.png`, type: 'png', omitBackground: false });
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.equal(png[25], 2, 'The screenshot must be an opaque RGB PNG.');
  assert.ok(png.length < 5_000_000);
  await page.setViewportSize({ width: 600, height: 315 });
  await page.addStyleTag({ content: 'body { transform: scale(.5); transform-origin: top left; }' });
  await page.screenshot({ path: `${output}thumbnail.png`, type: 'png' });
  const proof = { browser: browser.version(), source: source.href, width: 1200, height: 630, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), layout, errors };
  await writeFile(`${output}proof.json`, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally { await browser.close(); }
