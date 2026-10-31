#!/bin/sh
# Build the RE Lab engines that have no usable release binary, inside a throwaway
# container on the same Debian/Python as tm8/rea, writing into <lab>/engines.
#
#   tools/rea/build-engines.sh firmware   Binwalk 3.1.0 (cargo --locked), Unblob 26.6.4 (venv)
#   tools/rea/build-engines.sh python     pwntools 4.15.0 profile (venv), pwndbg 2026.09.15 (uv.lock)
#   tools/rea/build-engines.sh browser    Debian's chromium for REA's browser tools, with only the
#                                         libraries tm8/rea lacks (built inside tm8/rea itself)
#   tools/rea/build-engines.sh ida        the ida-pro-mcp bridge REA's headless IDA profile drives;
#                                         IDA itself is the owner's (rea-sandbox setup ida)
#
# Venvs keep absolute shebangs, so rea-sandbox must mount each at /engines/<dir> (it does).
# Release-binary engines (Ghidra, Kuna, JADX MCP, apktool, Rizin, WABT) come from
# tools/rea/fetch-engines.sh instead.
set -eu

if [ -z "${IN_BUILD_CONTAINER:-}" ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  lab=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lab"])' "$here/rea-sandbox.json")
  base=$(sed -n 's/^FROM \(node:[^ ]*\).*/\1/p' "$here/Dockerfile")
  what=${1:?usage: build-engines.sh firmware|python|browser|ida}
  [ "$what" = browser ] && base=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$here/rea-sandbox.json")
  mkdir -p "$lab/build/cache"
  exec docker run --rm --network bridge --user 0:0 \
    -v "$lab/engines:/engines" -v "$lab/build/cache:/cache" \
    -v "$here/build-engines.sh:/build-engines.sh:ro" \
    -e IN_BUILD_CONTAINER=1 -e RUN_UID="$(id -u)" -e RUN_GID="$(id -g)" \
    --entrypoint sh "$base" -eux /build-engines.sh "$what"
fi

# ---- inside the build container (root, network on, /engines writable) ----
export DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
# Hand what was built back to the lab's user, even when a step fails.
trap '[ -z "${dirs:-}" ] || chown -R "$RUN_UID:$RUN_GID" $dirs' EXIT
# apt's lists and downloads go to /cache (the lab's disk), not the container layer.
mkdir -p /cache/apt/lists/partial /cache/apt/archives/partial
printf 'Dir::State::Lists "/cache/apt/lists";\nDir::Cache "/cache/apt";\n' > /etc/apt/apt.conf.d/90rea-lab-cache
apt-get update

case "$1" in
firmware)
  apt-get install -y --no-install-recommends \
    cargo rustc pkg-config libfontconfig1-dev liblzma-dev libbz2-dev zlib1g-dev \
    python3-venv python3-dev build-essential ca-certificates git
  rustc --version
  CARGO_HOME=/cache/cargo cargo install binwalk --version 3.1.0 --locked --root /engines/binwalk-3.1.0
  rm -f /engines/binwalk-3.1.0/.crates.toml /engines/binwalk-3.1.0/.crates2.json
  python3 -m venv /engines/unblob-26.6.4
  /engines/unblob-26.6.4/bin/pip install "unblob==26.6.4"
  /engines/unblob-26.6.4/bin/pip freeze > /engines/unblob-26.6.4/FREEZE.txt
  /engines/binwalk-3.1.0/bin/binwalk --version > /engines/binwalk-3.1.0/BUILT
  /engines/unblob-26.6.4/bin/unblob --version > /engines/unblob-26.6.4/BUILT
  dirs="/engines/binwalk-3.1.0 /engines/unblob-26.6.4"
  ;;
