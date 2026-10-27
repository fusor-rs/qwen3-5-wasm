---
title: qwen3-5-wasm
short_description: Chat with Qwen3.5-2B, images and video, on your CPU
sdk: static
app_file: index.html
pinned: false
license: apache-2.0
models:
  - fusorlabs/qwen3.5-2b-web
  - Qwen/Qwen3.5-2B
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

A conversation about text, images and videos with Qwen's
[Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B), computed on your own CPU in the browser:
the model, compiled to WebAssembly with fusor-ai, downloads once and then runs sealed from the
network, writing each reply as you read it. The model is Apache-2.0; its license ships beside the
bundle as `model/LICENSE`. The page's code is MIT; its source is
[github.com/fusor-rs/qwen3-5-wasm](https://github.com/fusor-rs/qwen3-5-wasm).
