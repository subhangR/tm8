#!/usr/bin/env bash
# tools/ci/affected.sh — which CI modules a change affects (design §3 of the CI split).
#
# USAGE
#   affected.sh --base <ref> --head <ref>     diff two commits (CI: --base HEAD^1 --head HEAD)
#   affected.sh --paths-from <file|->         a newline-separated path list; no git at all.
#                                             The package graph is read from --root (default:
#                                             the repo this script lives in).
#   affected.sh --all                         emit ALL (push to main, schedule, dispatch)
#
# OUTPUT (stdout, and nothing else ever goes to stdout: append it to $GITHUB_OUTPUT as is)
#   all=true|false
#   modules=["typecheck","server",...]        compact JSON array, canonical order
#   typecheck=true|false                      one line per module, in this order:
#   server= cli= execution= ui= small= migrations= mcp= prompt= pty-protocol=
#   reason=<one line>                         why the set is what it is
# The block is printed exactly once, at the end. Diagnostics go to stderr.
# Modules: small = contract + jev + conformance. typecheck is in every set.
# The exit status is 0 whenever the block was printed, including ALL-on-error: rule 3
# means an error widens the set, it does not fail the `changes` job.
#
# COMPOSITION (§3): map each changed path to its node (a workspace package dir, or one of
# the pseudo nodes deploy, db, db/migrations); take the reverse transitive closure over
# workspace dependency edges; then add exactly ONE hop of EXTRA_EDGES from every node in
# that closure (no re-closure); then map nodes to modules.
# The dependency graph is the UNION of the base and head package.json files, so a PR cannot
# delete the edge that would have tested it. Edges, from all four dependency fields:
#   - a dep whose version starts with `workspace:` or whose name starts with `@tm8/` MUST
#     resolve to a workspace package, or -> ALL (tm8-ui -> @maestro/pty-protocol is
#     workspace:-only, so never filter on the prefix alone);
#   - any other dep whose name is a workspace package's name is an edge too, whatever its
#     spec (link:, file:, semver); names that match nothing (react, ...) are external.
#
# FAIL-SAFE RULES
#   1. global paths -> ALL: bun.lock, root package.json, root tsconfig*.json, .github/**,
#      tools/ci/**
#   2. a path no rule recognises -> ALL; so does one with a `.` or `..` segment
#   3. any error -> ALL (git failure, empty diff, bad package.json, missing jq, ...)
#   4. docs/**, root *.md -> typecheck only, per §3 (amended, doc v6): packages/*/**/*.md is NOT docs,
#      it seeds its owning package like any other file there, because tests read package
#      .md files (tm8-ui: src/data/real/liveness.test.ts reads src/data/LLD.md,
#      src/mobile/shell-contract.test.ts reads CONTRACT.md).
#   (and packages/contract/** -> ALL: §3 says "contract → everything", which is wider
#   than contract's closure)
#   5. the workspace packages (root `workspaces` globs expanded over the tree) must equal
#      the parsed graph and the static MODULE_OF map, both ways, or -> ALL
#
# The result starts as ALL and is narrowed only after every step has succeeded.
# Deliberately NOT check.sh's style: set -e, an ERR trap that reaches functions and
# command substitutions (-E, inherit_errexit), and an EXIT trap for the aborts that do not
# fire ERR (an unset variable under -u). Never feed a failing command through `< <(...)`
# or `local x=$(...)`: both hide its status.

set -Eeuo pipefail
shopt -s inherit_errexit

MODULES=(typecheck server cli execution ui small migrations mcp prompt pty-protocol)

# Workspace package dir -> module. Every workspace package must appear here (rule 5).
declare -A MODULE_OF=(
  [packages/server]=server
  [packages/cli]=cli
  [packages/execution]=execution
  [packages/tm8-ui]=ui
  [packages/contract]=small
  [packages/jev]=small
  [tools/conformance]=small
  [packages/mcp]=mcp
  [packages/prompt]=prompt
  [packages/pty-protocol]=pty-protocol
  [deploy]=
  [db]=
  [db/migrations]=migrations
)
PSEUDO_NODES=(db/migrations db deploy)   # longest prefix first

