# Third-party notices

Chart Forge's own work is released under the [MIT License](LICENSE). This file records
what that license does **not** cover: the libraries and AI models Chart Forge depends on,
and the third-party content people use it with.

This is an informational inventory, not legal advice. A license marked **UNVERIFIED** was
not confirmed from an authoritative source during the audit and must not be assumed to be
MIT or any other license.

## Audit basis

Audited on 2026-10-29 against commit `4df4d26`. Sources, in order of authority:

| Component | Source of truth |
| --- | --- |
| Analyzer | `analyzer/requirements*.txt` for the direct set; license metadata from each package's installed `*.dist-info` in the repository's `.venv` |
| Editor (JavaScript) | `editor/package.json` and the `license` field of every entry in `editor/package-lock.json` |
| Editor (Rust) | `editor/src-tauri/Cargo.toml`; `cargo metadata --locked --offline` over `Cargo.lock`, filtered to `x86_64-pc-windows-msvc` |
| Player | its import graph (`player/server.mjs`, `player/web/*.js`, `player/tests/*.mjs`) |
| Model weights | the upstream project's own README / LICENSE, quoted below |

A package's license is its *declared* license from that metadata. Package files were not
individually re-audited.

## What this repository redistributes

**No third-party code, model weights or media are committed to this repository.** All
dependencies are fetched by the user from their registries (PyPI, the PyTorch index,
npm, crates.io), and all model weights are either downloaded on first use into the user's
PyTorch cache or shipped inside the package that provides them.

Redistribution obligations therefore arise only for someone who distributes a **built or
packaged** artefact - for example an Editor installer, which statically links the Rust
crates and bundles the JavaScript production dependencies, or a copied Python
environment. Such a distributor must carry the notices of whatever that artefact contains.
This repository does not currently produce or publish such artefacts.

## Rights at a glance

| Material | Terms |
| --- | --- |
| Chart Forge source code (`analyzer/`, `editor/`, `player/`, `tests/`, launch scripts) | MIT |
| JSON Schemas (`schemas/`) | MIT |
| Documentation (`README.md`, `docs/`, component READMEs) | MIT |
| Example documents (`examples/`) and test fixtures (`tests/fixtures/`, `player/tests/fixtures/`) | MIT. Original, synthetic data written for this project; they reference audio files that are not in the repository. |
| Editor icon (`editor/src-tauri/icons/icon.ico`) | MIT. A plain lanes-and-notes glyph added in the project's own commit `5b525f3`. |
| Charts authored by users | Belong to their authors as far as the law gives rights in them. Chart Forge claims none. Rights in the underlying music remain with their holders. |
| Songs, recordings, lyrics | Not covered by the MIT License. Owned by their rights holders. |
| Stems separated from a recording | Not covered by the MIT License. They are derived from the recording and stay subject to its rights; the Analyzer writes them beside the source audio, outside this repository. |
| Analysis documents produced from a recording | The MIT License grants no rights in the recording they describe. |
| Game images, sounds, chart data, titles and trademarks | Not covered by the MIT License. Rights remain with their holders; none of this material is included in the repository. |
| Libraries and AI models | Their own licenses, listed below. |

The repository's `.gitignore` excludes audio (`*.wav`, `*.mp3`, `*.flac`, …), separated
stems (`stems/`, `separated/`, `*.stem.*`), the per-song asset root (`.chart-forge/`) and
model checkpoints (`*.pt`, `*.pth`, `*.ckpt`, `*.onnx`, `*.safetensors`, …).

## AI model weights

The code license of a model library does not automatically extend to its weights. They
are listed separately.

| Model | Used by | How obtained | Weights terms | Status |
| --- | --- | --- | --- | --- |
| Demucs `htdemucs_6s` (**Analyzer default**) | `analyzer/separation.py` via demucs-infer | Downloaded on first use from `dl.fbaipublicfiles.com` | Unclear upstream; likely non-commercial (see below) | **Restricted / UNVERIFIED** |
| Demucs `htdemucs` (only with `--model htdemucs`) | same | same | Unclear upstream (see below) | **UNVERIFIED** |
| Beat This! `final0` | `analyzer/beat.py` | Downloaded on first use from `cloud.cp.jku.at` | MIT, stated by upstream for code *and* weights | Verified |
| CREPE `full` (via torchcrepe) | `analyzer/pitch.py` | Shipped inside the torchcrepe wheel | Distributed in the MIT-licensed torchcrepe package; converted from CREPE (MIT, Copyright (c) 2018 Jong Wook Kim), which states no separate weights terms | MIT as distributed; no weights-specific statement |

