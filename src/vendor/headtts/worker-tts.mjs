import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, env, LogLevel } from '@huggingface/transformers';
import { Language } from './language-en-us.mjs';
import * as utils from './utils.mjs';

const settings = {
  styleDim: 256,
  frameRate: 40,
  audioSampleRate: 24000,
  deltaStart: -10,
  deltaEnd: 10
};
const voices = new Map();
const filesProgress = new Map();
const queue = [];
let model;
let tokenizer;
let language;
let current;
let started = false;
let ready = false;
let processing = false;

self.onmessage = ({ data: message }) => {
  if (!message || typeof message !== 'object') {
    self.postMessage({ type: 'fatal', error: fault(new Error('Invalid speech worker message.')) });
    return;
  }
  if (message.type === 'connect') {
    if (started) return;
    started = true;
    void connect(message.data).catch(error => {
      self.postMessage({ type: 'fatal', error: fault(error) });
    });
  } else if (message.type === 'cancel') {
    if (current?.id === message.ref) current.cancelled = true;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].id === message.ref) queue.splice(i, 1);
    }
  } else if (message.type === 'synthesize') {
    if (!Number.isSafeInteger(message.id) || message.id < 0) {
      self.postMessage({ type: 'fatal', error: fault(new Error('Invalid speech request ID.')) });
      return;
    }
    if (!ready) {
      self.postMessage({ type: 'error', ref: message.id, error: fault(new Error('Speech worker is not ready.')) });
      return;
    }
    queue.push({ id: message.id, data: message.data, cancelled: false });
    void process();
  } else {
    self.postMessage({ type: 'fatal', error: fault(new Error('Unknown speech worker message.')) });
  }
};

function fault(error, depth = 0) {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
    code: value.code,
    cause: value.cause !== undefined && depth < 6 ? fault(value.cause, depth + 1) : undefined
  };
}

function assetURL(value, directory = false) {
  const url = new URL(value);
  if (url.origin !== self.location.origin || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Speech assets must use absolute same-origin URLs.');
  }
  if (directory && !url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function validVoice(value) {
  return typeof value === 'string' && value.length <= 80 && /^[a-z]{2}_[a-z0-9_]+$/i.test(value);
}

function progress(event) {
  if (event.status !== 'progress') return;
  if (!Number.isFinite(event.loaded) || event.loaded < 0) return;
  filesProgress.set(event.file, {
    loaded: event.loaded,
    total: Number.isFinite(event.total) && event.total > 0 ? event.total : null
  });
  let loaded = 0;
  let total = 0;
  let known = true;
  for (const file of filesProgress.values()) {
    loaded += file.loaded;
    total += file.total ?? 0;
    known &&= file.total !== null;
  }
  self.postMessage({ type: 'progress', data: { loaded, total: known && total >= loaded ? total : null } });
}

async function connect(data) {
  if (!data || !validVoice(data.initialVoice)) {
    throw new Error('Invalid speech initialization settings.');
  }
  settings.dictionaryURL = assetURL(data.dictionaryURL, true);
  settings.voiceURL = assetURL(data.voiceURL, true);
  env.logLevel = LogLevel.ERROR;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // Transformers 4.3 skips local tokenizer discovery when localModelPath is an absolute HTTP URL.
  env.localModelPath = new URL(assetURL(data.modelPath, true)).pathname;
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: assetURL(data.wasmPaths?.mjs),
    wasm: assetURL(data.wasmPaths?.wasm)
  };
  const results = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained('kokoro', {
      dtype: 'q8', device: 'wasm', progress_callback: progress
    }).catch(error => { throw new Error(`Loading the WASM model failed. ${error.message}`, { cause: error }); }),
    AutoTokenizer.from_pretrained('kokoro', { progress_callback: progress })
      .catch(error => { throw new Error(`Loading the tokenizer failed. ${error.message}`, { cause: error }); }),
    loadLanguage(),
    loadVoice(data.initialVoice)
  ]);
  [model, tokenizer] = results;
  ready = true;
  self.postMessage({ type: 'ready', data: { backend: 'WASM' } });
}

