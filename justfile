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

# Its tensor parts are named by their BLAKE3, so /model/parts/ can be cached as immutable.
# The page, its four runtimes and the bundle beside it, as a static site in target/site.
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    node scripts/site-bundle.mjs {{model}} target/site/model
    cp {{model}}/LICENSE target/site/model/

# The Space holds at most 1 GB, so it gets the page, the runtimes and the model's licenses, and the
# page loads the bundle from the model repo fusorlabs/qwen3.5-2b-web (`just deploy-model`). The Space must
# already exist as a static Space: creating it with the upload makes a Gradio Space, which
# Hugging Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/qwen3-5-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --include NOTICE --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
    import sys
    from huggingface_hub import HfApi

    HfApi().upload_folder(
        repo_id="fusorlabs/qwen3-5-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy qwen3-5-wasm {{version}}",
    )
    PY

# Deploy it before the Space whenever the bundle changes: the runtime only loads a bundle compiled
# with the same fusor-ai.
# The site's bundle, with space/MODEL.md as its card, to the model repo fusorlabs/qwen3.5-2b-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/MODEL.md target/site/model/README.md
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/qwen3.5-2b-web", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/qwen3.5-2b-web",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy the qwen3-5-wasm {{version}} bundle",
    )
    PY

# The fixed inputs the checks read.
fixtures: media
