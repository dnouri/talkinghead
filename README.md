# TalkingHead speech avatar

Type text, and a 3D avatar in the browser tab says it out loud with lip sync and subtitles. No speech server, no API key, no account. The speech model downloads from the same static site and runs on your CPU. The app sends no text to a speech service.

[Open the live demo](https://dnouri.github.io/talkinghead/).

## What it does

- Speaks typed English text in nine voices, five US and four British.
- Syncs lips and subtitles to the generated audio, word by word.
- Plays the first generated clip while later chunks are still generating.
- Offers moods, gestures, camera views, and optional cursor following.
- Runs fully client-side with a Web Worker, WASM inference, Web Audio, and a Three.js avatar.

## How it works

![Component diagram. A browser tab holds the React UI and AvatarController, a speech Web Worker with the English dictionary and the Kokoro 82M model on WASM, and TalkingHead with Web Audio. Same-origin assets sit on GitHub Pages. A publishing row shows git push to main, GitHub Actions, GitHub Pages.](docs/architecture.svg)

[Edit the diagram](docs/architecture.excalidraw) by dropping the file onto [excalidraw.com](https://excalidraw.com).

GitHub Pages serves a static Vite and React build. The avatar loads with the page. **Initialize voice engine** loads the 88.1 MiB quantized Kokoro model, a voice, the pronunciation dictionary, and the WASM runtime. Other voices load on first use.

A Web Worker uses [HeadTTS](https://github.com/met4citizen/HeadTTS) pronunciation and timing code with [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped) through [Transformers.js](https://github.com/huggingface/transformers.js). It returns speech clips with word and mouth-shape timings. [TalkingHead](https://github.com/met4citizen/TalkingHead) schedules the sound, facial animation, and subtitles. The model stays off the UI thread so the controls remain usable.

Every push to `main` runs checks and a build in GitHub Actions, then publishes the `dist/` directory to GitHub Pages. The workflows live in [.github/workflows/](.github/workflows/).

## What it is not

- Not a chatbot. It reads your text aloud and does not think, and it never pretends otherwise.
- Not a speech API client. There is no server component and no key to leak.
- Not an offline app. Browser caching keeps assets warm between visits, but nothing guarantees a permanent offline installation.
- Not verified outside Chromium-based browsers yet. Other engines are unverified, not unsupported.

## What to expect

Honest findings instead of promises.

- The first visit downloads on the order of 100 MB of model, runtime, and media assets. Later visits reuse the browser cache.
- The public site uses one WASM thread. GitHub Pages does not provide the isolation headers needed for threading. The local development server permits up to four threads.
- Speech speed depends on your CPU. Slower machines may pause between chunks on long texts.
- **Stop** halts playback immediately and discards cancelled results. An inference already running still uses the CPU until it returns. The model does not take hints mid-sentence.
- All voices use the same US English pronunciation dictionary. The British voices cope bravely.

The timing method and hosting limits are in [docs/performance.md](docs/performance.md).

## Run it locally

You need Node.js 22.12 or later and a current Chromium-based browser.

```sh
npm ci
npm run dev
```

Open the URL Vite prints, usually `http://localhost:3000/`. Click **Initialize voice engine**, wait for **READY · WASM**, type text, click **Speak**. Commands, browser checks, and troubleshooting are in [docs/development.md](docs/development.md).

## Documentation

- [Development](docs/development.md). Commands, smoke checks, speech verification, and troubleshooting.
- [Performance](docs/performance.md). How timings are measured and what limits them.
- [Asset sources](docs/asset-sources.json). Pinned upstream URLs and hashes for the bundled model, voices, dictionary, and avatar.
- [Third-party notices](THIRD-PARTY-NOTICES.md). License texts of the bundled components and assets.

## License

The application code itself has no license yet. Public visibility is not a license grant. Bundled third-party components and assets keep their own terms, listed in the notices above. The avatar is a reproducible optimization of the CC0 `mpfb.glb` published with TalkingHead.