async function loadLanguage() {
  if (language) return language;
  const candidate = new Language();
  const url = new URL('en-us.txt', settings.dictionaryURL).href;
  try {
    await candidate.loadDictionary(url);
  } catch (error) {
    throw new Error(`Loading the English dictionary failed at ${url}. ${error.message}`, { cause: error });
  }
  language = candidate;
  return language;
}

async function loadVoice(voice) {
  if (!validVoice(voice)) throw new Error('Invalid voice name.');
  if (voices.has(voice)) return voices.get(voice);
  const url = new URL(`${voice}.bin`, settings.voiceURL).href;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== 510 * settings.styleDim * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('Voice data must contain 510 styles of 256 float32 values.');
    }
    const data = new Float32Array(buffer);
    if (!data.every(Number.isFinite)) throw new Error('Voice data contains nonfinite values.');
    voices.set(voice, data);
    return data;
  } catch (error) {
    throw new Error(`Loading voice ${voice} failed at ${url}. ${error.message}`, { cause: error });
  }
}

function updateTimestamps(o, ds, silences) {
  const scaler = 1000 / settings.frameRate;
  const times = [];
  let t = 0;
  let len = ds.length;
  for (let i = 0; i < len; i++) {
    times.push(Math.round(t));
    t += scaler * ds[i];
  }
  times.push(Math.round(t));

  const shifts = silences.map(x => [x[0] + 1, x[1]]);
  silences.forEach(x => x[0] = times[x[0]] - 20);
  shifts.forEach(x => {
    for (let i = x[0]; i < times.length; i++) times[i] += x[1];
  });

  len = o.words.length;
  for (let i = 0; i < len; i++) {
    const start = times[o.wtimes[i] + 1] + settings.deltaStart;
    const end = times[o.wdurations[i] + 1] + settings.deltaEnd;
    o.wtimes[i] = start;
    o.wdurations[i] = end - start;
  }

  len = o.visemes.length;
  for (let i = 0; i < len; i++) {
    const start = times[o.vtimes[i] + 1] + settings.deltaStart;
    const end = times[o.vdurations[i] + 1] + settings.deltaEnd;
    o.vtimes[i] = start;
    o.vdurations[i] = end - start;
  }
}

async function process() {
  if (processing || !ready) return;
  processing = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      current = item;
      try {
        const data = item.data;
        if (!data || typeof data.input !== 'string' || !data.input.trim() ||
            !validVoice(data.voice) || !Number.isFinite(data.speed) || data.speed < 0.25 || data.speed > 4) {
          throw new Error('Invalid speech request settings.');
        }
        const { phonemes, metadata, silences } = language.generate(data.input);
        if (!metadata.visemes.length) throw new Error('The text contains no speakable words.');
        const { input_ids } = tokenizer(phonemes.join(''), { truncation: false });
        if (input_ids.size > 512) {
          const error = new Error('The speech chunk exceeds the model token limit.');
          error.code = 'input-too-long';
          throw error;
        }
        const num_tokens = Math.min(Math.max(input_ids.size - 2, 0), 509);
        const voice = await loadVoice(data.voice);
        if (item.cancelled) continue;
        const offset = num_tokens * settings.styleDim;
        const inputs = {
          input_ids,
          style: new Tensor('float32', voice.slice(offset, offset + settings.styleDim), [1, settings.styleDim]),
          speed: new Tensor('float32', [data.speed], [1])
        };
        const { waveform, durations } = await model(inputs);
        if (item.cancelled) continue;
        if (!waveform?.data?.length || !waveform.data.every(Number.isFinite) ||
            !durations?.data?.length || !durations.data.every(x => Number.isFinite(x) && x >= 0)) {
          throw new Error('The speech model returned invalid audio or durations.');
        }
        updateTimestamps(metadata, Array.from(durations.data), silences);
        let samples = waveform.data;
        if (silences.length) samples = utils.insertSilences(samples, settings.audioSampleRate, silences);
        metadata.audio = utils.encodeAudio(samples, settings.audioSampleRate, true);
        metadata.audioEncoding = 'wav';
        if (!item.cancelled) self.postMessage({ type: 'audio', ref: item.id, data: metadata }, [metadata.audio]);
      } catch (error) {
        if (!item.cancelled) self.postMessage({ type: 'error', ref: item.id, error: fault(error) });
      } finally {
        current = undefined;
      }
    }
  } finally {
    processing = false;
    if (queue.length) void process();
  }
}
