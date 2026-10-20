# Development

How to run, check, and troubleshoot the speech avatar locally. For what the app is and why, see the [README](../README.md). For timing methods, see [performance.md](performance.md).

## Prerequisites

- Node.js 22.12 or later. This is a build requirement only; the deployed site is static files.
- A current Chromium-based browser. This is the verified target. Other browser families need separate verification.
- Run the app on localhost or HTTPS.

## Run the app

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:3000/`.

1. Wait for the avatar to appear.
2. Click **Initialize voice engine**. The browser downloads the bundled model and runtime from this app.
3. Wait for **READY · WASM**. The label shows the backend that actually initialized.
4. Enter English text and click **Speak**.
5. To cancel generation or playback, click **Stop**.

If an asset fails to load, restore the connection and click **Retry**. Use **Retry avatar** for an avatar-loading failure. Keep the page open while the engine loads.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Vite development server on port 3000. |
| `npm run check` | Runs `lint:app` and a production build (`tsc -b && vite build`). |
| `npm run build` | Runs the production build into `dist/`. |
| `npm run preview` | Serves `dist/` locally with isolation headers. |
| `npm run serve:pages` | Serves a `/talkinghead/` build without isolation headers, matching Pages. |
| `npm run lint:app` | Lints the active app and browser scripts. |
| `npm run lint` | Also lints the supplied unused UI templates, which keep their original failures. |
| `npm run smoke` | Drives a real browser through the app and asserts playback, scheduling, and isolation. |
| `npm run measure` | Measures initialize and first-audio latency. See [performance.md](performance.md). |

## Build and preview

```sh
npm run check
npm run preview
```

Open the preview URL printed by Vite. Keep the generated `dist/` directory intact when you serve it. Its model, dictionary, voices, JavaScript modules, and WASM files are all required.

Every push to `main` deploys through GitHub Actions after checks pass, uploading only `dist/` to GitHub Pages. See [.github/workflows/](../.github/workflows/).

To test the public hosting configuration locally, use a project-mounted build and the header-free fixture:

```sh
npm run build -- --base=/talkinghead/
npm run serve:pages
```

In another terminal, run `APP_URL=http://127.0.0.1:4173/talkinghead/ PAGES_CONTRACT=1 npm run smoke`. Vite preview is not a Pages substitute because it enables CPU threading.

## Run browser checks

Start the development server or production preview first. The smoke script needs Playwright and a Chromium installation. To install browser test tools without changing the dependency lockfile, run:

```sh
npm install --prefix tmp/browser-tools --no-save --package-lock=false playwright@1.63.0
node tmp/browser-tools/node_modules/playwright/cli.js install chromium
export PLAYWRIGHT_MODULE="$PWD/tmp/browser-tools/node_modules/playwright/index.mjs"
npm run smoke
```

To use an existing installation, set `PLAYWRIGHT_MODULE` to its absolute `playwright/index.mjs` path. Set `CHROMIUM_PATH` to a browser executable if Playwright's managed browser is unavailable.

```sh
APP_URL=http://127.0.0.1:4173/ npm run smoke
```

`APP_URL` must keep its canonical trailing slash, or the script tests the wrong asset paths. The script checks real generated audio, lip-sync timings, early clip playback, later-chunk errors, subtitles, Stop, asset-error retries, controls, and mobile layout. It blocks and counts every external HTTP origin, which keeps the "no CDN, no API" claim honest. It writes results, screenshots, and a generated WAV file to `tmp/smoke/`.

Environment variables:

- `APP_URL`. Target URL, default `http://127.0.0.1:3000/`.
- `SMOKE_OUTPUT`. Output directory, to keep separate runs.
- `FORCE_WASM=1`. Disables WebGPU in the test browser.
- `GPU_TEST=1`. On a Linux Vulkan-capable machine, checks that speech still uses WASM while GPU rendering is available.
- `PAGES_CONTRACT=1`. Checks the `/talkinghead/` path, absent isolation headers, actual worker non-isolation, same-origin assets, no service worker, and repeat initialization.
- `SOURCE_REVISION`. Recorded in the result for provenance.

