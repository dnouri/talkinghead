# Performance

What the speed numbers for this app mean, how they are produced, and what limits them. Read this before quoting any number from it. For running the app itself, see [development.md](development.md).

## What is measured

`scripts/measure-speech.mjs` records two timers per run.

- **Initialize time.** The span from the **Initialize voice engine** click to the speech worker's `ready` message. On a cold cache this includes downloading the 88.1 MiB model, the selected voice, the dictionary, and the WASM runtime, then compiling and warming the model.
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
- **CPU-bound inference.** Quantized q8 inference on WASM scales with the host CPU. Speech speed settings and text length move the numbers; long text is split into clips of at most about 500 characters.
- **No kernel preemption.** Stop halts playback and ignores cancelled results immediately. It cannot interrupt an ONNX inference already using the CPU. Starting another request may wait for that work to finish.

There is no universal latency promise here. A number without its CPU, browser version, OS, URL, cache state, isolation value, phrase, and sample count is not a measurement of this app; it is a rumor.

## Published numbers

Numbers for `https://dnouri.github.io/talkinghead/` will be added to this section after the first live deployment, from five fresh-context runs of `npm run measure` against the live URL. Each published entry states the median and range of both timers, plus the CPU, browser and version, OS, cache state, and the recorded `crossOriginIsolated` value. The generated WAV of every quoted run is recognized with `scripts/verify-speech.py` first, so a timing is only published alongside evidence that the app actually spoke the phrase.

Earlier numbers from development machines are deliberately not republished. They predate the deployment, they mix several configuration changes, and quoting them as site performance would be wrong.

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
