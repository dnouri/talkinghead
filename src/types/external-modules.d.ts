declare module '@met4citizen/talkinghead' {
  export class TalkingHead {
    constructor(node: HTMLElement, opt?: Record<string, unknown>);
    audioCtx: AudioContext;
    dispose(): void;
    setPoseFromTemplate(template: Record<string, unknown> | null, ms?: number): void;
    showAvatar(avatar: Record<string, unknown>, onprogress?: (ev: ProgressEvent) => void): Promise<void>;
    speakAudio(audio: Record<string, unknown>, opt?: Record<string, unknown>, onsubtitles?: ((word: string) => void) | null): void;
    speakMarker(onmarker: () => void): void;
    stopSpeaking(): void;
    setMood(mood: string): void;
    playGesture(name: string, dur?: number, mirror?: boolean, ms?: number): void;
    setView(view: string, opt?: Record<string, unknown>): void;
    lookAt(x: number, y: number, t: number): void;
    lookAtCamera(t: number): void;
    start(): void;
    stop(): void;
  }
}


