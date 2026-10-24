#!/usr/bin/env bash
# Downloads the fixed media the checks read into $1, from the d3 model card's examples
# (vllm-sr/d3-nano, Apache-2.0) at a pinned revision, each checked by sha256 (files already present
# are only checked). Each goes with its conversation in `fixtures/conversations.json`.
set -euo pipefail
DIR="$1"
REPO="https://huggingface.co/vllm-sr/d3-nano/resolve/462efc366229ea268cf4eed3738b3fc4415e4817"
FILES="
b9dbb8b103bacd45f1de824d844a3c07b81d57cb1a7466712ef060ad7dcb3926  assets/example-receipt.png
f4968ef89d07e97f20df4fd8047510a7a8e9df5c2d07c35e363a97927f164ab9  assets/example-video.mp4
"
mkdir -p "$DIR"
while read -r _ path; do
  file="$(basename "$path")"
  if [ -z "$path" ] || [ -s "$DIR/$file" ]; then continue; fi
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$REPO/$path"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { n = split($2, parts, "/"); print $1 "  " parts[n] }' <<< "$FILES" | shasum -a 256 -c --quiet -)
