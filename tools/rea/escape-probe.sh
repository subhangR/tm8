#!/bin/sh
# Escape probe for the RE Lab sandbox. It starts a static and an exec warm REA for a throwaway
# case through rea-sandbox, then runs checks INSIDE each container with `docker exec`:
# - no host path ($HOME, prod-data, the lab, /opt/tm8) or container-runtime socket is visible;
# - the network is loopback only: no DNS, and every outside, metadata, bridge or host address
#   is unreachable;
# - root, targets and engines are read-only, and /tmp is noexec;
# - every capability is dropped.
# It prints one line per check, stops the warm REAs and exits 1 if any check FAILs.
#
#   tools/rea/escape-probe.sh [case]     (default case: escape-probe; it is removed afterwards)
set -eu
lab=/home/tm8/rea-lab
sandbox=$lab/bin/rea-sandbox
case_name=${1:-escape-probe}
if [ -e "$lab/cases/$case_name" ]; then
  echo "escape-probe: $lab/cases/$case_name exists; name an unused case" >&2
  exit 2
fi
probe=$(mktemp)
trap 'rm -f "$probe"' EXIT
cat > "$probe" <<'PROBE'
# Runs inside a warm REA container (docker exec ... sh -s). One line per check.
r() { printf '%-6s %-34s %s\n' "$1" "$2" "$3"; }
r INFO identity "$(id) host=$(hostname) kernel=$(uname -r)"
r INFO gvisor "$(dmesg 2>/dev/null | head -1)"
for p in /home/tm8 /home/tm8/prod-data /home/tm8/rea-lab /opt/tm8 /root/.ssh /var/run/docker.sock /run/docker.sock /run/containerd /proc/1/root/home/tm8; do
  if [ -e "$p" ]; then r FAIL "absent:$p" "EXISTS"; else r PASS "absent:$p" "not present"; fi
done
r INFO mounts "$(awk '{print $2":"$4}' /proc/self/mounts | grep -E '^/(case|engines|tmp|exec|home|etc/machine-id)' | sed 's/,.*//' | tr '\n' ' ')"
socks=$(find / -xdev -type s 2>/dev/null | grep -v '^/proc' | tr '\n' ' ')
if [ -z "$socks" ]; then r PASS sockets "none on the root fs"; else r FAIL sockets "$socks"; fi
r INFO netdev "$(awk 'NR>2{sub(":","",$1); print $1}' /proc/net/dev | tr '\n' ' ')"
if getent hosts github.com >/dev/null 2>&1; then r FAIL dns:github.com "resolved"; else r PASS dns:github.com "does not resolve"; fi
for hp in 1.1.1.1:443 140.82.112.3:443 169.254.169.254:80 172.17.0.1:22 150.241.246.170:443 100.112.76.32:22 127.0.0.1:17777; do
  res=$(node -e '
    const [h,p]=process.argv[1].split(":"); const s=require("net").connect({host:h,port:+p,timeout:4000});
    s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});
    s.on("timeout",()=>{console.log("TIMEOUT");process.exit(0)});
    s.on("error",e=>{console.log(e.code);process.exit(0)});' "$hp" 2>&1)
  case $res in CONNECTED) r FAIL "tcp:$hp" "$res" ;; *) r PASS "tcp:$hp" "$res" ;; esac
done
for p in /usr/probe /case/targets/probe /engines/probe /etc/probe; do
  if ( : > "$p" ) 2>/dev/null; then r FAIL "readonly:$p" "WRITABLE"; rm -f "$p"; else r PASS "readonly:$p" "write refused"; fi
done
if ( : > /case/out/.probe ) 2>/dev/null; then r PASS writable:/case/out "ok"; rm -f /case/out/.probe; else r FAIL writable:/case/out "refused"; fi
cp /bin/true /tmp/.probe-true 2>/dev/null
if /tmp/.probe-true 2>/dev/null; then r FAIL noexec:/tmp "EXECUTED"; else r PASS noexec:/tmp "exec refused"; fi
rm -f /tmp/.probe-true
if [ -d /exec ]; then cp /bin/true /exec/.probe-true && if /exec/.probe-true; then r INFO exec:/exec "executable (exec profile)"; fi; rm -f /exec/.probe-true; else r INFO exec:/exec "absent"; fi
r INFO caps "$(grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs)' /proc/self/status | tr -s '\t ' ' ' | tr '\n' ' ')"
r INFO processes "$(ps -e --no-headers | wc -l) visible: $(ps -e -o comm= | sort -u | tr '\n' ' ')"
r INFO env-names "$(env | cut -d= -f1 | grep -iE 'token|secret|key|pass|tm8|aws|gh_' | tr '\n' ' ')"
r INFO engines "$(ls /engines | tr '\n' ' ')"
PROBE
"$sandbox" --case "$case_name" tools open_binary >/dev/null
"$sandbox" --case "$case_name" --profile exec tools open_binary >/dev/null
failed=0
for id in $(docker ps -q --filter "label=tm8.rea.case=$case_name"); do
  echo "== $(docker inspect -f '{{index .Config.Labels "tm8.rea.profile"}}: runtime={{.HostConfig.Runtime}} network={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' "$id")"
  out=$(docker exec -i "$id" sh -s < "$probe")
  echo "$out"
  if echo "$out" | grep -q '^FAIL'; then failed=1; fi
done
"$sandbox" --case "$case_name" stop >/dev/null
"$sandbox" --case "$case_name" --profile exec stop >/dev/null
# A warm REA stops a moment after it is asked to; remove the case only once both have gone.
for _ in $(seq 30); do
  [ -z "$(docker ps -q --filter "label=tm8.rea.case=$case_name")" ] && break
  sleep 1
done
rm -rf "${lab:?}/cases/$case_name"
[ "$failed" = 0 ] && echo "escape-probe: every check passed" || echo "escape-probe: a check FAILED" >&2
exit "$failed"
