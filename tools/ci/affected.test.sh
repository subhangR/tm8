#!/usr/bin/env bash
# Table test for tools/ci/affected.sh. Needs bash, jq and git; no network, no install.
#   bash tools/ci/affected.test.sh
# AFFECTED=<path> runs the table against another copy of the script (mutation proofs).
#
# Fixtures are hermetic: the graph is a copy of this repo's root and workspace package.json
# files in a temp dir, and the git rows run in a throwaway repo built from that copy.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
AFFECTED="${AFFECTED:-$HERE/affected.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ALL_MODULES='["typecheck","server","cli","execution","ui","small","migrations","mcp","prompt","pty-protocol"]'
KEYS=(all modules typecheck server cli execution ui small migrations mcp prompt pty-protocol reason)
PASS=0 FAIL=0

# ---- fixtures ---------------------------------------------------------------------------
FIX="$TMP/fix"
make_fixture() { # <dir>: the repo's package.json graph, nothing else
  local dst=$1 f
  mkdir -p "$dst"
  cp "$REPO/package.json" "$dst/package.json"
  for f in "$REPO"/packages/*/package.json "$REPO"/apps/*/package.json "$REPO"/tools/*/package.json; do
    [[ -f $f ]] || continue
    mkdir -p "$dst/$(dirname "${f#"$REPO"/}")"
    cp "$f" "$dst/${f#"$REPO"/}"
  done
}
make_fixture "$FIX"

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git_repo() { # <dir>: a repo whose first commit is the fixture graph plus server/src/x.ts
  local dir=$1
  make_fixture "$dir"
  mkdir -p "$dir/packages/server/src"
  printf 'export const x = 1;\n' >"$dir/packages/server/src/x.ts"
  git -C "$dir" init -q -b main
  git -C "$dir" add -A
  git -C "$dir" commit -q -m base
}

# ---- assertions -------------------------------------------------------------------------
OUT=""
check_shape() { # every key exactly once, nothing else; all=true => every flag true
  local k n
  for k in "${KEYS[@]}"; do
    n=$(grep -c "^$k=" <<<"$OUT")
    [[ $n == 1 ]] || { echo "key $k appears $n times"; return 1; }
  done
  n=$(grep -c '' <<<"$OUT")
  [[ $n == "${#KEYS[@]}" ]] || { echo "expected ${#KEYS[@]} lines, got $n"; return 1; }
  if grep -qx 'all=true' <<<"$OUT"; then
    grep -Fqx "modules=$ALL_MODULES" <<<"$OUT" || { echo "all=true but modules is not every module"; return 1; }
    if grep -E '^[a-z-]+=false$' <<<"$OUT"; then echo "all=true but a flag is false"; return 1; fi
  fi
  local m mods
  mods=$(sed -n 's/^modules=//p' <<<"$OUT")
  for m in typecheck server cli execution ui small migrations mcp prompt pty-protocol; do
    if jq -e --arg m "$m" 'index($m) != null' <<<"$mods" >/dev/null; then
      grep -qx "$m=true" <<<"$OUT" || { echo "$m listed but flag not true"; return 1; }
    else
      grep -qx "$m=false" <<<"$OUT" || { echo "$m not listed but flag not false"; return 1; }
    fi
  done
}
report() { # <name> <ok:0|1> <detail>
  if [[ $2 == 0 ]]; then PASS=$((PASS + 1)); echo "ok   $1"
  else FAIL=$((FAIL + 1)); echo "FAIL $1"; echo "     $3"; sed 's/^/     | /' <<<"$OUT"; fi
}
expect() { # <name> ALL | <exact modules JSON> | contains:<m>,<m>
  local name=$1 want=$2 err mods m
  if ! err=$(check_shape); then report "$name" 1 "shape: $err"; return; fi
  mods=$(sed -n 's/^modules=//p' <<<"$OUT")
  case $want in
    ALL)
      grep -qx 'all=true' <<<"$OUT" && [[ $mods == "$ALL_MODULES" ]]
      report "$name" $? "want ALL" ;;
    contains:*)
      local ok=0
      grep -qx 'all=false' <<<"$OUT" || ok=1
      for m in ${want#contains:}; do
        jq -e --arg m "$m" 'index($m) != null' <<<"$mods" >/dev/null || ok=1
      done
      report "$name" $ok "want all=false and a set containing ${want#contains:}" ;;
    *)
      grep -qx 'all=false' <<<"$OUT" && [[ $mods == "$want" ]]
      report "$name" $? "want all=false modules=$want" ;;
  esac
}

paths() { # <root> <path>...: run in path mode
  local root=$1; shift
  OUT=$(printf '%s\n' "$@" | bash "$AFFECTED" --paths-from - --root "$root" 2>/dev/null)
}
gitrun() { # <repo> <base> <head> [PATH prefix]
  OUT=$(cd "$1" && PATH="${4:+$4:}$PATH" bash "$AFFECTED" --base "$2" --head "$3" 2>/dev/null)
}

# ---- controls (design §3; each must fire) -----------------------------------------------
paths "$FIX" packages/contract/src/x.ts
expect "CONTROL contract -> ALL" ALL
# with a narrow companion, so the row cannot pass through the "nothing classified" fallback
paths "$FIX" packages/tm8-ui/src/x.tsx some/unknown/path.ts
expect "CONTROL unknown path (beside a ui path) -> ALL" ALL
paths "$FIX" some/unknown/path.ts
expect "      unknown path alone -> ALL" ALL
paths "$FIX" tools/conformance/generated/w1-conformance-manifest.json
expect "CONTROL conformance manifest -> includes server and cli" "contains:server cli"
expect "      conformance manifest exact set" '["typecheck","server","cli","small"]'

G="$TMP/gmv"; git_repo "$G"
git -C "$G" mv packages/server/src/x.ts docs/x.md 2>/dev/null || { mkdir -p "$G/docs"; git -C "$G" mv packages/server/src/x.ts docs/x.md; }
git -C "$G" commit -q -m mv
gitrun "$G" HEAD~1 HEAD
expect "CONTROL git mv packages/server/src/x.ts docs/x.md -> server closure" '["typecheck","server","cli","small"]'

# git diff fails after writing part of its output: the realistic shape of a broken diff,
# and the one that narrows wrongly if a failed diff is ever treated as a short list.
STUB="$TMP/stub-diff"; mkdir -p "$STUB"; REAL_GIT=$(command -v git)
cat >"$STUB/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [[ \$a == diff ]]; then echo packages/tm8-ui/src/a.tsx; exit 128; fi
done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$STUB/git"
G2="$TMP/g2"; git_repo "$G2"
echo 'export const y = 2;' >>"$G2/packages/server/src/x.ts"; git -C "$G2" commit -qam change
gitrun "$G2" HEAD~1 HEAD "$STUB"
expect "CONTROL git diff fails mid-output -> ALL" ALL
STUB1="$TMP/stub-fail"; mkdir -p "$STUB1"
printf '#!/usr/bin/env bash\nexit 1\n' >"$STUB1/git"; chmod +x "$STUB1/git"
gitrun "$G2" HEAD~1 HEAD "$STUB1"
expect "      every git call fails -> ALL" ALL
gitrun "$G2" 0123456789abcdef0123456789abcdef01234567 HEAD
expect "      base sha not in repo (shallow miss) -> ALL" ALL
gitrun "$G2" HEAD HEAD
expect "      empty diff -> ALL" ALL
gitrun "$G2" HEAD~1 HEAD
expect "      same repo, working git -> server closure (the stubs are what fail)" '["typecheck","server","cli","small"]'

# ---- §3 table ---------------------------------------------------------------------------
paths "$FIX" packages/server/src/x.ts;       expect "server -> cli, conformance" '["typecheck","server","cli","small"]'
paths "$FIX" packages/jev/src/x.ts;          expect "jev -> server, cli, conformance" '["typecheck","server","cli","small"]'
paths "$FIX" packages/mcp/src/x.ts;          expect "mcp -> server, cli, conformance" '["typecheck","server","cli","small","mcp"]'
paths "$FIX" packages/cli/src/x.ts;          expect "cli -> execution, ui" '["typecheck","cli","execution","ui"]'
paths "$FIX" packages/execution/src/x.ts;    expect "execution -> server, cli, ui (+conformance via server)" '["typecheck","server","cli","execution","ui","small"]'
paths "$FIX" packages/prompt/src/x.ts;       expect "prompt -> execution, cli, server, ui (+conformance via server)" '["typecheck","server","cli","execution","ui","small","prompt"]'
paths "$FIX" packages/pty-protocol/src/x.ts; expect "pty-protocol -> ui (workspace: edge, not @tm8/)" '["typecheck","ui","pty-protocol"]'
paths "$FIX" packages/tm8-ui/src/x.tsx;      expect "tm8-ui -> ui only" '["typecheck","ui"]'
paths "$FIX" tools/conformance/src/x.ts;     expect "conformance -> server, cli" '["typecheck","server","cli","small"]'
paths "$FIX" deploy/nginx/site.conf;         expect "deploy -> server" '["typecheck","server"]'
paths "$FIX" db/migrate.mjs;                 expect "db -> server, cli" '["typecheck","server","cli"]'
paths "$FIX" db/migrations/300_x.sql;        expect "db/migrations -> migrations, server, cli" '["typecheck","server","cli","migrations"]'
paths "$FIX" packages/server/package.json;   expect "a package's own package.json -> that package" '["typecheck","server","cli","small"]'
paths "$FIX" packages/tm8-ui/src/x.tsx packages/cli/src/x.ts
expect "two paths -> union" '["typecheck","cli","execution","ui"]'

# closure without the contract override: the edge reader must still produce contract's
# reverse closure, so the ALL override cannot hide a broken graph.
sed '/^    packages\/contract\/\*) emit_all/d' "$AFFECTED" >"$TMP/no-override.sh"
if cmp -s "$AFFECTED" "$TMP/no-override.sh"; then
  OUT=""; report "contract closure without the override" 1 "override line not found in $AFFECTED"
else
  OUT=$(printf 'packages/contract/src/x.ts\n' | bash "$TMP/no-override.sh" --paths-from - --root "$FIX" 2>/dev/null)
  expect "contract closure without the override" '["typecheck","server","cli","execution","ui","small","mcp"]'
fi

# ---- rule 1: global paths ---------------------------------------------------------------
for p in bun.lock package.json tsconfig.base.json tsconfig.json .github/workflows/ci.yml .github/actions/x/action.yml tools/ci/check.sh tools/ci/affected.sh; do
  paths "$FIX" "$p"; expect "global $p -> ALL" ALL
done
paths "$FIX" packages/tm8-ui/src/x.tsx .github/workflows/ci.yml
expect "global among narrow paths -> ALL" ALL

# ---- rule 2: unknown --------------------------------------------------------------------
for p in scripts/repair-node-pty.sh tools/codebrain/conductor.py tools/rigs/perf/x.ts utho/x install.sh .gitignore .env.example 940f9eb1d5d8e259 packages/newpkg/src/x.ts; do
  paths "$FIX" "$p"; expect "unknown $p -> ALL" ALL
done
paths "$FIX" docs/a.md weird/x
expect "unknown among docs -> ALL" ALL

# ---- rule 3: errors ---------------------------------------------------------------------
paths "$FIX"
expect "empty path list -> ALL" ALL
OUT=$(bash "$AFFECTED" 2>/dev/null);                 expect "no arguments -> ALL" ALL
OUT=$(bash "$AFFECTED" --bogus 2>/dev/null);         expect "bad argument -> ALL" ALL
OUT=$(bash "$AFFECTED" --all 2>/dev/null);           expect "--all -> ALL" ALL
OUT=$(bash "$AFFECTED" --paths-from "$TMP/nope" --root "$FIX" 2>/dev/null); expect "missing path file -> ALL" ALL
B="$TMP/badjson"; make_fixture "$B"; echo '{ nope' >"$B/packages/jev/package.json"
paths "$B" packages/tm8-ui/src/x.tsx;        expect "unparseable package.json -> ALL" ALL
B="$TMP/nojq"; mkdir -p "$B"; for t in bash cat dirname env; do ln -s "$(command -v $t)" "$B/$t"; done
OUT=$(printf 'packages/tm8-ui/src/x.tsx\n' | PATH="$B" bash "$AFFECTED" --paths-from - --root "$FIX" 2>/dev/null)
expect "jq missing -> ALL" ALL

# ---- rule 4: docs -----------------------------------------------------------------------
paths "$FIX" docs/a.md;                           expect "docs/** -> typecheck only" '["typecheck"]'
paths "$FIX" docs/deep/x.png;                     expect "docs/** non-md -> typecheck only" '["typecheck"]'
paths "$FIX" README.md;                           expect "root *.md -> typecheck only" '["typecheck"]'
paths "$FIX" packages/tm8-ui/src/auth/HANDOVER-Auth.md; expect "packages/*/**/*.md -> typecheck only" '["typecheck"]'
paths "$FIX" packages/contract/README.md;         expect "contract *.md -> typecheck only (docs rule first)" '["typecheck"]'
paths "$FIX" docs/a.md packages/server/src/x.ts;  expect "docs + server -> server closure" '["typecheck","server","cli","small"]'
paths "$FIX" db/README.md;                        expect "db/README.md is db, not docs" '["typecheck","server","cli"]'
paths "$FIX" tools/conformance/README.md;         expect "tools/*/*.md is not a docs path" '["typecheck","server","cli","small"]'

# ---- rule 5: workspace == graph == map --------------------------------------------------
B="$TMP/newpkg"; make_fixture "$B"; mkdir -p "$B/tools/newpkg"; echo '{"name":"@tm8/newpkg"}' >"$B/tools/newpkg/package.json"
paths "$B" packages/tm8-ui/src/x.tsx;        expect "workspace package missing from MODULE_OF -> ALL" ALL
B="$TMP/noname"; make_fixture "$B"; jq 'del(.name)' "$B/packages/mcp/package.json" >"$B/x" && mv "$B/x" "$B/packages/mcp/package.json"
paths "$B" packages/tm8-ui/src/x.tsx;        expect "package left out of the graph (no name) -> ALL" ALL
B="$TMP/gone"; make_fixture "$B"; rm -r "$B/packages/prompt"
paths "$B" packages/tm8-ui/src/x.tsx;        expect "MODULE_OF names a package the workspace lacks -> ALL" ALL
B="$TMP/dangling"; make_fixture "$B"; jq '.devDependencies["@x/ghost"] = "workspace:^"' "$B/packages/tm8-ui/package.json" >"$B/x" && mv "$B/x" "$B/packages/tm8-ui/package.json"
paths "$B" packages/tm8-ui/src/x.tsx;        expect "workspace: dep naming no package -> ALL" ALL
B="$TMP/glob"; make_fixture "$B"; jq '.workspaces += ["packages/**"]' "$B/package.json" >"$B/x" && mv "$B/x" "$B/package.json"
paths "$B" packages/tm8-ui/src/x.tsx;        expect "unsupported workspaces glob -> ALL" ALL
B="$TMP/peer"; make_fixture "$B"
jq '.dependencies |= del(.["@maestro/pty-protocol"]) | .peerDependencies["@maestro/pty-protocol"] = "workspace:~"' "$B/packages/tm8-ui/package.json" >"$B/x" && mv "$B/x" "$B/packages/tm8-ui/package.json"
paths "$B" packages/pty-protocol/src/x.ts;   expect "peerDependencies workspace:~ is an edge" '["typecheck","ui","pty-protocol"]'

# ---- base ∪ head graph (git) ------------------------------------------------------------
G="$TMP/union"; git_repo "$G"
mkdir -p "$G/packages/pty-protocol/src"; echo 'x' >"$G/packages/pty-protocol/src/x.ts"
jq 'del(.dependencies["@maestro/pty-protocol"], .devDependencies["@maestro/pty-protocol"])' "$G/packages/tm8-ui/package.json" >"$G/x" && mv "$G/x" "$G/packages/tm8-ui/package.json"
git -C "$G" add -A; git -C "$G" commit -q -m "drop the ui edge and change pty-protocol"
gitrun "$G" HEAD~1 HEAD
expect "head deletes tm8-ui -> pty-protocol edge: base edge still counts" '["typecheck","ui","pty-protocol"]'

G="$TMP/newhead"; git_repo "$G"
git -C "$G" rm -rq packages/pty-protocol
jq 'del(.dependencies["@maestro/pty-protocol"], .devDependencies["@maestro/pty-protocol"])' "$G/packages/tm8-ui/package.json" >"$G/x" && mv "$G/x" "$G/packages/tm8-ui/package.json"
git -C "$G" add -A; git -C "$G" commit -q -m "base without pty-protocol"
git -C "$G" checkout -q HEAD~1 -- packages/pty-protocol packages/tm8-ui/package.json
git -C "$G" commit -q -m "head adds pty-protocol back"
gitrun "$G" HEAD~1 HEAD
expect "package new in head (absent at base) -> its closure, not ALL" '["typecheck","ui","pty-protocol"]'

# ---- output ------------------------------------------------------------------------------
paths "$FIX" packages/tm8-ui/src/x.tsx
[[ $(grep -c '^all=' <<<"$OUT") == 1 && $(grep -c '^modules=' <<<"$OUT") == 1 ]]
report "narrow success path prints the block once" $? "duplicate keys"
OUT=$(printf 'packages/tm8-ui/src/x.tsx\n' | bash "$AFFECTED" --paths-from - --root "$FIX" 2>&1 >/dev/null)
[[ -z $(grep -E '^(all|modules)=' <<<"$OUT") ]]
report "stderr carries no output keys" $? "keys leaked to stderr"
OUT=$(printf 'packages/tm8-ui/src/x.tsx\n' | bash "$AFFECTED" --paths-from - --root "$FIX" 2>/dev/null); rc=$?
[[ $rc == 0 ]]; report "exit 0 on a narrow result" $? "rc=$rc"
OUT=$(printf 'nope/x\n' | bash "$AFFECTED" --paths-from - --root "$FIX" 2>/dev/null); rc=$?
[[ $rc == 0 ]]; report "exit 0 on ALL" $? "rc=$rc"

echo
echo "affected.test.sh: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
