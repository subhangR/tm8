#!/bin/sh
# Install rea-sandbox into the RE Lab on this host and build its image.
#   tools/rea/install.sh            launcher -> /home/tm8/rea-lab/bin, config -> .../etc
#   tools/rea/install.sh --build    also (re)build tm8/rea:<version> from tools/rea/Dockerfile
# Keeps <lab>/etc/members.json (teammate id -> role), which is per space and never committed.
# Engines are fetched separately: tools/rea/fetch-engines.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
lab=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lab"])' "$here/rea-sandbox.json")
image=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$here/rea-sandbox.json")
install -d -m 0755 "$lab/bin" "$lab/etc" "$lab/cases" "$lab/run/ghidra-slots" "$lab/engines"
install -m 0755 "$here/rea-sandbox" "$lab/bin/rea-sandbox"
install -m 0644 "$here/rea-sandbox.json" "$here/catalog-6.8.0.json" "$lab/etc/"
[ -f "$lab/etc/members.json" ] || printf '{}\n' > "$lab/etc/members.json"
[ -s "$lab/etc/machine-id" ] || python3 -I -c 'import uuid; print(uuid.uuid4().hex)' > "$lab/etc/machine-id"
# Licensed-engine slots: README, setup and helper scripts. The owner's files go in drop/.
for src in "$here"/slots/*/; do
  dest=$lab/engines/$(basename "$src")
  install -d -m 0755 "$dest"
  [ -f "$src/setup.sh" ] && install -d -m 0700 "$dest/drop"
  (cd "$src" && find . -type f) | while read -r f; do
    if [ -x "$src/$f" ]; then mode=0755; else mode=0644; fi
    install -D -m "$mode" "$src/$f" "$dest/$f"
  done
done
if [ "${1:-}" = "--build" ]; then
  docker build -t "$image" "$here"
fi
docker image inspect "$image" >/dev/null 2>&1 || echo "install.sh: image $image is missing; run with --build" >&2
echo "installed $lab/bin/rea-sandbox (config $lab/etc/rea-sandbox.json)"
