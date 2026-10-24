# Qwen3.5-2B in the browser. `just ui` builds everything, the model included, and serves the page;
# `just build` then `just serve` do the same in two steps.

import 'vendor/fusor-ai/just/product.just'

name := "qwen3-5"
# The bundle is 2.5 GB, the conversation's state and the activations up to another 0.9 GB.
export MAX_MEMORY := "4294967296"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/checkpoint")
conversations := "fixtures/conversations.json"
goldens := "fixtures/goldens"
media := "fixtures/media"
# The reference the goldens come from (vendor/fusor-ai/models/qwen3-5/reference): transformers,
# pinned.
reference := "uv run --no-project --python 3.12 --with transformers==5.17.0 --with torch==2.9.1 --with torchvision==0.24.1 --with numpy==2.5.4 --with pillow==13.0.0 --with opencv-python-headless==5.0.0.93 --with safetensors==0.8.0 --with huggingface-hub==1.33.0 --with accelerate==1.15.0 python"

host:
    bash -n scripts/fetch-checkpoint.sh
    bash -n scripts/fetch-media.sh
    python3 -m py_compile scripts/frames.py
    python3 -m py_compile scripts/webm.py
    node --check app/web/app.js
    node --check app/engine/worker.js
    node --check scripts/node-smoke.mjs
    node --check e2e/run.mjs
    node --check scripts/render-images.mjs

# Downloads the pinned checkpoint (4.5 GB, sha256-checked) unless it is already there, then
# compiles the bundle into dist/model, its license beside it.
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/qwen3-5 compile {{checkpoint}} {{model}}
    cp {{checkpoint}}/LICENSE {{model}}/

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# The fixed media the checks read: the d3 model card's example receipt and video at a pinned
# revision (sha256-checked), the video's frames as the reference samples them, and the video as
# browsers decode it (VP9, lossless), which the page's example and `just e2e` read.
media:
    scripts/fetch-media.sh {{media}}
    scripts/fetch-checkpoint.sh {{checkpoint}}
    test -f {{media}}/example-video.mp4.frames/sampled.json || {{reference}} scripts/frames.py {{checkpoint}} {{conversations}} {{media}}
    test -f {{media}}/example-video.webm || uv run --no-project --python 3.12 --with imageio-ffmpeg==0.6.0 python scripts/webm.py {{conversations}} {{media}}

# Every stage against the reference's goldens (vendor/fusor-ai/models/qwen3-5/reference).
parity: model media
    test -f {{goldens}}/golden_f32_colors.safetensors || just goldens
    target/release/qwen3-5 parity {{model}} {{goldens}}/golden_f32_colors.safetensors {{goldens}}/golden_f32_receipt.safetensors {{goldens}}/golden_f32_clip.safetensors

# Golden tensors of every conversation, and the reference's replies (fixtures/references.json),
# from the reference in f32 on the CPU.
goldens: media
    {{reference}} {{fusor_ai}}/models/qwen3-5/reference/dump.py {{checkpoint}} {{conversations}} {{media}} {{goldens}} fixtures/references.json

# Every conversation of the fixtures, replied to by the native CLI.
chat: native media
    target/release/qwen3-5 chat {{model}} {{conversations}} --media {{media}}

bench case="receipt": native media
    target/release/qwen3-5 bench {{model}} {{conversations}} {{case}} --media {{media}}

# The fixed inputs the checks read.
fixtures: media
