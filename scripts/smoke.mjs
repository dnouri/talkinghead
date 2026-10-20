import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.APP_URL || 'http://127.0.0.1:3000/';
const target = new URL(url);
assert.ok(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password, 'APP_URL must be an HTTP(S) URL without credentials.');
assert.ok(target.pathname.endsWith('/'), 'APP_URL must have its canonical trailing slash.');
const pagesContract = process.env.PAGES_CONTRACT === '1';
if (pagesContract) {
  assert.equal(target.pathname, '/talkinghead/');
  assert.equal(target.search + target.hash, '');
}
const origin = target.origin;
const output = resolve(process.env.SMOKE_OUTPUT || 'tmp/smoke');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: [
    ...(process.env.GPU_TEST
      ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface']
      : ['--enable-unsafe-swiftshader']),
    ...(process.env.FORCE_WASM ? ['--disable-webgpu'] : []),
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const evidence = {
  url, startedAtUTC: new Date().toISOString(), sourceRevision: process.env.SOURCE_REVISION || null,
  browserVersion: browser.version(), pagesContract, checks: [], external: [], errors: [], requests: [],
  pages: { documents: [], speechWorkers: [] }, navigations: [], documentLoads: [],
};
page.on('framenavigated', frame => {
  if (frame === page.mainFrame()) evidence.navigations.push({ url: frame.url(), atUTC: new Date().toISOString() });
});
page.on('domcontentloaded', () => {
  evidence.documentLoads.push({ url: page.url(), atUTC: new Date().toISOString() });
});
const responses = new Map();
const expectedFailures = new Set();
page.on('pageerror', error => evidence.errors.push(error.message));
context.on('response', response => {
  responses.set(response.url(), { status: response.status(), headers: response.headers() });
  if (response.status() >= 400 && !expectedFailures.has(new URL(response.url()).pathname)) {
    evidence.errors.push(`HTTP ${response.status()} ${response.url()}`);
  }
});
await context.route('**/*', route => {
  const requestURL = new URL(route.request().url());
  if (['http:', 'https:'].includes(requestURL.protocol)) {
    evidence.requests.push(requestURL.href);
    if (requestURL.origin !== origin) {
      evidence.external.push(requestURL.href);
      return route.abort();
    }
  }
  return route.continue();
});
await context.addInitScript(() => {
  window.speechProof = { ready: [], readyWorkers: [], clips: [], played: [], stopped: [], sent: [] };
  const sourceIDs = new WeakMap();
  let nextSourceID = 0;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (data.type === 'ready') {
          window.speechProof.ready.push(data.data.backend);
          window.speechProof.readyWorkers.push(String(args[0]));
        }
        if (data.type === 'audio') {
          window.speechProof.clips.push({
            ref: data.ref, words: data.data.words, wtimes: data.data.wtimes,
            visemes: data.data.visemes, vtimes: data.data.vtimes,
            vdurations: data.data.vdurations, bytes: data.data.audio.byteLength,
          });
          window.speechProof.wav = data.data.audio.slice(0);
        }
      });
    }
    postMessage(message, ...args) {
      window.speechProof.sent.push({ type: message.type, id: message.id, ref: message.ref });
      const count = window.speechProof.sent.filter(item => item.type === 'synthesize').length;
      if (message.type === 'synthesize' && window.speechProof.failSynthesisAt === count) {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: {
          type: 'error', ref: message.id, error: { name: 'Error', message: 'Injected later-chunk failure.' },
        } })));
        return;
      }
      return super.postMessage(message, ...args);
    }
  };
  const nativeStart = AudioBufferSourceNode.prototype.start;
  const nativeStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (...args) {
    const result = nativeStop.apply(this, args);
    window.speechProof.stopped.push({ id: sourceIDs.get(this), at: this.context.currentTime });
    return result;
  };
  AudioBufferSourceNode.prototype.start = function (...args) {
    const result = nativeStart.apply(this, args);
    const id = nextSourceID++;
    sourceIDs.set(this, id);
    if (this.buffer) {
      const samples = this.buffer.getChannelData(0);
      let energy = 0;
      let peak = 0;
      for (const sample of samples) {
        energy += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      window.speechProof.played.push({
        id, startAt: args[0] ?? this.context.currentTime,
        clipsReceived: window.speechProof.clips.length,
        duration: this.buffer.duration, rms: Math.sqrt(energy / samples.length),
        peak, state: this.context.state, sampleRate: this.buffer.sampleRate,
      });
    }
    return result;
  };
});