python)
  apt-get install -y --no-install-recommends python3-venv python3-dev build-essential ca-certificates git
  # REA's offline ELF profile (third_party/pwntools): exactly these three versions.
  python3 -m venv /engines/pwntools-4.15.0
  /engines/pwntools-4.15.0/bin/pip install "pwntools==4.15.0" "pyelftools==0.33" "unicorn==2.1.2"
  /engines/pwntools-4.15.0/bin/pip freeze > /engines/pwntools-4.15.0/FREEZE.txt
  /engines/pwntools-4.15.0/bin/python -I -c 'import importlib.metadata as m; print({p: m.version(p) for p in ("pwntools", "pyelftools", "unicorn")})' \
    > /engines/pwntools-4.15.0/BUILT
  # pwndbg at REA's pinned commit (third_party/pwndbg), from its frozen uv.lock. A
  # separate venv: pwndbg needs unicorn>=2.1.4, the ELF profile pins 2.1.2.
  d=/engines/pwndbg-2026.09.15
  git clone --filter=blob:none https://github.com/pwndbg/pwndbg "$d/src"
  git -C "$d/src" checkout --detach 55596aa676a2756efb8d67034f31675170eabe48
  python3 -m venv /tmp/uv && /tmp/uv/bin/pip install uv && /tmp/uv/bin/uv --version
  (cd "$d/src" && UV_CACHE_DIR=/cache/uv UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT="$d/venv" \
     /tmp/uv/bin/uv sync --frozen --no-dev --python /usr/bin/python3)
  "$d/venv/bin/python" -I -c 'import importlib.metadata as m; print({p: m.version(p) for p in ("pwndbg", "pwntools", "unicorn", "capstone6pwndbg")})' \
    > "$d/BUILT"
  dirs="/engines/pwntools-4.15.0 $d"
  ;;
browser)
  # REA drives a browser through playwright-core with REA_BROWSER_EXECUTABLE. This is
  # Debian's signed chromium: apt checks every .deb against the signed index, and only
  # the packages this image lacks are fetched, then unpacked without maintainer scripts.
  debs=/cache/chromium-debs
  rm -rf "$debs" && mkdir -p "$debs/partial"
  apt-get install -y --download-only --no-install-recommends -o Dir::Cache::Archives="$debs" chromium
  ver=$(dpkg-deb -f "$debs"/chromium_*.deb Version)
  d=/engines/chromium-${ver%%-*}
  rm -rf "$d" && mkdir -p "$d/root" "$d/bin" && dirs=$d
  for f in "$debs"/*.deb; do dpkg-deb -x "$f" "$d/root"; done
  (cd "$debs" && sha256sum -- *.deb) > "$d/DEBS.sha256"
  cat > "$d/bin/chromium" <<'EOF'
#!/bin/sh
# Debian's chromium plus the libraries tm8/rea lacks, unpacked with dpkg-deb -x (DEBS.sha256).
r=$(dirname "$(dirname "$(readlink -f "$0")")")/root
l=$r/usr/lib/x86_64-linux-gnu
export LD_LIBRARY_PATH="$l:$l/nss:$l/pulseaudio:$r/usr/lib/chromium${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$r/usr/lib/chromium/chromium" "$@"
EOF
  chmod 0755 "$d/bin/chromium"
  "$d/bin/chromium" --no-sandbox --version > "$d/BUILT"
  echo "debian $ver" >> "$d/BUILT"
  ;;
ida)
  # REA's headless IDA profile (docs/ida-provider.md) needs upstream's database-supervisor
  # API, which REA pins at this commit. Its `idapro` dependency ships inside the owner's
  # IDA, so rea-sandbox setup ida adds it to this venv offline.
  apt-get install -y --no-install-recommends python3-venv ca-certificates git
  d=/engines/ida && commit=c133c3853faa111a9b00ee615c013b720d0c4acd
  rm -rf "$d/bridge" /tmp/ida-pro-mcp && mkdir -p "$d" && dirs="$d/bridge"
  git clone --filter=blob:none https://github.com/mrexodia/ida-pro-mcp /tmp/ida-pro-mcp
  git -C /tmp/ida-pro-mcp checkout --detach "$commit"
  test "$(git -C /tmp/ida-pro-mcp rev-parse HEAD)" = "$commit"
  python3 -m venv "$d/bridge"
  "$d/bridge/bin/pip" install /tmp/ida-pro-mcp
  "$d/bridge/bin/pip" freeze > "$d/bridge/FREEZE.txt"
  test -x "$d/bridge/bin/idalib-mcp"
  echo "mrexodia/ida-pro-mcp $commit" > "$d/bridge/BUILT"
  ;;
*)
  echo "build-engines.sh: unknown target $1" >&2
  exit 2
  ;;
esac
