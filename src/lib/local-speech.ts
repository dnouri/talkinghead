import { runtimeAssets } from './runtime-assets';

export type Backend = 'WASM';
export type SpeechProgress = { loaded: number; total: number | null };
export type SpeechClip = {
  audio: AudioBuffer;
  words: string[];
  wtimes: number[];
  wdurations: number[];
  visemes: string[];
  vtimes: number[];
  vdurations: number[];
};

type WireClip = Omit<SpeechClip, 'audio'> & { audio: ArrayBuffer };
type Pending = {
  resolve: (clip: WireClip) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
type Attempt = {
  worker: Worker;
  backend: Backend;
  status: 'loading' | 'ready' | 'closed';
  failure?: Error;
  timer: ReturnType<typeof setTimeout>;
  resolve: (backend: Backend) => void;
  reject: (error: Error) => void;
  pending: Map<number, Pending>;
};
type Events = {
  onProgress: (progress: SpeechProgress) => void;
  onFatal: (error: Error) => void;
};
type GenerateOptions = {
  voice: string;
  speed: number;
  signal: AbortSignal;
  audioContext: AudioContext;
  onClip: (clip: SpeechClip) => void;
};

const timeoutMS = 180_000;
class InputTooLong extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function remoteError(value: unknown, depth = 0): Error {
  if (!isObject(value) || typeof value.message !== 'string') {
    throw new Error('The speech worker returned an invalid error.');
  }
  const ErrorType = value.code === 'input-too-long' ? InputTooLong : Error;
  const error = new ErrorType(value.message, {
    cause: value.cause !== undefined && depth < 6 ? remoteError(value.cause, depth + 1) : undefined,
  });
  if (typeof value.name === 'string') error.name = value.name;
  if (typeof value.stack === 'string') error.stack = value.stack;
  return error;
}

function splitText(text: string, limit = 500): string[] {
  const letters = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), x => x.segment);
  const parts: string[] = [];
  let start = 0;
  let space = -1;
  for (let i = 0; i < letters.length; i++) {
    if (/\s/u.test(letters[i])) space = i;
    const sentence = /[.!?]/u.test(letters[i]) && /\s/u.test(letters[i + 1] ?? '');
    if (i - start + 1 >= limit) {
      const end = space >= start ? space + 1 : i + 1;
      parts.push(letters.slice(start, end).join(''));
      start = end;
      space = -1;
    } else if (sentence) {
      parts.push(letters.slice(start, i + 1).join(''));
      start = i + 1;
      space = -1;
    }
  }
  if (start < letters.length) parts.push(letters.slice(start).join(''));
  return parts.filter(part => part.trim());
}

function parseClip(value: unknown): WireClip {
  if (!isObject(value) || value.audioEncoding !== 'wav' || !(value.audio instanceof ArrayBuffer)) {
    throw new Error('The speech worker returned invalid WAV audio.');
  }
  const audio = value.audio;
  if (audio.byteLength <= 44 || (audio.byteLength - 44) % 2 !== 0) {
    throw new Error('The speech worker returned empty or incomplete WAV audio.');
  }
  const view = new DataView(audio);
  if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645 ||
      view.getUint32(12) !== 0x666d7420 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 24000 || view.getUint16(32, true) !== 2 ||
      view.getUint16(34, true) !== 16 || view.getUint32(36) !== 0x64617461 ||
      view.getUint32(40, true) !== audio.byteLength - 44) {
    throw new Error('The speech worker returned an unsupported WAV format.');
  }
  const durationMS = (audio.byteLength - 44) / 48;
  for (const [labelsKey, timesKey, durationsKey] of [
    ['words', 'wtimes', 'wdurations'], ['visemes', 'vtimes', 'vdurations'],
  ] as const) {
    const labels = value[labelsKey];
    const times = value[timesKey];
    const durations = value[durationsKey];
    if (!Array.isArray(labels) || !labels.length ||
        !labels.every(x => typeof x === 'string' && (labelsKey === 'words' || x.length > 0)) ||
        !labels.some(x => x.trim()) || !Array.isArray(times) || !Array.isArray(durations) ||
        labels.length !== times.length || labels.length !== durations.length) {
      throw new Error(`The speech worker returned invalid ${labelsKey} metadata.`);
    }
    for (let i = 0; i < labels.length; i++) {
      if (!Number.isFinite(times[i]) || times[i] < -100 ||
          !Number.isFinite(durations[i]) || durations[i] < 0 ||
          (i > 0 && times[i] < times[i - 1]) || times[i] + durations[i] > durationMS + 250) {
        throw new Error(`The speech worker returned invalid ${labelsKey} timings.`);
      }
    }
  }
  return {
    audio,
    words: value.words as string[], wtimes: value.wtimes as number[], wdurations: value.wdurations as number[],
    visemes: value.visemes as string[], vtimes: value.vtimes as number[], vdurations: value.vdurations as number[],
  };
}

