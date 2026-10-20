# Third-party notices

No license has been selected for the original application code. Public repository visibility is not a license grant. This file records third-party terms and does not apply them to the application as a whole.

## Package code and fonts

The [readable license index](public/licenses/index.html) and [machine-readable inventory](public/licenses/packages/index.json) cover all 210 non-development entries in `package-lock.json`. The inventory includes optional native binaries, Node-only dependencies, and packages that the browser does not import. It is not a claim that every listed package is bundled.

The index preserves original copyright and license texts, including embedded third-party notices. Core components include the following packages:

| Component | Declared terms | Original text |
| --- | --- | --- |
| React 19.3.1 and React DOM 19.3.1 | MIT | [React](public/licenses/packages/react@19.3.1/LICENSE), [React DOM](public/licenses/packages/react-dom@19.3.1/LICENSE) |
| Three.js 0.180.0 | MIT | [Three.js](public/licenses/packages/three@0.180.0/LICENSE) |
| TalkingHead 1.7.0 | MIT | [TalkingHead package](public/licenses/packages/met4citizen__talkinghead@1.7.0/LICENSE) |
| meshoptimizer 1.3.0 | MIT | [meshoptimizer](public/licenses/packages/meshoptimizer@1.3.0/LICENSE.md) |
| Transformers.js 4.3.1 | Apache-2.0 | [Transformers.js](public/licenses/packages/huggingface__transformers@4.3.1/LICENSE) |
| ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0 | MIT, with third-party notices | [MIT license](public/licenses/upstream/ort-web-LICENSE), [complete upstream third-party notices](public/licenses/upstream/ort-web-ThirdPartyNotices.txt) |
| Space Grotesk, supplied by @fontsource/space-grotesk 5.3.0 | OFL-1.1 | [Font copyright and license](public/licenses/packages/fontsource__space-grotesk@5.3.0/LICENSE) |
| IBM Plex Mono, supplied by @fontsource/ibm-plex-mono 5.3.0 | OFL-1.1 | [Font copyright and license](public/licenses/packages/fontsource__ibm-plex-mono@5.3.0/LICENSE) |
| Modified vendored HeadTTS 1.3.0 code | MIT | [Copyright and license](public/headtts/LICENSE), [modification notice](public/headtts/NOTICE.txt) |

Space Grotesk retains copyright 2020 The Space Grotesk Project Authors. IBM Plex Mono retains copyright 2017 IBM Corp. The application uses unmodified packaged font files. The font licenses do not determine the application's code license.

### Qualified package records

Two packages omit a license body from their exact npm packages:

- `guid-typescript` 1.0.9 declares ISC and author `nicolas`. Its exact package supplies no copyright or license text. Its npm `gitHead` is unavailable in the upstream repository, whose inspected current tree also has no license file. The inventory preserves the declaration without inventing a copyright notice or grant.
- `react-remove-scroll-bar` 2.3.8 declares MIT. Its npm `gitHead` is unavailable upstream. The inventory includes a pinned upstream MIT text, copyright 2025 Anton Korzunov. That repository snapshot identifies package version 2.3.7, so it is not a proven source match to 2.3.8.

These qualifications remain visible in the public index. Optional Sharp/libvips native dependencies retain their package terms and upstream third-party notice table. They are included in the conservative lockfile inventory, not distributed as native binaries by this browser app.

## Avatar, model, voices, and dictionary

Package code licenses do not automatically license example avatars, model weights, voices, or dictionary data. Their sources and SHA-256 values are recorded separately in [docs/asset-sources.json](docs/asset-sources.json).

### Avatar

`public/avatars/avatar.glb` is a new optimization of TalkingHead's `avatars/mpfb.glb` at commit `2afe6d79779313db8909badebf46f9805a6c7b70`. The [pinned upstream README](public/licenses/avatar/TalkingHead-README.md) specifically declares that avatar CC0 and identifies Blender and MPFB as its creation tools. The [CC0 text](public/licenses/avatar/CC0-1.0.txt) and [preparation record](public/licenses/avatar/NOTICE.txt) accompany the file.

The TalkingHead package's MIT license is not the basis for this avatar's terms. No other TalkingHead example avatar is included.

### Kokoro model

The quantized timestamped model, tokenizer, and configuration files exactly match `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` at revision `dd4401a9add81ac692d20e240d22ec9dda82cc29`. Its [model card](public/licenses/assets/Kokoro-timestamped-model-card.md) declares Apache-2.0 and identifies `hexgrad/Kokoro-82M` as its base model.

### Voice files

The nine unchanged voice files exactly match `onnx-community/Kokoro-82M-v1.0-ONNX` at revision `468588286ebb2dd77c25b9771e5d165896538cce`. Its separate [model card](public/licenses/assets/Kokoro-voice-model-card.md) declares Apache-2.0.

The [standard Apache-2.0 text](public/licenses/assets/Apache-2.0.txt) accompanies the model and voices. A standalone `LICENSE` was not available at the investigated upstream model repository URLs. The copied standard text is not presented as a downloaded model-repository license file. The cards and exact file identities are the recorded evidence.

### Pronunciation dictionary

The HeadTTS-derived `en-us.txt` retains its embedded CMUdict copyright, redistribution conditions, and disclaimer. Copyright is 1993-2015 Carnegie Mellon University. An unchanged copy of the header is in [CMUdict-NOTICE.txt](public/licenses/assets/CMUdict-NOTICE.txt).

## Scope and reproduction

These records establish file identity and preserve upstream declarations. They are not blanket legal clearance of training data, voice likeness, or all underlying rights. No model or voice bytes changed during this provenance work.

`node scripts/prepare-avatar.mjs` reproduces the avatar twice with a pinned, locked toolchain installed only in `tmp/publish/assets/prepare-avatar/`. It verifies the recorded output hash and the published avatar. Add `--write` to replace the public file only after those checks pass.

`node scripts/prepare-licenses.mjs` verifies production dependency coverage and notice hashes. Add `--write` to regenerate the inventory from installed locked packages and integrity-checked npm archives for missing optional packages. Immutable upstream sources fill package notice omissions where evidence exists. Neither script installs dependencies in the application directory.
