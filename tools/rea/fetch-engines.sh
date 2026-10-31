#!/bin/sh
# Fetch the RE Lab engines that ship as release binaries into <lab>/engines, each checked
# against a pinned sha256 before it is unpacked. An engine folder that already exists is kept.
#
#   tools/rea/fetch-engines.sh             all six
#   tools/rea/fetch-engines.sh rizin ...   only these (ghidra jadx apktool kuna rizin wabt)
#
# The sha256s are GitHub's own release-asset digests, except Rizin 0.7.4: its 2024 asset has
# no digest, so its sha256 is the one recorded at the first fetch (2026-10-31). Archives are
# only unpacked here, never run; their binaries run inside rea-sandbox. Engines with no usable
# release binary (Binwalk, Unblob, pwntools, pwndbg, Chromium, the IDA bridge) come from
# tools/rea/build-engines.sh; the owner's IDA, Hopper and JEB from `rea-sandbox setup`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
lab=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lab"])' "$here/rea-sandbox.json")
dl=$lab/downloads
mkdir -p "$dl" "$lab/engines"

# name  engine-dir  format  folder-inside-the-archive  sha256  url
engines='
ghidra  ghidra_12.1.4_PUBLIC  zip  ghidra_12.1.4_PUBLIC  ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db  https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
jadx    jadx                  jar  -                     6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75  https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar
apktool apktool               jar  -                     dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423  https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar
kuna    kuna-1.833            tar  -                     e9f047fb5a93925ede6d869df22c26c1c0ced90764ace7467ae90f880625d530  https://github.com/Noelo-Lab/kuna/releases/download/v1.833/kuna-v1.833-linux-x86_64.tar.gz
rizin   rizin-0.7.4           tar  -                     db51f7c2def9c5c09df4e4102e9e294a030c77bd92a319ced6ec216293064d63  https://github.com/rizinorg/rizin/releases/download/v0.7.4/rizin-v0.7.4-static-x86_64.tar.xz
wabt    wabt-1.0.42           tar  -                     84895407a6bbb80e918f33b16b2fb2206021c150b6bc9ff6f761263a745ab131  https://github.com/WebAssembly/wabt/releases/download/1.0.42/wabt-1.0.42-linux-x64.tar.gz
'

fetch() {  # url sha256: prints the verified download's path
  f=$dl/$(basename "$1")
  if [ -f "$f" ] && echo "$2  $f" | sha256sum -c --quiet - >/dev/null 2>&1; then
    echo "$f"
    return
  fi
  curl -fsSL --retry 3 -o "$f.part" "$1"
  if ! echo "$2  $f.part" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -f "$f.part"
    echo "fetch-engines: sha256 mismatch for $1" >&2
    exit 1
  fi
  mv "$f.part" "$f"
  echo "$f"
}

want=" $* "
echo "$engines" | while read -r name dir format inner sha url; do
  [ -n "$name" ] || continue
  [ "$want" = "  " ] || case $want in *" $name "*) ;; *) continue ;; esac
  dest=$lab/engines/$dir
  if [ -e "$dest" ]; then
    echo "$name: $dest exists, kept"
    continue
  fi
  f=$(fetch "$url" "$sha")
  tmp=$(mktemp -d "$lab/engines/.fetch-$name.XXXXXX")
  case $format in
    jar) cp "$f" "$tmp/" ;;
    zip) unzip -q "$f" -d "$tmp" ;;
    tar) tar -xf "$f" -C "$tmp" --no-same-owner ;;
  esac
  if [ "$inner" = - ]; then
    chmod 0755 "$tmp"
    mv "$tmp" "$dest"
  else
    mv "$tmp/$inner" "$dest"
    rmdir "$tmp"
  fi
  echo "$name: $dest (sha256 $sha)"
done
