import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  avatarController,
  VOICES,
  MOODS,
  GESTURES,
  VIEWS,
} from '@/lib/avatar-controller';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4 last:border-b-0">
      <h2 className="mb-3 text-[10px] uppercase tracking-[0.22em] text-dim">{title}</h2>
      {children}
    </section>
  );
}

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={[
        'border px-2 py-1 text-[11px] transition-colors duration-150 cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal',
        active
          ? 'border-signal/60 text-signal'
          : 'border-line text-fog hover:border-fog/50 hover:text-ink',
        disabled ? 'cursor-not-allowed opacity-30 hover:border-line hover:text-fog' : '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function EngineBlock() {
  const s = useSyncExternalStore(avatarController.subscribe, avatarController.getSnapshot);
  const pct =
    s.modelProgress && s.modelProgress.computable && s.modelProgress.totalMB > 0
      ? Math.min(100, Math.round((s.modelProgress.loadedMB / s.modelProgress.totalMB) * 100))
      : null;

  return (
    <Section title="Voice engine">
      {s.engine === 'off' && (
        <>
          <button
            type="button"
            onClick={() => avatarController.initVoiceEngine()}
            className="w-full cursor-pointer border border-signal/50 px-3 py-2 text-[12px] uppercase tracking-[0.14em] text-signal transition-colors duration-150 hover:bg-signal/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal"
          >
            Initialize voice engine
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-dim">
            Downloads the bundled Kokoro 82M model and runtime from this site.
            Speech runs locally on the CPU with WASM. No API key or speech service.
            All voices use English pronunciation.
          </p>
        </>
      )}
      {s.engine === 'loading' && (
        <div>
          <div className="mb-2 flex items-baseline justify-between text-[11px]">
            <span className="text-fog">loading model</span>
            <span className="text-signal tabular-nums">
              {s.modelProgress
                ? `${s.modelProgress.loadedMB.toFixed(1)} MB${s.modelProgress.computable ? ` / ${s.modelProgress.totalMB.toFixed(1)} MB` : ''}`
                : 'starting'}
            </span>
          </div>
          <div className="h-[3px] w-full bg-line">
            <div
              className="h-full bg-signal transition-[width] duration-200"
              style={{ width: pct === null ? '15%' : `${pct}%` }}
            />
          </div>
        </div>
      )}
      {s.engine === 'ready' && (
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-fog">status</span>
          <span className="text-signal">READY · {s.backend}</span>
        </div>
      )}
      {s.engine === 'error' && (
        <div>
          <p className="mb-2 text-[11px] leading-relaxed text-warn">
            Engine failed to start. {s.engineError}
          </p>
          <button
            type="button"
            onClick={() => avatarController.initVoiceEngine()}
            className="w-full cursor-pointer border border-line px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-fog transition-colors duration-150 hover:border-fog/50 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal"
          >
            Retry
          </button>
        </div>
      )}
    </Section>
  );
}

function SpeakBlock() {
  const s = useSyncExternalStore(avatarController.subscribe, avatarController.getSnapshot);
  const [text, setText] = useState(
    "Hey, I'm running entirely inside your browser. No server, no cloud. Type something and I'll say it out loud.",
  );
  const busy = s.speech !== 'idle';
  const ready = s.engine === 'ready' && s.avatar === 'ready' && !busy;

  return (
    <Section title="Speak">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        spellCheck={false}
        aria-label="Text to speak"
        placeholder="Type what the avatar should say"
        className="mb-3 w-full resize-none border border-line bg-transparent p-2 text-[12px] leading-relaxed text-ink placeholder:text-dim focus:border-signal/60 focus:outline-none"
      />
      <div className="mb-3 grid grid-cols-3 gap-1">
        {VOICES.map((v) => (
          <Chip key={v.id} active={s.voice === v.id} onClick={() => avatarController.setVoice(v.id)}>
            {v.label}
          </Chip>
        ))}
      </div>
      <label className="mb-1 flex items-baseline justify-between text-[11px] text-fog">
        <span>speed</span>
        <span className="text-signal tabular-nums">{s.speed.toFixed(2)}×</span>
      </label>
      <input
        aria-label="Speech speed"
        type="range"
        min={0.5}
        max={2}
        step={0.05}
        value={s.speed}
        onChange={(e) => avatarController.setSpeed(Number(e.target.value))}
        className="mb-3 w-full accent-[#35c4ff]"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!ready || !text.trim()}
          onClick={() => avatarController.speak(text)}
          className="flex-1 cursor-pointer border border-signal/50 px-3 py-2 text-[12px] uppercase tracking-[0.14em] text-signal transition-colors duration-150 hover:bg-signal/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {s.speech === 'generating' ? 'Generating…' : s.speech === 'playing' ? 'Playing…' : 'Speak'}
        </button>
        <button
          type="button"
          disabled={!busy}
          onClick={() => avatarController.stop()}
          className="cursor-pointer border border-line px-3 py-2 text-[12px] uppercase tracking-[0.14em] text-fog transition-colors duration-150 hover:border-fog/50 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-30"
        >
          Stop
        </button>
      </div>
      {s.engineError && s.engine === 'ready' && (
        <p className="mt-2 text-[11px] text-warn">{s.engineError}</p>
      )}
    </Section>
  );
}

