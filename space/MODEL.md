---
license: apache-2.0
base_model:
  - Qwen/Qwen3.5-2B
pipeline_tag: image-text-to-text
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
---

# Qwen3.5-2B, compiled for the browser

Qwen's [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) compiled into a
[fusor-ai](https://github.com/fusor-rs/fusor-ai) bundle: the weights the browser runtime of
[qwen3-5-wasm](https://github.com/fusor-rs/qwen3-5-wasm) loads to talk about text, images and
videos on the device's CPU. Try it in the Space
[fusorlabs/qwen3-5-wasm](https://huggingface.co/spaces/fusorlabs/qwen3-5-wasm).

- **Source:** `Qwen/Qwen3.5-2B` at revision `15852e8c16360a2fea060d615a32b45270f8a8fc`,
  compiled with the `q7` profile: every large matrix 7-bit (2517 MB).
- **Format:** `manifest.json` lists every tensor and part; each part is named by its BLAKE3 hash,
  which the runtime checks as it loads.
- **Reproduce it:** `just model` in qwen3-5-wasm downloads the checkpoint and compiles the same
  bundle.

This is not a PyTorch or safetensors checkpoint: it only loads in the qwen3-5-wasm runtime.

The model is Apache-2.0 ([LICENSE](LICENSE)).
