#!/bin/sh
# Build the RE Lab's tm8 space skills (reverse-engineer-anything, re-lab-rules) into
# <lab>/build/skills/<name>.json. REA's own skill and licence are copied once out of the
# image's rea-agents package into <lab>/share/rea-agents-<version>, read-only, so the
# skill's reference links resolve on this host. See tools/rea/README.md#skills.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cfg=$here/../rea-sandbox.json
lab=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lab"])' "$cfg")
image=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$cfg")
share=$lab/share/rea-agents-${image##*:}
if [ ! -d "$share" ]; then
  mkdir -p "$lab/share"
  tmp=$(mktemp -d "$lab/share/.rea-agents.XXXXXX")
  docker run --rm --runtime runsc --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint sh "$image" \
    -c 'cd "$(npm root -g)/rea-agents" && tar -cf - skills/reverse-engineer-anything LICENSE DISCLAIMER.md' |
    tar -xf - -C "$tmp" --no-same-owner --no-same-permissions
  find "$tmp" -type f -exec chmod 0444 {} +
  find "$tmp" -type d -exec chmod 0555 {} +
  mv "$tmp" "$share"
fi
python3 -I "$here/build-skills.py" "$share" "$lab/build/skills"