# One hop, applied after the closure. Evidence is the §3 table.
declare -A EXTRA_EDGES=(
  [packages/server]="packages/cli tools/conformance"  # harness.ts spawns server dist; check:generated parses server
  [packages/jev]="packages/cli"
  [packages/mcp]="packages/cli"
  [packages/cli]="packages/execution"                 # codex-loopback runs cli dist
  [tools/conformance]="packages/server packages/cli"  # w1-conformance-manifest.json is read by both
  [deploy]="packages/server"                          # security-gates.test.ts reads nginx config
  [db]="packages/server packages/cli"                 # scratch databases apply the migration chain
  [db/migrations]="packages/server packages/cli tools/conformance"  # db/** applies here too;
                                                    # conformance migration-inventory.ts hashes 015_w1_foundations.sql
)

exec 3>&1 1>&2   # fd 3 is the only path to stdout
MAIN_PID=$BASHPID
EMITTED=0

emit() { # <all:true|false> <reason> <module>...
  local all=$1 reason=$2 m json="" sep=""
  shift 2
  local -A on=()
  for m in "$@"; do on[$m]=1; done
  for m in "${MODULES[@]}"; do
    if [[ $all == true || -n ${on[$m]:-} ]]; then json+="$sep\"$m\""; sep=,; fi
  done
  {
    printf 'all=%s\n' "$all"
    printf 'modules=[%s]\n' "$json"
    for m in "${MODULES[@]}"; do
      if [[ $all == true || -n ${on[$m]:-} ]]; then printf '%s=true\n' "$m"; else printf '%s=false\n' "$m"; fi
    done
    printf 'reason=%s\n' "${reason//$'\n'/ }"
  } >&3
  EMITTED=1
}

emit_all() { # <reason>
  if [[ $BASHPID != "$MAIN_PID" ]]; then exit 1; fi   # in a subshell: fail it, let the parent decide
  if [[ $EMITTED != 1 ]]; then
    echo "affected.sh: ALL — $1" >&2
    emit true "$1"
  fi
  exit 0
}

trap 'emit_all "error at line $LINENO: $BASH_COMMAND"' ERR
trap 'rc=$?; if [[ $BASHPID == "$MAIN_PID" && $EMITTED != 1 ]]; then emit_all "aborted (status $rc)"; fi' EXIT

usage() { echo "usage: affected.sh --base <ref> --head <ref> | --paths-from <file|-> [--root <dir>] | --all" >&2; }

MODE="" BASE="" HEAD="" PATHS_FROM="" ROOT=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
while [[ $# -gt 0 ]]; do
  case $1 in
    --base) BASE=$2; MODE=git; shift 2 ;;
    --head) HEAD=$2; MODE=git; shift 2 ;;
    --paths-from) PATHS_FROM=$2; MODE=paths; shift 2 ;;
    --root) ROOT=$2; shift 2 ;;
    --all) MODE=all; shift ;;
    *) usage; emit_all "bad argument: $1" ;;
  esac
done
[[ -n $MODE ]] || { usage; emit_all "no mode given"; }
[[ $MODE == all ]] && emit_all "forced (--all)"
if [[ $MODE == git ]]; then
  [[ -n $BASE && -n $HEAD ]] || emit_all "--base and --head are both required"
fi

command -v jq >/dev/null || emit_all "jq not found"