function PresenceBlock() {
  const s = useSyncExternalStore(avatarController.subscribe, avatarController.getSnapshot);
  const avatarReady = s.avatar === 'ready';
  return (
    <>
      <Section title="Mood">
        <div className="grid grid-cols-3 gap-1">
          {MOODS.map((m) => (
            <Chip key={m} active={s.mood === m} disabled={!avatarReady} onClick={() => avatarController.setMood(m)}>
              {m}
            </Chip>
          ))}
        </div>
      </Section>
      <Section title="Gesture">
        <div className="grid grid-cols-2 gap-1">
          {GESTURES.map((g) => (
            <Chip key={g.id} disabled={!avatarReady} onClick={() => avatarController.gesture(g.id)}>
              {g.label}
            </Chip>
          ))}
        </div>
      </Section>
      <Section title="Camera & gaze">
        <div className="mb-2 grid grid-cols-3 gap-1">
          {VIEWS.map((v) => (
            <Chip key={v} active={s.view === v} disabled={!avatarReady} onClick={() => avatarController.setView(v)}>
              {v}
            </Chip>
          ))}
        </div>
        <Chip active={s.followCursor} disabled={!avatarReady} onClick={() => avatarController.setFollowCursor(!s.followCursor)}>
          watch my cursor
        </Chip>
      </Section>
    </>
  );
}

export default function App() {
  const s = useSyncExternalStore(avatarController.subscribe, avatarController.getSnapshot);
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    queueMicrotask(() => {
      if (!lifetime.signal.aborted && mountRef.current) avatarController.attachAvatar(mountRef.current);
    });
    return () => {
      lifetime.abort();
      avatarController.dispose();
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => avatarController.pointerMove(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-void">
      <div ref={mountRef} className="absolute inset-0 bottom-[58dvh] sm:bottom-0 sm:right-[324px]" aria-label="Animated avatar" />

      <div className="noise pointer-events-none absolute inset-0" aria-hidden="true" />

      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-line/60 px-4 py-2 backdrop-blur-sm">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[13px] font-medium tracking-[0.08em] text-ink">
            SPEECH AVATAR
          </span>
          <span className="hidden text-[10px] uppercase tracking-[0.22em] text-dim sm:inline">
            fully in-browser · kokoro 82m · talkinghead
          </span>
        </div>
        <div className="text-[10px] uppercase tracking-[0.22em]">
          {s.engine === 'ready' ? (
            <span className="text-signal">● engine {s.backend}</span>
          ) : s.engine === 'loading' ? (
            <span className="text-warn">● engine loading</span>
          ) : (
            <span className="text-dim">○ engine off</span>
          )}
        </div>
      </header>

      {s.avatar === 'loading' && (
        <div className="absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 text-center text-[11px] uppercase tracking-[0.22em] text-dim">
          loading avatar {s.avatarProgress !== null ? `${s.avatarProgress}%` : ''}
        </div>
      )}
      {s.avatar === 'error' && (
        <div role="alert" className="absolute left-4 top-16 z-20 max-w-[44ch] border border-line bg-panel p-4 text-[12px] text-warn">
          <p>Avatar failed to load. {s.avatarError}</p>
          <button type="button" onClick={() => avatarController.retryAvatar()} className="mt-2 border border-line px-3 py-2 text-ink">
            Retry avatar
          </button>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-[59dvh] left-4 right-4 z-10 max-h-[14dvh] overflow-hidden sm:bottom-4 sm:right-[340px] sm:max-h-[30dvh] sm:max-w-[46ch]">
        <p data-testid="subtitle" className={`min-h-[1.5em] text-[13px] leading-relaxed text-ink ${s.subtitle ? 'bg-void/90 px-2 py-1' : ''}`}>{s.subtitle}</p>
        <p className="mt-1 hidden text-[10px] uppercase tracking-[0.22em] text-dim sm:block">
          {s.avatar === 'ready'
            ? s.followCursor
              ? 'she watches your cursor · drag to orbit · scroll to zoom'
              : 'drag to orbit · scroll to zoom'
            : ''}
        </p>
      </div>

      <aside aria-label="Avatar controls" className="absolute left-3 right-3 top-[44dvh] bottom-4 z-10 overflow-y-auto border border-line bg-panel/80 backdrop-blur-md sm:left-auto sm:top-12 sm:w-[300px]">
        <EngineBlock />
        <SpeakBlock />
        <PresenceBlock />
      </aside>
    </div>
  );
}