export class LocalSpeech {
  private readonly events: Events;
  private attempt: Attempt | undefined;
  private initialization: Promise<Backend> | undefined;
  private nextID = 0;
  private disposed = false;

  constructor(events: Events) {
    this.events = events;
  }

  initialize(initialVoice: string): Promise<Backend> {
    if (this.disposed) return Promise.reject(new Error('The speech engine has been disposed.'));
    if (this.attempt?.status === 'ready') return Promise.resolve(this.attempt.backend);
    if (this.initialization) return this.initialization;
    this.initialization = this.connect(initialVoice).finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  private connect(initialVoice: string): Promise<Backend> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../vendor/headtts/worker-tts.mjs', import.meta.url), { type: 'module' });
      const attempt: Attempt = {
        worker, backend: 'WASM', status: 'loading', resolve, reject, pending: new Map(),
        timer: setTimeout(() => {
          this.fail(attempt, new Error('WASM initialization timed out after 180 seconds.'));
        }, timeoutMS),
      };
      this.attempt = attempt;
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (this.attempt !== attempt) return;
        try {
          this.receive(attempt, event.data);
        } catch (cause) {
          this.fail(attempt, cause instanceof Error ? cause : new Error(String(cause)));
        }
      };
      worker.onerror = event => {
        event.preventDefault();
        this.fail(attempt, new Error(`Speech worker failed. ${event.message || 'Module loading or execution failed.'}`, {
          cause: event.error ?? event,
        }));
      };
      worker.onmessageerror = event => {
        this.fail(attempt, new Error('The speech worker message could not be decoded.', { cause: event }));
      };
      try {
        worker.postMessage({ type: 'connect', data: {
          ...runtimeAssets(), initialVoice,
        } });
      } catch (cause) {
        this.fail(attempt, new Error('Starting the speech worker failed.', { cause }));
      }
    });
  }

  private receive(attempt: Attempt, message: unknown): void {
    if (!isObject(message)) throw new Error('The speech worker returned an invalid message.');
    if (message.type === 'progress') {
      if (attempt.status !== 'loading') return;
      const data = message.data;
      if (!isObject(data) || typeof data.loaded !== 'number' || !Number.isFinite(data.loaded) || data.loaded < 0 ||
          (data.total !== null && (typeof data.total !== 'number' || !Number.isFinite(data.total) || data.total < data.loaded))) {
        throw new Error('The speech worker returned invalid download progress.');
      }
      this.events.onProgress({ loaded: data.loaded, total: data.total as number | null });
    } else if (message.type === 'ready') {
      if (attempt.status !== 'loading' || !isObject(message.data) || message.data.backend !== attempt.backend) {
        throw new Error('The speech worker returned an invalid backend.');
      }
      clearTimeout(attempt.timer);
      attempt.status = 'ready';
      attempt.resolve(attempt.backend);
    } else if (message.type === 'fatal') {
      this.fail(attempt, remoteError(message.error));
    } else if (message.type === 'audio' || message.type === 'error') {
      if (typeof message.ref !== 'number' || !Number.isSafeInteger(message.ref)) {
        throw new Error('The speech worker returned an invalid request ID.');
      }
      const pending = attempt.pending.get(message.ref);
      if (!pending) return;
      if (message.type === 'audio') {
        const clip = parseClip(message.data);
        attempt.pending.delete(message.ref);
        pending.cleanup();
        pending.resolve(clip);
      } else {
        const error = remoteError(message.error);
        attempt.pending.delete(message.ref);
        pending.cleanup();
        pending.reject(error);
      }
    } else {
      throw new Error('The speech worker returned an unknown message.');
    }
  }

  async generate(text: string, options: GenerateOptions): Promise<void> {
    const { signal, audioContext, voice, speed, onClip } = options;
    signal.throwIfAborted();
    const attempt = this.attempt;
    if (!attempt || attempt.status !== 'ready') throw new Error('The speech engine is not ready.');
    if (typeof text !== 'string' || !text.trim() || typeof voice !== 'string' ||
        !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      throw new Error('Speech requires text, a voice, and a speed between 0.25 and 4.');
    }
    const parts = splitText(text);
    while (parts.length) {
      this.checkActive(attempt, signal);
      const part = parts.shift()!;
      let clip: WireClip;
      try {
        clip = await this.request(attempt, part, voice, speed, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof InputTooLong)) throw error;
        this.checkActive(attempt, signal);
        const length = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(part)).length;
        if (length < 2) throw new Error('A single text character exceeds the speech model limit.', { cause: error });
        parts.unshift(...splitText(part, Math.floor(length / 2)));
        continue;
      }
      this.checkActive(attempt, signal);
      const encodedLength = clip.audio.byteLength;
      let audio: AudioBuffer;
      try {
        audio = await audioContext.decodeAudioData(clip.audio);
      } catch (cause) {
        this.checkActive(attempt, signal);
        throw new Error('Decoding the generated speech failed.', { cause });
      }
      this.checkActive(attempt, signal);
      if (!audio.length || audio.numberOfChannels !== 1 || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 ||
          !Number.isFinite(audio.duration) ||
          Math.abs(audio.duration - (encodedLength - 44) / 48000) > 0.1 ||
          !audio.getChannelData(0).every(Number.isFinite)) {
        throw new Error('Decoding speech produced invalid audio.');
      }
      onClip({ ...clip, audio });
    }
    this.checkActive(attempt, signal);
  }

  private checkActive(attempt: Attempt, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.attempt !== attempt || attempt.status !== 'ready') {
      throw attempt.failure ?? new Error('The speech worker is no longer available.');
    }
  }

  private request(attempt: Attempt, input: string, voice: string, speed: number, signal: AbortSignal): Promise<WireClip> {
    return new Promise((resolve, reject) => {
      const id = this.nextID++;
      const cancel = (error: Error) => {
        const pending = attempt.pending.get(id);
        if (!pending) return;
        attempt.pending.delete(id);
        pending.cleanup();
        pending.reject(error);
        try {
          attempt.worker.postMessage({ type: 'cancel', ref: id });
        } catch (cause) {
          this.fail(attempt, new Error('Cancelling the speech request failed.', { cause }));
        }
      };
      const abort = () => cancel(new DOMException('Speech was cancelled.', 'AbortError'));
      const timer = setTimeout(() => cancel(new Error('Speech generation timed out after 180 seconds.')), timeoutMS);
      attempt.pending.set(id, { resolve, reject, cleanup: () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      } });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try {
        attempt.worker.postMessage({ type: 'synthesize', id, data: { input, voice, speed } });
      } catch (cause) {
        this.fail(attempt, new Error('Sending the speech request failed.', { cause }));
      }
    });
  }

  private fail(attempt: Attempt, error: Error): void {
    if (this.attempt !== attempt) return;
    const wasReady = attempt.status === 'ready';
    this.retire(attempt, error);
    if (wasReady) this.events.onFatal(error);
  }

  private retire(attempt: Attempt, error: Error): void {
    attempt.status = 'closed';
    attempt.failure = error;
    clearTimeout(attempt.timer);
    attempt.worker.onmessage = null;
    attempt.worker.onerror = null;
    attempt.worker.onmessageerror = null;
    attempt.worker.terminate();
    attempt.reject(error);
    for (const pending of attempt.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    attempt.pending.clear();
    if (this.attempt === attempt) this.attempt = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.attempt) this.retire(this.attempt, new Error('The speech engine has been disposed.'));
  }
}
