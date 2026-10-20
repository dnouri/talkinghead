import './meshopt-patch';
import { TalkingHead } from '@met4citizen/talkinghead';
import { LocalSpeech, type Backend } from './local-speech';
import { assetURL } from './runtime-assets';

export type EngineState = 'off' | 'loading' | 'ready' | 'error';
export type AvatarState = 'idle' | 'loading' | 'ready' | 'error';

export interface Snapshot {
  avatar: AvatarState;
  avatarProgress: number | null;
  avatarError: string | null;
  engine: EngineState;
  engineError: string | null;
  backend: Backend | null;
  modelProgress: { loadedMB: number; totalMB: number; computable: boolean } | null;
  speech: 'idle' | 'generating' | 'playing';
  subtitle: string;
  voice: string;
  speed: number;
  mood: string;
  view: string;
  followCursor: boolean;
}

type Run = {
  abort: AbortController;
  head: TalkingHead;
  queued: number;
  drained: number;
};

export const VOICES = [
  { id: 'af_bella', label: 'Bella', group: 'US female' },
  { id: 'af_sarah', label: 'Sarah', group: 'US female' },
  { id: 'af_nova', label: 'Nova', group: 'US female' },
  { id: 'am_adam', label: 'Adam', group: 'US male' },
  { id: 'am_michael', label: 'Michael', group: 'US male' },
  { id: 'bf_emma', label: 'Emma', group: 'UK female' },
  { id: 'bf_isabella', label: 'Isabella', group: 'UK female' },
  { id: 'bm_george', label: 'George', group: 'UK male' },
  { id: 'bm_lewis', label: 'Lewis', group: 'UK male' },
] as const;

export const MOODS = ['neutral', 'happy', 'sad', 'angry', 'love', 'sleep'] as const;
export const GESTURES = [
  { id: 'thumbup', label: 'thumbs up' },
  { id: 'shrug', label: 'shrug' },
  { id: 'ok', label: 'ok sign' },
  { id: 'handup', label: 'hand up' },
] as const;
export const VIEWS = ['head', 'upper', 'full'] as const;

class AvatarController {
  private head: TalkingHead | null = null;
  private avatarLoad: Promise<void> | null = null;
  private speech: LocalSpeech | null = null;
  private activeSpeech: Run | null = null;
  private container: HTMLElement | null = null;
  private listeners = new Set<() => void>();
  private lastLookAt = 0;