# ---- sources: "git:<ref>" or "fs:<dir>" -------------------------------------------------
src_show() { # <src> <path>: print a file's contents
  case $1 in
    git:*) git show "${1#git:}:$2" ;;
    fs:*) cat "${1#fs:}/$2" ;;
  esac
}
src_package_dirs() { # <src> <prefix>: dirs <prefix>/<x> that hold a package.json
  local src=$1 prefix=$2 listing d pj
  case $src in
    git:*)
      listing=$(git ls-tree --name-only "${src#git:}" -- "$prefix/")
      while IFS= read -r d; do
        [[ -n $d ]] || continue
        # ls-tree, not `cat-file -e` in an if: a git error must reach ERR, not read as "absent"
        pj=$(git ls-tree --name-only "${src#git:}" -- "$d/package.json")
        if [[ -n $pj ]]; then echo "$d"; fi
      done <<<"$listing"
      ;;
    fs:*)
      for d in "${src#fs:}/$prefix"/*/; do
        if [[ -f $d/package.json ]]; then d=${d%/}; echo "${d#"${src#fs:}"/}"; fi
      done
      ;;
  esac
}

declare -A WS=()          # workspace package dirs, from glob expansion
declare -A GRAPH=()       # dirs whose package.json parsed
declare -A DIRS_OF=()     # package name -> " dir dir"
declare -A DEP_NAMES=()   # dir -> " depname ..."  internal-looking: must resolve
declare -A DEP_SOFT=()    # dir -> " depname ..."  any other dep: an edge if it resolves

read_source() { # <src>
  local src=$1 root_json globs glob prefix dirs d pj name deps soft
  root_json=$(src_show "$src" package.json)
  globs=$(jq -r '.workspaces | if type == "array" then .[] elif type == "object" then .packages[] else error("no workspaces") end' <<<"$root_json")
  while IFS= read -r glob; do
    [[ -n $glob ]] || continue
    [[ $glob =~ ^[A-Za-z0-9._-]+/\*$ ]] || emit_all "unsupported workspaces glob: $glob"
    prefix=${glob%/\*}
    dirs=$(src_package_dirs "$src" "$prefix")
    while IFS= read -r d; do
      [[ -n $d ]] || continue
      WS[$d]=1
      pj=$(src_show "$src" "$d/package.json")
      name=$(jq -er '.name | select(type == "string" and length > 0)' <<<"$pj")
      deps=$(jq -r '[.dependencies, .devDependencies, .peerDependencies, .optionalDependencies]
                    | map(. // {}) | add | to_entries[]
                    | select((.value | tostring | startswith("workspace:")) or (.key | startswith("@tm8/")))
                    | .key' <<<"$pj")
      soft=$(jq -r '[.dependencies, .devDependencies, .peerDependencies, .optionalDependencies]
                    | map(. // {}) | add | keys[]' <<<"$pj")
      GRAPH[$d]=1
      DIRS_OF[$name]="${DIRS_OF[$name]:-} $d"
      DEP_NAMES[$d]="${DEP_NAMES[$d]:-} $deps"
      DEP_SOFT[$d]="${DEP_SOFT[$d]:-} $soft"
    done <<<"$dirs"
  done <<<"$globs"
}

# ---- changed paths ----------------------------------------------------------------------
if [[ $MODE == git ]]; then
  git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || emit_all "base ref does not resolve: $BASE"
  git rev-parse --verify --quiet "$HEAD^{commit}" >/dev/null || emit_all "head ref does not resolve: $HEAD"
  CHANGED=$(git -c core.quotePath=false diff --no-renames --name-only "$BASE" "$HEAD")
  read_source "git:$BASE"
  read_source "git:$HEAD"
else
  if [[ $PATHS_FROM == - ]]; then CHANGED=$(cat); else CHANGED=$(cat "$PATHS_FROM"); fi
  read_source "fs:$ROOT"
fi

# ---- rule 5: the workspace, the graph and the map must agree ----------------------------
[[ ${#WS[@]} -gt 0 ]] || emit_all "no workspace packages found"
for d in "${!WS[@]}"; do
  [[ -n ${GRAPH[$d]:-} ]] || emit_all "workspace package $d missing from the graph"
  [[ -v MODULE_OF[$d] ]] || emit_all "workspace package $d has no module in MODULE_OF"
done
for d in "${!GRAPH[@]}"; do [[ -n ${WS[$d]:-} ]] || emit_all "graph node $d is not a workspace package"; done
for d in "${!MODULE_OF[@]}"; do
  case " ${PSEUDO_NODES[*]} " in *" $d "*) continue ;; esac
  [[ -n ${WS[$d]:-} ]] || emit_all "MODULE_OF names $d, which is not a workspace package"
done

# reverse edges: dep dir -> dependents
declare -A DEPENDENTS=()
for d in "${!DEP_NAMES[@]}"; do
  for n in ${DEP_NAMES[$d]}; do
    [[ -n ${DIRS_OF[$n]:-} ]] || emit_all "$d depends on $n, which is not a workspace package"
    for t in ${DIRS_OF[$n]}; do DEPENDENTS[$t]="${DEPENDENTS[$t]:-} $d"; done
  done
done
for d in "${!DEP_SOFT[@]}"; do
  for n in ${DEP_SOFT[$d]}; do
    for t in ${DIRS_OF[$n]:-}; do DEPENDENTS[$t]="${DEPENDENTS[$t]:-} $d"; done
  done
done

# ---- classify ---------------------------------------------------------------------------
[[ -n ${CHANGED//[[:space:]]/} ]] || emit_all "empty change set"

declare -A SEEDS=()
DOCS_ONLY=0
while IFS= read -r p; do
  [[ -n $p ]] || continue
  case /$p/ in
    */./* | */../*) emit_all "path is not normalised: $p" ;;
  esac
  case $p in
    bun.lock | package.json | tsconfig*.json | .github/* | tools/ci/*)
      emit_all "global path: $p" ;;
    docs/*) DOCS_ONLY=1; continue ;;
    # §3 states "contract → everything". Its closure misses prompt, pty-protocol and
    # migrations; where the rule and the stated result differ, the wider one wins.
    packages/contract/*) emit_all "contract path: $p" ;;
    */*) ;;
    *.md) DOCS_ONLY=1; continue ;;
  esac
  node=""
  for n in "${PSEUDO_NODES[@]}"; do
    if [[ $p == "$n"/* ]]; then node=$n; break; fi
  done
  if [[ -z $node ]]; then
    for d in "${!WS[@]}"; do
      if [[ $p == "$d"/* && ${#d} -gt ${#node} ]]; then node=$d; fi
    done
  fi
  [[ -n $node ]] || emit_all "unknown path: $p"
  SEEDS[$node]=1
done <<<"$CHANGED"

# ---- closure, then one hop --------------------------------------------------------------
declare -A CLOSED=()
queue=("${!SEEDS[@]}")
while [[ ${#queue[@]} -gt 0 ]]; do
  n=${queue[0]}; queue=("${queue[@]:1}")
  [[ -z ${CLOSED[$n]:-} ]] || continue
  CLOSED[$n]=1
  for t in ${DEPENDENTS[$n]:-}; do queue+=("$t"); done
done
declare -A FINAL=()
for n in "${!CLOSED[@]}"; do
  FINAL[$n]=1
  for t in ${EXTRA_EDGES[$n]:-}; do FINAL[$t]=1; done
done

selected=(typecheck)
for n in "${!FINAL[@]}"; do
  [[ -v MODULE_OF[$n] ]] || emit_all "node $n has no module"
  [[ -z ${MODULE_OF[$n]} ]] || selected+=("${MODULE_OF[$n]}")
done

nodes=$(printf '%s\n' "${!SEEDS[@]}" | sort | tr '\n' ' ')
if [[ ${#SEEDS[@]} -eq 0 ]]; then
  [[ $DOCS_ONLY == 1 ]] || emit_all "no path classified"
  emit false "docs only" typecheck
else
  emit false "changed nodes: ${nodes% }" "${selected[@]}"
fi
exit 0
