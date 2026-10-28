#!/usr/bin/env bash
# Download a whisper.cpp model into data/models/ (gitignored, mounted at /app/data/models). Run once on the host:
#   ./scripts/fetch-model.sh            # ggml-small-q5_1 (multilingual, ~190 MB), the default in config
#   ./scripts/fetch-model.sh base       # ggml-base (multilingual, ~148 MB), faster, weaker on Hindi
# Multilingual models only (no .en): voice notes mix Hindi and English.
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL=${1:-small-q5_1}
case "$MODEL" in *.en*) echo "use a multilingual model, not $MODEL" >&2; exit 1 ;; esac
mkdir -p data/models
OUT="data/models/ggml-$MODEL.bin"
if [ -s "$OUT" ]; then echo "$OUT already there ($(du -h "$OUT" | cut -f1))"; exit 0; fi
curl -fL --retry 3 -o "$OUT.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
[ "$(stat -c %s "$OUT.part")" -gt 10000000 ] || { echo "download too small, not a model" >&2; rm -f "$OUT.part"; exit 1; }
mv "$OUT.part" "$OUT"
echo "saved $OUT ($(du -h "$OUT" | cut -f1)); set transcription.model to \"ggml-$MODEL.bin\" if it isn't the default"