  private state: Snapshot = {
    avatar: 'idle',
    avatarProgress: null,
    avatarError: null,
    engine: 'off',
    engineError: null,
    backend: null,
    modelProgress: null,
    speech: 'idle',
    subtitle: '',
    voice: 'af_bella',
    speed: 1,
    mood: 'neutral',
    view: 'upper',
    followCursor: true,
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  private patch(p: Partial<Omit<Snapshot, 'speech'>>) {
    const run = this.activeSpeech;
    this.state = {
      ...this.state, ...p,
      speech: !run ? 'idle' : run.queued > run.drained ? 'playing' : 'generating',
    };
    this.listeners.forEach(fn => fn());
  }

  attachAvatar(el: HTMLElement) {
    if (this.head && this.container === el) return;
    this.releaseAvatar();
    this.container = el;
    this.patch({ avatar: 'loading', avatarProgress: 0, avatarError: null });
    try {
      const head = new TalkingHead(el, {
        lipsyncModules: [],
        lipsyncLang: 'en',
        cameraView: this.state.view,
        cameraZoomEnable: true,
        modelPixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        lightAmbientIntensity: 2.2,
      });
      this.head = head;
      const loading = head.showAvatar({
        url: assetURL('avatars/avatar.glb'),
        body: 'F',
        avatarMood: this.state.mood,
        lipsyncLang: 'en',
      }, ev => {
        if (this.head !== head) return;
        const pct = ev.lengthComputable && ev.total > 0 ? Math.round(ev.loaded / ev.total * 100) : null;
        this.patch({ avatarProgress: pct });
      });
      this.avatarLoad = loading;
      void loading.then(() => {
        if (this.head === head) this.patch({ avatar: 'ready', avatarProgress: 100 });
      }).catch(error => {
        if (this.head !== head) return;
        this.releaseAvatar();
        this.patch({ avatar: 'error', avatarError: String(error?.message ?? error) });
      });
    } catch (error) {
      this.releaseAvatar();
      this.patch({ avatar: 'error', avatarError: error instanceof Error ? error.message : String(error) });
    }
  }

  retryAvatar() {
    if (this.container) this.attachAvatar(this.container);
  }

  async initVoiceEngine() {
    if (this.state.engine === 'loading' || this.state.engine === 'ready') return;
    this.speech?.dispose();
    this.patch({ engine: 'loading', engineError: null, backend: null, modelProgress: null });
    const speech = new LocalSpeech({
      onProgress: progress => {
        this.patch({ modelProgress: {
          loadedMB: Math.round(progress.loaded / 104857.6) / 10,
          totalMB: Math.round((progress.total ?? 0) / 104857.6) / 10,
          computable: progress.total !== null,
        } });
      },
      onFatal: error => {
        if (this.speech !== speech) return;
        this.stop();
        this.patch({ engine: 'error', engineError: error.message, backend: null, modelProgress: null });
      },
    });
    this.speech = speech;
    try {
      const backend = await speech.initialize(this.state.voice);
      if (this.speech === speech) this.patch({ engine: 'ready', backend, modelProgress: null });
    } catch (error) {
      if (this.speech !== speech) return;
      this.patch({
        engine: 'error', engineError: error instanceof Error ? error.message : String(error),
        backend: null, modelProgress: null,
      });
    }
  }

  async speak(text: string) {
    const input = text.trim();
    const head = this.head;
    const speech = this.speech;
    if (!input || !head || !speech || this.state.avatar !== 'ready' || this.state.engine !== 'ready') return;
    this.stop();
    const run: Run = { abort: new AbortController(), head, queued: 0, drained: 0 };
    this.activeSpeech = run;
    this.patch({ subtitle: '', engineError: null });
    try {
      await head.audioCtx.resume();
      if (!this.isCurrent(run)) return;
      if (head.audioCtx.state !== 'running') throw new Error('Click Speak to enable audio in this browser.');
      await speech.generate(input, {
        voice: this.state.voice, speed: this.state.speed, signal: run.abort.signal, audioContext: head.audioCtx,
        onClip: clip => {
          if (!this.isCurrent(run)) return;
          const ordinal = ++run.queued;
          head.speakAudio(clip, {}, word => {
            if (this.isCurrent(run)) this.patch({ subtitle: (this.state.subtitle + word).trimStart() });
          });
          if (!this.isCurrent(run)) return;
          head.speakMarker(() => {
            if (!this.isCurrent(run)) return;
            run.drained = ordinal;
            this.patch({});
          });
          this.patch({});
        },
      });
      if (!this.isCurrent(run)) return;
      head.speakMarker(() => {
        if (!this.isCurrent(run)) return;
        this.activeSpeech = null;
        this.patch({});
      });
    } catch (error) {
      if (!this.isCurrent(run)) return;
      this.stop();
      if (error instanceof Error && error.name === 'AbortError') return;
      this.patch({ engineError: error instanceof Error ? error.message : String(error) });
    }
  }

  private isCurrent(run: Run): boolean {
    return this.activeSpeech === run && this.head === run.head;
  }

  stop() {
    const run = this.activeSpeech;
    this.activeSpeech = null;
    run?.abort.abort();
    (run?.head ?? this.head)?.stopSpeaking();
    this.patch({});
  }

  setVoice(voice: string) {
    this.patch({ voice });
  }

  setSpeed(speed: number) {
    this.patch({ speed });
  }

  setMood(mood: string) {
    this.patch({ mood });
    this.head?.setMood(mood);
  }

  gesture(name: string) {
    this.head?.playGesture(name, 3);
  }

  setView(view: string) {
    this.patch({ view });
    this.head?.setView(view);
  }

  setFollowCursor(on: boolean) {
    this.patch({ followCursor: on });
    if (!on) this.head?.lookAtCamera(500);
  }

  pointerMove(x: number, y: number) {
    if (!this.state.followCursor || !this.head || this.state.avatar !== 'ready') return;
    const now = performance.now();
    if (now - this.lastLookAt < 120) return;
    this.lastLookAt = now;
    this.head.lookAt(x, y, 700);
  }

  private releaseAvatar() {
    this.stop();
    const head = this.head;
    const loading = this.avatarLoad;
    this.head = null;
    this.avatarLoad = null;
    if (!head) return;
    head.stop();
    const dispose = () => {
      head.dispose();
      void head.audioCtx.close();
    };
    void (loading ?? Promise.resolve()).then(dispose, () => {
      // TalkingHead 1.7 restores a pose during disposal even if loading failed before a rig existed.
      head.setPoseFromTemplate = () => {};
      dispose();
    });
  }

  dispose() {
    this.releaseAvatar();
    this.speech?.dispose();
    this.speech = null;
    this.container = null;
    this.patch({ avatar: 'idle', engine: 'off', backend: null, subtitle: '', modelProgress: null });
  }
}

export const avatarController = new AvatarController();