**Demucs.** The Demucs README (<https://github.com/adefossez/demucs>, section "License")
states that the code is MIT, and then:

> The license of the weights is not clear: MusDB contains some data that were only usable
> for research purpose. […] The 6 source variant of htdemucs was trained only on Meta
> internal dataset, which likely means CC-NC-BY license is applicable, as it was the case
> for all models released by FAIR.

The original `facebookresearch/demucs` repository is archived and states no license for
the weights. demucs-infer uses the same weights. **Until clarified, treat both Demucs
checkpoints as unsuitable for commercial use, and do not redistribute them.** This is the
one known restriction in the Analyzer's default pipeline; replacing the separator is
outside the scope of this notice.

**Beat This!** The README (<https://github.com/CPJKU/beat_this>) states: "The code and the
published model weights are released under the MIT license", and notes that some training
files are copyrighted or under limited Creative Commons licenses, "and it is up to the
user to assess whether this may impact their use case."

**madmom** is not used. The Analyzer runs Beat This! with DBN post-processing off
precisely so that madmom, whose pretrained models are CC BY-NC-SA, is never pulled in.

## Analyzer (Python 3.11)

Direct dependencies, as pinned in `analyzer/requirements*.txt`:

| Package | Version | Declared license |
| --- | --- | --- |
| torch | 2.13.0+cu126 | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT |
| torchaudio | 2.11.0+cu126 | BSD (classifier) |
| beat-this | 1.1.0 | MIT |
| demucs-infer | 4.2.2 | MIT (Copyright Meta Platforms, Inc. and affiliates; Copyright 2025 Bo-Yu Chen) |
| librosa | 0.11.0 | ISC |
| numpy | 2.4.6 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| soundfile | 0.14.0 | BSD-3-Clause |
| torchcrepe | 0.0.24 | MIT |

Transitive dependencies are not pinned by the repository, so the set below is what the
verified environment resolved to. Most are MIT, BSD, ISC, Apache-2.0 or PSF-2.0. The ones
with conditions beyond attribution:

| Package | License | Note |
| --- | --- | --- |
| soxr 1.1.0 | LGPL-2.1-or-later | Weak copyleft; the wheel embeds libsoxr. Imported only, not bundled by Chart Forge |
| llvmlite 0.49.0 | BSD-style (license files only; no license field in its metadata) | Includes LLVM terms in `LICENSE.thirdparty` |
| soundfile's bundled `libsndfile` | LGPL-2.1 | Native library inside the soundfile wheel |
| certifi 2026.7.22 | MPL-2.0 | File-level copyleft |
| tqdm 4.70.0 | MPL-2.0 AND MIT | File-level copyleft |
| CUDA / cuDNN libraries bundled in the `+cu126` torch wheel (`cudnn64_9.dll`, `cublas64_12.dll`, …) | NVIDIA's own license terms | **UNVERIFIED** - not assessed in this audit |

None of these conflict with Chart Forge's code being MIT: Chart Forge only imports them
and does not redistribute them. Anyone who redistributes a Python environment must follow
the LGPL, MPL-2.0 and NVIDIA terms for the parts that carry them.

## Editor

### JavaScript (`editor/package-lock.json`, 167 packages)

| Package | Version | Declared license | Used |
| --- | --- | --- | --- |
| react | 19.2.8 | MIT | runtime |
| react-dom | 19.2.8 | MIT | runtime |
| scheduler (via react-dom) | 0.27.0 | MIT | runtime |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT | runtime |
| @tauri-apps/plugin-dialog | 2.7.3 | MIT OR Apache-2.0 | runtime |
| @tauri-apps/cli | 2.11.4 | Apache-2.0 OR MIT | build only |
| vite | 7.3.6 | MIT | build only |
| @vitejs/plugin-react | 5.2.0 | MIT | build only |
| typescript | 5.9.3 | Apache-2.0 | build only |
| vitest | 3.2.7 | MIT | test only |
| @types/react, @types/react-dom | 19.2.18, 19.2.7 | MIT | build only |

Across the whole lockfile: 142 MIT, 14 dual Apache-2.0/MIT, 6 ISC, 3 Apache-2.0,
1 BSD-3-Clause, and 1 CC-BY-4.0 (`caniuse-lite`, browser-support data used by the build
tooling only). Every package declares a license; none is copyleft.

### Rust (`editor/src-tauri/Cargo.lock`, 266 third-party crates on Windows)

Direct crates: tauri 2.11.5, tauri-build 2.6.3, tauri-plugin-dialog 2.7.3 (all Apache-2.0
OR MIT); serde 1.0.229, serde_json 1.0.151, sha2 0.10.9 (all MIT OR Apache-2.0).

Across the resolved Windows dependency graph, every crate declares a license. The large
majority are MIT and/or Apache-2.0 (some combined with BSD-3-Clause or Unicode-3.0); the
rest are Unicode-3.0 (18 crates, Unicode data), Unlicense OR MIT, Zlib, BSD-3-Clause,
CC0-1.0 OR MIT-0 OR Apache-2.0, 0BSD OR MIT OR Apache-2.0, and **MPL-2.0** for five crates (`cssparser`, `cssparser-macros`, `dtoa-short`,
`selectors`, `option-ext`).

A distributed Editor binary statically links these crates and must carry their license
notices; the MPL-2.0 crates additionally require that recipients be told where their
source is available (crates.io). No Editor binary is distributed today. The WebView2
runtime the Editor relies on on Windows is Microsoft's and is not bundled by this
repository; its terms were not assessed.

## Player

The Player uses only Node.js built-in modules (`node:http`, `node:fs`, `node:path`,
`node:test`, …) and the browser's own APIs. It has no package manifest, no third-party
JavaScript, and no bundled fonts, images or sounds. Its test fixtures are original.

## Schemas and contract tests

The JSON Schemas are original work. They refer to the JSON Schema 2020-12 meta-schema by
URI only and do not copy it. `tests/validate_contracts.py` uses only the Python standard
library.

## Not verified

- Terms of the Demucs `htdemucs` and `htdemucs_6s` weights (unclear upstream, as quoted).
- NVIDIA terms for the CUDA / cuDNN libraries inside the `+cu126` torch wheel.
- Microsoft WebView2 runtime terms.
- Licenses of the files inside each package beyond the package's declared license.
