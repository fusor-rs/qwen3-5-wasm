# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

qwen3-5-wasm is Qwen's Qwen3.5-2B (Qwen/Qwen3.5-2B): the model, a
vision-language model (a NaViT vision encoder and Qwen3.5's hybrid language
model, the gated delta rule and gated attention), running in the browser on the
CPU, sealed from the network, holding a conversation about text, images and
videos and streaming each reply, its reasoning apart when it thinks first. The
README describes what it does; don't invent scope, features or options beyond
the task.

## Repository

- `vendor/fusor-ai/models/qwen3-5/runtime`: the wasm-bindgen surface of the
  model (bundle parts, each turn's message as JSON and its images' and video
  frames' RGBA pixels with their layout in, the reply so far as JSON out, and a
  reset for a new conversation), built as four browser runtimes.
- `vendor/fusor-ai/models/qwen3-5/cli`: the native CLI `qwen3-5` (`compile`,
  `chat`, `bench`, `parity`).
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace (fusor pins wasm-bindgen 0.2.117, the runtime 0.2.129): the
  conversation, the next message, how to reply and the live measurements as Rust
  signals in `src/app.rs`, the example messages in `src/examples.rs` and
  `public/examples/`, the template in `web/index.html`, the engine bridge, the
  image decoding and the video sampling in `web/app.js`, and in `engine/` the
  engine worker, beside the runtimes `just runtimes` builds.
- `scripts/`: the checkpoint and media downloads (pinned, sha256-checked), the
  frames of the fixed video as the reference samples them (`frames.py`), its
  WebM for browsers (`webm.py`), the Node smoke test and the agreement with the
  reference (`agreement.mjs`), and the README's images (`render-images.mjs`);
  `e2e/run.mjs`: the headless Chrome run; `fixtures/`: the conversations and the
  reference's replies.
- [fusor-ai](https://github.com/fusor-rs/fusor-ai): the model (`qwen3-5`), its
  compiler (`qwen3-5-compile`), the kernels, blocks and bundle format come from
  `vendor/fusor-ai`, a git submodule pinned to a commit pushed to fusor-ai, with
  the browser loader and compute pool, the runtime build, the import check and
  the dev server.

What belongs where: model code (the chat template, the tensor names, the media's
patches, the sampling and the conversation's state) and anything another model
could reuse go to fusor-ai, following its `AGENTS.md`. This repository holds what
turns the model into an app: the page, the checks against the reference and the
deployment. A change to fusor-ai lands there first; this repository never
patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own, with the parity results and the e2e
  result it gave. No copies of fusor-ai code here.
- The reference is transformers' `Qwen3_5ForConditionalGeneration` and the
  checkpoint's processor at the pinned revision and the versions the justfile
  pins, in f32 on the CPU, each conversation turn by turn, each reply greedy.
  Every turn's prompt must be the reference's, token for token; every fixed
  reply must state the facts its turn expects.
- The page owns every capability: decoding the images, sampling the videos
  (files, drops or pastes) to RGBA frames, drawing each reply's seed, caching the
  bundle (OPFS) and measuring itself. The runtime receives the pixels, their
  layout and the message, and does no I/O. Nothing is fetched while replying.
- The weights are Apache-2.0: the page and the README credit Qwen with links,
  and the bundle ships the license beside it (`model/LICENSE`). Don't remove it.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtime and the CLI. A change to the runtime,
the page, the CLI or fusor-ai also needs `just runtimes`, `just smoke`, `just
parity` (the same results as before unless the change is meant to move them) and
`just e2e`, whose every fixed reply must state the facts its turn expects; a
change meant to move speed also needs `just bench`. The model is checked stage
by stage against the reference goldens by `qwen3-5 parity`; extend it rather
than adding a parallel harness.

## Measuring

A speed change is judged on the page (`web-threaded-relaxed`, 8 workers, headless
Chrome through `just e2e`): the time from Send to the first token and the tokens
written per second after it. Medians of at least three fresh-profile runs with
their spread and the machine's load average; a change smaller than the spread is
not a result, and nothing else runs on the machine during a measurement. `qwen3-5
bench` explains where the time went, stage by stage. Numerically every accepted
change is bit-exact unless it is meant to move the numbers: the fixed
conversations get the same replies, `just parity` prints the same digits.
fusor-ai's `knowledge.md` records what the measurements taught about V8, the
kernels and their stores.

## Commits

- Don't commit, push, tag, release or deploy unless asked.
- Clone fusor repositories with
  `https://andreespirela@github.com/fusor-rs/<name>.git`.