function pass(check) {
  evidence.checks.push(check);
  console.log(`PASS ${check}`);
}

async function waitForReady() {
  await page.getByText(/READY · (WASM|WebGPU)/).waitFor({ timeout: 210_000 });
}

async function inspectDocument(response) {
  assert.equal(page.url(), target.href, 'The document must remain at the canonical entry URL.');
  if (!pagesContract) return;
  const headers = await response.allHeaders();
  const document = {
    url: page.url(), status: response.status(),
    coop: headers['cross-origin-opener-policy'] ?? null,
    coep: headers['cross-origin-embedder-policy'] ?? null,
    isolated: await page.evaluate(() => crossOriginIsolated),
  };
  evidence.pages.documents.push(document);
  assert.equal(document.status, 200);
  assert.equal(document.coop, null);
  assert.equal(document.coep, null);
  assert.equal(document.isolated, false);
}

async function inspectPagesRuntime() {
  const document = await page.evaluate(async () => ({
    url: location.href, isolated: crossOriginIsolated,
    controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
    registrations: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map(registration => ({
      scope: registration.scope,
      scripts: [registration.active, registration.waiting, registration.installing].filter(Boolean).map(worker => worker.scriptURL),
    })) : [],
  }));
  evidence.pages.runtime = document;
  assert.equal(document.url, target.href);
  assert.equal(document.isolated, false);
  assert.equal(document.controller, null);
  assert.deepEqual(document.registrations.filter(registration => registration.scope.startsWith(target.href) || target.href.startsWith(registration.scope)), []);
  const workerURL = await page.evaluate(() => window.speechProof.readyWorkers.at(-1));
  const worker = page.workers().find(candidate => candidate.url() === workerURL);
  assert.ok(worker, 'The actual worker that reported speech readiness must be observable.');
  const workerState = await worker.evaluate(() => ({
    url: self.location.href, isolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency,
  }));
  evidence.pages.speechWorkers.push(workerState);
  assert.equal(workerState.isolated, false);
}