## Verify spoken words

The browser checks prove playback, not intelligibility. A separate local Whisper check compares the generated speech with the requested words. It needs `uv`, the `faster-whisper` package, and a cached Whisper-small model. Download this optional test model once, then run the check:

```sh
uv run --no-project --with faster-whisper python -c 'from faster_whisper import WhisperModel; WhisperModel("small", device="cpu", compute_type="int8")'
uv run --no-project --with faster-whisper python scripts/verify-speech.py tmp/smoke/generated.wav --expected 'Hello, this is a local speech test.'
```

The test model is separate from the app. The check itself loads only cached models. A transcript mismatch exits with code 1. Missing tools, models, or unreadable audio exit with code 2. Speech recognition is a regression check, not a human judgment of audio quality.

## Measure startup and first audio

With the server running and Playwright available, run:

```sh
SOURCE_REVISION="$(git rev-parse HEAD)" PLAYWRIGHT_MODULE="$PWD/tmp/browser-tools/node_modules/playwright/index.mjs" npm run measure
```

Use the revision of the source actually built. Remote Pages runs can read that revision from `build-info.json` instead. The script uses five fresh browser contexts and a fixed two-sentence phrase. Results and generated samples go to `tmp/speech-measurement/`. Set `BEFORE_URL` to another local version to alternate before and after runs. Check the generated samples with the recognition script before interpreting latency results. [performance.md](performance.md) defines the timers and the caveats that apply to every number.

## CPU threads and isolation headers

The Vite development and preview servers send these response headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These make the page cross-origin isolated, which allows shared-memory WASM threads. The speech worker then uses up to four CPU threads (`min(4, navigator.hardwareConcurrency)`).

GitHub Pages does not provide custom isolation headers, so the public site uses one speech thread. To get threads on your own host, configure the same two headers and serve all app assets from the same origin. These headers affect embedding and third-party resources if you add them later.

## Troubleshooting

**An asset fails to load.** Restore the connection and click **Retry**, or **Retry avatar** for an avatar failure. Files already in the browser cache are reused.

**The status never reaches READY.** Initialization downloads the 88.1 MiB model, the WASM runtime, the dictionary, and a voice on a cold cache. Keep the page open and wait. A slow connection adds download time before model setup can finish.

**No sound on Speak.** Audio playback needs a user gesture. Click **Speak** again if the browser blocked the first attempt.

**Speech uses WASM even though the machine has a GPU.** Intended. Testing on an AMD GPU produced unintelligible WebGPU output, so the app never selects that speech path. The avatar renderer can still use the GPU.

**Long text pauses between sentences.** Text is split into model-sized clips. A gap occurs if the CPU cannot generate the next clip before the current clip ends.

**CPU use continues after Stop.** Stop halts audio playback immediately. A model pass already executing continues until it returns, but the app ignores its cancelled result.

**`npm audit` reports advisories.** They are in the Tailwind 3 development-tool chain. Do not expose the development server to untrusted networks. A dependency migration is separate work.

## Where things live

| Concern | Location |
| --- | --- |
| React UI | `src/App.tsx` |
| Avatar state, playback queue, controls | `src/lib/avatar-controller.ts` |
| Speech worker client, WAV and timing validation | `src/lib/local-speech.ts` |
| Same-origin asset URLs | `src/lib/runtime-assets.ts` |
| Speech worker (phonemes, Kokoro inference, WAV encoding) | `src/vendor/headtts/worker-tts.mjs` |
| Vendored HeadTTS runtime and notices | `src/vendor/headtts/`, `public/headtts/` |
| Model, voices, dictionary, avatar | `public/models/`, `public/headtts/dictionaries/`, `public/avatars/` |
| Browser smoke checks | `scripts/smoke.mjs` |
| Latency benchmark | `scripts/measure-speech.mjs` |
| Speech recognition check | `scripts/verify-speech.py` |
| Deployment workflows | `.github/workflows/` |
