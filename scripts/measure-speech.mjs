import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem, type, version } from 'node:os';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.MEASURE_OUTPUT || 'tmp/speech-measurement');
const count = Number(process.env.RUNS || 5);
assert.ok(Number.isSafeInteger(count) && count > 0, 'RUNS must be a positive integer.');
const targets = [
  ...(process.env.BEFORE_URL ? [{ label: 'before', url: process.env.BEFORE_URL, revision: process.env.BEFORE_REVISION }] : []),
  { label: process.env.BEFORE_URL ? 'after' : 'current', url: process.env.APP_URL || 'http://127.0.0.1:3000/', revision: process.env.SOURCE_REVISION || process.env.GITHUB_SHA },
];
for (const target of targets) {
  const url = new URL(target.url);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname.endsWith('/'), 'Measurement URLs must be canonical HTTP(S) directory URLs without credentials.');
  target.url = url.href;
  target.hostKind = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : 'remote';
}
const phrase = 'Hello, this is a local speech test. Back again.';
const startedAtUTC = new Date().toISOString();
const launchArgs = ['--disable-webgpu', '--enable-unsafe-swiftshader'];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: launchArgs,
});
const cdp = await browser.newBrowserCDPSession();
const samples = [];
const failures = [];
const environment = {
  node: process.version,
  host: { os: type(), platform: platform(), release: release(), version: version(), arch: arch(), cpuModels: [...new Set(cpus().map(cpu => cpu.model))], logicalCPUs: cpus().length, totalMemoryBytes: totalmem() },
  browser: { version: browser.version(), headless: true, requestedArgs: launchArgs, requestedExecutable: process.env.CHROMIUM_PATH || chromium.executablePath() },
};
const cache = {
  browser: 'A fresh non-persistent browser context per sample, with no prior cookies, HTTP cache, IndexedDB, or application storage.',
  withinSample: 'Ordinary browser HTTP caching is enabled within each context. Initialization precedes speech.',
  betweenSamples: 'One browser process is reused. Contexts are closed between samples. Targets alternate when BEFORE_URL is supplied.',
  upstream: 'Server, proxy/CDN, operating-system, and filesystem caches are not cleared or assumed cold. A fresh context does not reset them.',
};
try {
  environment.browser.cdpVersion = await cdp.send('Browser.getVersion');
  environment.browser.commandLine = (await cdp.send('Browser.getBrowserCommandLine')).arguments;
  for (const target of targets) {
    if (target.revision) {
      assert.match(target.revision, /^[a-f0-9]{40}$/i, 'Source revision must be a full Git SHA.');
      target.sourceRevision = { revision: target.revision, source: target.label === 'before' ? 'BEFORE_REVISION' : process.env.SOURCE_REVISION ? 'SOURCE_REVISION' : 'GITHUB_SHA' };
    } else {
      const infoURL = new URL('build-info.json', target.url);
      const response = await fetch(infoURL, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      assert.ok(response.ok, `Set a source revision or serve build-info.json. HTTP ${response.status} from ${infoURL}.`);
      const info = await response.json();
      assert.match(info.revision, /^[a-f0-9]{40}$/i, 'build-info.json must contain a full revision SHA.');
      target.sourceRevision = { revision: info.revision, source: infoURL.href, buildInfo: info };
    }
    delete target.revision;
  }
  for (let repetition = 0; repetition < count; repetition++) {
    for (const target of targets) {
      const sampleStartedAtUTC = new Date().toISOString();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      context.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
      await page.addInitScript(() => {
        window.measurement = { audioReplies: 0, workers: 0 };
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            window.measurement.workers++;
            this.addEventListener('message', ({ data }) => {
              if (data.type === 'ready') {
                window.measurement.ready = performance.now();
                window.measurement.speechWorkerURL = String(args[0]);
              }
              if (data.type === 'audio') {
                window.measurement.audioReplies++;
                window.measurement.firstWav ??= data.data.audio.slice(0);
              }
            });
          }
        };
        const nativeStart = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          const result = nativeStart.apply(this, args);
          if (this.buffer && window.measurement.firstAudio === undefined) {
            window.measurement.firstAudio = performance.now();
            window.measurement.generatedAtFirstAudio = window.measurement.audioReplies;
            window.measurement.duration = this.buffer.duration;
          }
          return result;
        };
        document.addEventListener('click', event => {
          const label = event.target.closest('button')?.textContent.trim();
          if (label === 'Initialize voice engine') window.measurement.initializeClick = performance.now();
          if (label === 'Speak') window.measurement.speakClick = performance.now();
        }, true);
      });
      try {
        const response = await page.goto(target.url);
        assert.equal(page.url(), target.url);
        const headers = await response.allHeaders();
        await page.getByRole('button', { name: 'Initialize voice engine' }).click();
        await page.getByText('READY · WASM', { exact: true }).waitFor({ timeout: 210_000 });
        const speechWorkerURL = await page.evaluate(() => window.measurement.speechWorkerURL);
        const speechWorker = page.workers().find(worker => worker.url() === speechWorkerURL);
        assert.ok(speechWorker, 'The actual speech worker must be observable.');
        const worker = await speechWorker.evaluate(() => ({ url: self.location.href, isolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency }));
        await page.getByRole('textbox', { name: 'Text to speak' }).fill(phrase);
        const beforeCPU = await cdp.send('SystemInfo.getProcessInfo');
        await page.getByRole('button', { name: 'Speak', exact: true }).click();
        await page.waitForFunction(() => window.measurement.firstAudio !== undefined, null, { timeout: 210_000 });
        const afterCPU = await cdp.send('SystemInfo.getProcessInfo');
        const measured = await page.evaluate(() => ({
          ...window.measurement,
          firstWav: Array.from(new Uint8Array(window.measurement.firstWav)),
          isolated: crossOriginIsolated,
          hardwareConcurrency: navigator.hardwareConcurrency,
        }));
        assert.deepEqual(errors, []);
        assert.ok(measured.duration > 0 && measured.firstWav.length > 44);
        const cpuBefore = new Map(beforeCPU.processInfo.map(process => [process.id, process.cpuTime]));
        const rendererCPUSeconds = afterCPU.processInfo.filter(process => process.type === 'renderer')
          .reduce((sum, process) => sum + process.cpuTime - (cpuBefore.get(process.id) ?? process.cpuTime), 0);
        const sample = {
          ...target, repetition, startedAtUTC: sampleStartedAtUTC, finishedAtUTC: new Date().toISOString(), finalURL: page.url(),
          isolated: measured.isolated, hardwareConcurrency: measured.hardwareConcurrency, worker, workers: measured.workers,
          coop: headers['cross-origin-opener-policy'] ?? null, coep: headers['cross-origin-embedder-policy'] ?? null,
          initializeMS: measured.ready - measured.initializeClick,
          firstAudioMS: measured.firstAudio - measured.speakClick,
          generatedAtFirstAudio: measured.generatedAtFirstAudio,
          rendererCPUSeconds, errors,
        };
        assert.ok(Number.isFinite(sample.initializeMS) && sample.initializeMS >= 0);
        assert.ok(Number.isFinite(sample.firstAudioMS) && sample.firstAudioMS >= 0);
        await writeFile(`${output}/${target.label}-${repetition}.wav`, new Uint8Array(measured.firstWav));
        samples.push(sample);
        console.log(JSON.stringify(sample));
      } catch (error) {
        failures.push({ target: target.url, repetition, startedAtUTC: sampleStartedAtUTC, failedAtUTC: new Date().toISOString(), errors, failure: error.stack });
        throw error;
      } finally { await context.close(); }
    }
  }
} catch (error) {
  if (!failures.length) failures.push({ failedAtUTC: new Date().toISOString(), failure: error.stack });
  throw error;
} finally {
  const summary = targets.map(target => {
    const summarize = key => {
      const values = samples.filter(sample => sample.label === target.label).map(sample => sample[key]).sort((a, b) => a - b);
      if (!values.length) return null;
      const middle = Math.floor(values.length / 2);
      const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      return { median, min: values[0], max: values.at(-1), count: values.length };
    };
    return { ...target, initializeMS: summarize('initializeMS'), firstAudioMS: summarize('firstAudioMS') };
  });
  await writeFile(`${output}/result.json`, JSON.stringify({
    result: failures.length ? 'FAIL' : 'PASS', startedAtUTC, finishedAtUTC: new Date().toISOString(),
    phrase, count, environment, cache,
    timingDefinitions: { initializeMS: 'Initialize click to the speech worker ready message.', firstAudioMS: 'Speak click to the first native AudioBufferSourceNode.start call, not acoustic output or full generation.', workers: 'Worker objects created by the document, not WASM thread count.', rendererCPUSeconds: 'Renderer-process CPU delta during the first-audio interval, not total browser or system CPU.' },
    samples, failures, summary,
  }, null, 2));
  await browser.close();
}