try {
  if (pagesContract) {
    const slashless = new URL(target);
    slashless.pathname = slashless.pathname.slice(0, -1);
    const redirect = await context.request.get(slashless.href, { maxRedirects: 0 });
    evidence.pages.redirect = { url: slashless.href, status: redirect.status(), location: redirect.headers().location };
    assert.ok([301, 308].includes(redirect.status()));
    assert.equal(new URL(redirect.headers().location, slashless).href, target.href);
    pass('The project entry redirects to its canonical trailing-slash URL.');
  }
  if (process.env.CHECK_RECOVERY !== '0') {
    const avatarPath = new URL('avatars/avatar.glb', url).pathname;
    expectedFailures.add(avatarPath);
    await context.route('**/avatars/avatar.glb', route => route.fulfill({ status: 503, body: 'Test unavailable avatar' }));
    await inspectDocument(await page.goto(url));
    await page.getByRole('button', { name: 'Retry avatar' }).waitFor();
    await context.unroute('**/avatars/avatar.glb');
    await page.getByRole('button', { name: 'Retry avatar' }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'happy')?.disabled);
    pass('Failed avatar loads can retry without crashing.');

    const dictionaryPath = new URL('headtts/dictionaries/en-us.txt', url).pathname;
    expectedFailures.add(dictionaryPath);
    await context.route('**/headtts/dictionaries/en-us.txt', route => route.fulfill({ status: 503, body: 'Test unavailable dictionary' }));
    await page.getByRole('button', { name: 'Initialize voice engine' }).click();
    await page.getByText(/Engine failed to start\./).waitFor({ timeout: 210_000 });
    assert.match(await page.getByText(/Engine failed to start\./).innerText(), /dictionary.*HTTP 503/s);
    assert.equal(await page.getByRole('button', { name: 'Speak', exact: true }).isDisabled(), true);
    await context.unroute('**/headtts/dictionaries/en-us.txt');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await waitForReady();
    pass('Missing dictionary reports its HTTP failure, disables Speak, and Retry succeeds.');
  } else {
    await inspectDocument(await page.goto(url));
    await page.getByRole('button', { name: 'Initialize voice engine' }).click();
    await waitForReady();
  }
  const backend = await page.evaluate(() => window.speechProof.ready.at(-1));
  assert.match(await page.locator('header').innerText(), new RegExp(`engine ${backend}`, 'i'));
  evidence.backend = backend;
  assert.equal(backend, 'WASM');
  evidence.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
  pass('The bundled model uses WASM and the displayed backend matches.');
  if (pagesContract) {
    await inspectPagesRuntime();
    pass('The document and actual speech worker are non-isolated, with no COOP/COEP or project service worker.');
  }

  const textbox = page.getByRole('textbox', { name: 'Text to speak' });
  const speak = page.getByRole('button', { name: 'Speak', exact: true });
  const phrase = 'Hello, this is a local speech test.';
  await textbox.fill(phrase);
  await speak.click();
  await page.waitForFunction(() => window.speechProof.played.length > 0, null, { timeout: 210_000 });
  await page.screenshot({ path: `${output}/speaking.png` });
  await speak.waitFor({ state: 'visible', timeout: 210_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="subtitle"]').textContent.trim().replace(/\s+/g, ' ') === 'Hello, this is a local speech test.');
  assert.equal(await speak.isEnabled(), true);
  const proof = await page.evaluate(() => window.speechProof);
  assert.ok(proof.clips.length > 0);
  for (const clip of proof.clips) {
    assert.ok(clip.bytes > 44 && clip.visemes.length > 0 && clip.words.length > 0);
    assert.equal(clip.visemes.length, clip.vtimes.length);
    assert.equal(clip.visemes.length, clip.vdurations.length);
    assert.ok(clip.vtimes.every((time, i) => Number.isFinite(time) && (!i || time >= clip.vtimes[i - 1])));
  }
  for (const audio of proof.played) {
    assert.ok(audio.duration > 0 && Number.isFinite(audio.rms) && audio.rms > 0.0001 && audio.peak > 0.001);
    assert.equal(audio.state, 'running');
  }
  const wav = await page.evaluate(() => Array.from(new Uint8Array(window.speechProof.wav)));
  await writeFile(`${output}/generated.wav`, new Uint8Array(wav));
  evidence.firstSpeech = { clips: proof.clips, played: proof.played };
  pass('Real non-silent speech starts in Web Audio, has ordered viseme timings, displays subtitles, and completes.');

  const beforeStream = await page.evaluate(() => ({ clips: window.speechProof.clips.length, played: window.speechProof.played.length }));
  await textbox.fill('Hello, this is a local speech test. Back again.');
  await speak.click();
  await page.waitForFunction(before => window.speechProof.played.length > before, beforeStream.played, { timeout: 210_000 });
  const firstStreamClip = await page.evaluate(index => window.speechProof.played[index], beforeStream.played);
  assert.equal(firstStreamClip.clipsReceived, beforeStream.clips + 1);
  await speak.waitFor({ state: 'visible', timeout: 210_000 });
  assert.equal(await page.evaluate(() => window.speechProof.clips.length), beforeStream.clips + 2);
  assert.equal((await page.getByTestId('subtitle').innerText()).trim().replace(/\s+/g, ' '), 'Hello, this is a local speech test. Back again.');
  pass('The first clip plays before the second clip finishes, and both complete in order.');

  const beforeFailure = await page.evaluate(() => {
    window.speechProof.failSynthesisAt = window.speechProof.sent.filter(item => item.type === 'synthesize').length + 2;
    return window.speechProof.played.length;
  });
  await textbox.fill('Hello, this is a local speech test. This chunk fails.');
  await speak.click();
  await page.getByText('Injected later-chunk failure.', { exact: true }).waitFor({ timeout: 210_000 });
  assert.equal(await speak.isEnabled(), true);
  assert.equal(await page.evaluate(() => window.speechProof.played.length), beforeFailure + 1);
  pass('A later-chunk failure stops partial playback and reports the error.');

  await textbox.fill('This cancelled speech must not play.');
  const sentBefore = await page.evaluate(() => window.speechProof.sent.length);
  const playedBefore = await page.evaluate(() => window.speechProof.played.length);
  await speak.click();
  await page.waitForFunction(before => window.speechProof.sent.slice(before).some(x => x.type === 'synthesize'), sentBefore);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal(await speak.isEnabled(), true);
  await textbox.fill('Back again.');
  await page.getByRole('button', { name: 'Emma', exact: true }).click();
  await page.getByRole('slider', { name: 'Speech speed' }).press('End');
  await speak.click();
  await page.waitForFunction(before => window.speechProof.played.length > before, playedBefore, { timeout: 210_000 });
  await speak.waitFor({ state: 'visible', timeout: 210_000 });
  const afterCancel = await page.evaluate(() => window.speechProof);
  assert.equal(afterCancel.played.length, playedBefore + 1);
  const cancelledIDs = afterCancel.sent.filter(x => x.type === 'cancel').map(x => x.ref);
  assert.ok(cancelledIDs.length > 0);
  assert.equal((await page.getByTestId('subtitle').innerText()).trim().replace(/\s+/g, ' '), 'Back again.');
  pass('Stop during generation suppresses cancelled speech, then a different voice and speed can speak.');

  await textbox.fill('Stop this speech during playback, before it reaches the end.');
  await page.getByRole('slider', { name: 'Speech speed' }).press('Home');
  const playingBefore = afterCancel.played.length;
  await speak.click();
  await page.waitForFunction(before => window.speechProof.played.length > before, playingBefore, { timeout: 210_000, polling: 10 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const stoppedSubtitle = await page.getByTestId('subtitle').innerText();
  const playback = await page.evaluate(() => window.speechProof);
  const lastPlayed = playback.played.at(-1);
  assert.ok(playback.stopped.some(stop => stop.id === lastPlayed.id && stop.at < lastPlayed.startAt + lastPlayed.duration));
  evidence.cancellation = { cancelledIDs, played: playback.played, stopped: playback.stopped };
  await page.waitForTimeout(1500);
  assert.equal(await speak.isEnabled(), true);
  assert.equal(await page.getByTestId('subtitle').innerText(), stoppedSubtitle);
  pass('Stop halts the native audio source before its end and prevents late subtitle callbacks.');

  await page.getByRole('button', { name: 'happy', exact: true }).click();
  await page.getByRole('button', { name: 'thumbs up', exact: true }).click();
  await page.getByRole('button', { name: 'head', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'happy', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: `${output}/desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const avatarBox = await page.getByLabel('Animated avatar').boundingBox();
  const controlsBox = await page.getByRole('complementary', { name: 'Avatar controls' }).boundingBox();
  assert.ok(avatarBox && controlsBox && avatarBox.y + avatarBox.height < controlsBox.y);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${output}/mobile.png` });
  pass('Mood, gesture, camera, and mobile layout remain usable.');
  if (pagesContract) {
    await inspectPagesRuntime();
    const paths = evidence.requests.map(request => new URL(request).pathname);
    for (const path of [
      'avatars/avatar.glb', 'models/kokoro/config.json', 'models/kokoro/tokenizer.json',
      'models/kokoro/tokenizer_config.json', 'models/kokoro/onnx/model_quantized.onnx',
      'headtts/dictionaries/en-us.txt', 'models/kokoro/voices/af_bella.bin', 'models/kokoro/voices/bf_emma.bin',
    ]) assert.ok(paths.includes(new URL(path, target).pathname), `The browser must request ${path} under the project mount.`);
    assert.ok(paths.some(path => path.startsWith(`${target.pathname}assets/`) && path.endsWith('.wasm')));
    assert.ok(paths.some(path => path.startsWith(`${target.pathname}assets/`) && path.endsWith('.mjs')));
    pass('The deployed tokenizer, configuration, model, voices, dictionary, avatar, and WASM runtime load from the project mount.');
    assert.equal(evidence.documentLoads.length, 1, 'The app must not perform setup or background reloads.');
    assert.equal(await textbox.inputValue(), 'Stop this speech during playback, before it reaches the end.');
    await inspectDocument(await page.reload());
    await page.getByRole('button', { name: 'Initialize voice engine' }).click();
    await waitForReady();
    await inspectPagesRuntime();
    assert.equal(evidence.documentLoads.length, 2, 'Only the explicit repeat navigation may reload the document.');
    for (const response of responses.values()) {
      assert.equal(response.headers['cross-origin-opener-policy'], undefined);
      assert.equal(response.headers['cross-origin-embedder-policy'], undefined);
    }
    pass('A repeat visit initializes without a service worker or isolation setup reload, and all observed responses omit COOP/COEP.');
  }
  assert.deepEqual(evidence.external, []);
  assert.deepEqual(evidence.errors, []);
  pass('All browser requests stay on this origin with no unexpected HTTP failures or uncaught errors.');
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL';
  evidence.failure = error.stack;
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/failure.txt`, await page.locator('body').innerText().catch(() => 'Page unavailable'));
  throw error;
} finally {
  evidence.finishedAtUTC = new Date().toISOString();
  evidence.responses = Array.from(responses, ([url, response]) => ({
    url, status: response.status,
    coop: response.headers['cross-origin-opener-policy'] ?? null,
    coep: response.headers['cross-origin-embedder-policy'] ?? null,
  }));
  await writeFile(`${output}/result.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
