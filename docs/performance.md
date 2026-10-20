# Performance

What the speed numbers for this app mean, how they are produced, and what limits them. Read this before quoting any number from it. For running the app itself, see [development.md](development.md).

## What is measured

`scripts/measure-speech.mjs` records two timers per run.

- **Initialize time.** The span from the **Initialize voice engine** click to the speech worker's `ready` message. On a cold cache this includes downloading the 88.1 MiB model, the selected voice, the dictionary, and the WASM runtime, then initializing the runtime and model session.
- **First-audio time.** The span from the **Speak** click to the first native `AudioBufferSourceNode.start()` call. This is scheduled playback, not acoustic output, and not full generation. Longer text keeps generating after this point while the first clip plays.

Both are wall-clock spans captured with `performance.now()` inside the page.

## How the measurement works

The script drives headless Chromium through Playwright with WebGPU disabled, which matches the speech path the app always uses. Before each page load it injects a script that wraps the `Worker` constructor and `AudioBufferSourceNode.prototype.start`, and records click timestamps on the two buttons. Each run uses the fixed phrase "Hello, this is a local speech test. Back again." and a fresh browser context.

Each sample records the two timers, the `crossOriginIsolated` value, the worker count, the renderer CPU seconds from the Chrome DevTools Protocol, and any page errors or failed HTTP responses. Any page error fails the sample. The first generated WAV clip of each sample is written next to the results so the audio can be recognized before any number is quoted.

The default is five runs (`RUNS=5`). The summary in `result.json` reports the median, minimum, maximum, and count per target. Medians over five runs are what get published, always with the range and the environment.

## Cache and environment caveats

- Each sample uses a fresh browser context, so the HTTP cache does not carry over between samples. The operating system's file cache and any server-side warmth are shared.
- The script identifies loopback and remote targets separately. Its result records the target URL, public revision, browser command line, CPU, OS, document and speech-worker isolation, and cache conditions.
- The measurement browser disables WebGPU and renders with software GL. The timers measure the speech pipeline, not avatar frame rate.
- Renderer CPU seconds come from the browser process accounting and are approximate.

## What limits the numbers

- **Model size.** A cold visit downloads about 100 MB of assets. Initialization includes both network transfer and model setup. Their relative costs depend on the connection and CPU.
- **One thread on the public site.** The worker picks `min(4, hardwareConcurrency)` threads only when the page is cross-origin isolated. GitHub Pages cannot send the COOP and COEP headers that create isolation, so the deployed site runs one WASM thread. A local Vite server sends the headers, so local and public measurements use different CPU configurations. Never compare them without naming which is which.
- **Hosting simplicity.** The site uses native Pages without a response-rewriting service worker. It accepts one speech thread to avoid installation reloads and persistent worker state.
- **CPU-bound inference.** Quantized q8 inference on WASM scales with the host CPU. Speech speed settings and text length move the numbers; long text is split into clips of at most about 500 characters.
- **No kernel preemption.** Stop halts playback and ignores cancelled results immediately. It cannot interrupt an ONNX inference already using the CPU. Starting another request may wait for that work to finish.

There is no universal latency promise here. A number without its CPU, browser version, OS, URL, cache state, isolation value, phrase, and sample count is not a measurement of this app; it is a rumor.

## Published numbers

This reference uses five fresh browser contexts against the actual [public site](https://dnouri.github.io/talkinghead/) on 2026-10-20. It measures revision [`4130d87`](https://github.com/dnouri/talkinghead/commit/4130d87bafe53268d67633af3dceea789a98ab3c).

| Interval | Median | Observed range |
| --- | --- | --- |
| Initialize click to ready | 10.86 s | 10.37 to 17.68 s |
| Speak click to first native audio start | 12.95 s | 12.88 to 13.84 s |

The machine has an AMD Ryzen 7 PRO 7840U and 32 GB of memory. The browser is headless Chromium 153.0.8010.12 on Debian Linux x64, driven by Playwright 1.63.0. Speech uses one WASM thread. The document and actual speech worker both report `crossOriginIsolated: false`. The browser renders the avatar with software GL and disables WebGPU. This is a machine-specific reference, not a speedup or an estimate for your device.

The model, voice Bella, and speed setting 1.0 stay fixed. Each sample requests "Hello, this is a local speech test. Back again." First audio means the first clip starts, not that both sentences have finished. All five saved first clips passed a local Whisper-small word check for "Hello, this is a local speech test." There were no page errors or failed HTTP responses in the five samples.

The browser context is fresh for every sample. The browser process is shared. CDN and operating-system caches are not cleared. The first initialization took 17.68 s. The other four took 10.37 to 11.69 s. The table keeps that spread rather than treating it as an exception.

The [complete results](benchmarks/2026-10-20/results.json) retain all samples, browser flags, source revision, and environment details. Installation and temporary profile paths are shortened for privacy. The [recognition results](benchmarks/2026-10-20/recognition.json) identify each saved WAV by SHA-256. They check words, not perceived voice quality.

A [separate diagnostic worker profile](benchmarks/2026-10-20/diagnostic-profile.json) recorded 16,910 of 16,984 active worker samples inside ONNX WASM. This locates the synthesis cost in the existing [model call](../src/vendor/headtts/worker-tts.mjs#L225), which uses one thread on Pages. The profile is not one of the five timing samples. It does not measure network transfer or avatar rendering. The [raw CPU profile](benchmarks/2026-10-20/worker.cpuprofile) is included for inspection.

That diagnostic also captured the avatar's processed audio for both sentences. The [recorded playback](benchmarks/2026-10-20/playback.webm) passed the [same word check](benchmarks/2026-10-20/playback-recognition.json). None of these checks establish physical speaker output or human-perceived audio quality.

## Reproduce a measurement

With the app served and Playwright installed (see [development.md](development.md#run-browser-checks)):

```sh
APP_URL=https://dnouri.github.io/talkinghead/ npm run measure
```

`APP_URL` must end with a slash. Results land in `tmp/speech-measurement/` (override with `MEASURE_OUTPUT`). Set `BEFORE_URL` to a second target to alternate two builds. To recognize the recorded audio of run 0:

```sh
uv run --no-project --with faster-whisper python scripts/verify-speech.py tmp/speech-measurement/current-0.wav --expected 'Hello, this is a local speech test.'
```

Each saved WAV contains the first clip, not both sentences. For a local target without `build-info.json`, set `SOURCE_REVISION` to the full SHA of the source you built. Set `BEFORE_REVISION` for a comparison target without build metadata. The script records machine and browser details automatically.
