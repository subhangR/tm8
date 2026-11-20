# Isolated vault fill worker

Open this runbook when installing, verifying or rolling back the isolated browser
worker. It contains the service boundary, protocol, test commands and limitations.
Nothing in this directory installs or enables itself. Provisioning waits for the
owner's decision (`01a1faa6-fafc`); keep the vault flag off / test material only
until the separate security review and penetration test pass.

## Installation (operator only, after the decision)

1. Create a dedicated non-login `tm8-vault-fill` account and the `tm8-vault` group.
   Only the broker and fill accounts may belong to that group. Agents and the
   ordinary tm8 server uid must not. Install `tmpfiles.conf` as
   `/etc/tmpfiles.d/tm8-vault-fill.conf` and run `systemd-tmpfiles --create` for it.
2. Build the release with `bun install`, then `cd packages/vault && npx tsc -b`.
   Install it read-only under `/opt/tm8/current`. Use the Chromium revision paired
   with exactly `playwright-core@1.58.2`, installed read-only under `/opt/tm8`.
   Adjust the two browser paths and node path in the unit to that release.
   Never use a browser or binary in an agent-writable directory.
3. Verify unprivileged Chromium sandbox/user namespaces work for the dedicated
   account under `NoNewPrivileges`. Production always enables the sandbox; the
   in-process test option to disable it is unavailable through the socket/CLI or
   environment. Known test switches at the production entry are refused with a
   nonzero exit (CLI/env) or closed connection (socket), and only the fixed switch
   name is sent to the worker's journal. Values are never printed. Also run a
   protection-key allocate/use/free probe on the broker
   VM: this build host advertises protection keys but Chromium child processes
   fault when using them. If the VM has the same quirk, an operator must verify a
   seccomp rule returning `ENOSPC` for `pkey_alloc` in the unit. A conditional
   systemd drop-in can use `SystemCallFilter=~pkey_alloc` together with
   `SystemCallErrorNumber=ENOSPC`; validate that policy and the sandbox on that VM.
   These settings use systemd's documented [system call filtering](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#SystemCallFilter=).
   Do not apply the single-process test workaround to the production unit.
   The worker runs a separate sandbox AND blank-page renderer probe at startup.
   If it fails or exceeds five seconds, health stays unready and every fill
   returns `browser_unavailable` until the worker is restarted successfully.
4. Install the unit, `systemctl daemon-reload`, then enable/start it only after
   approval. No TCP listener is created. The socket is `/run/tm8-vault/fill.sock`,
   owner `tm8-vault-fill`, group `tm8-vault`, mode `0660` after an owner-only creation window.
   A stale socket after SIGKILL is deliberately not unlinked by runtime code:
   stop the unit, verify no worker holds it, remove that socket, then restart.
5. Point the broker's `RemoteFillDriver` at that socket. Authorization, approval,
   intent binding and audit remain broker responsibilities. This service is not
   an independently authorized agent tool.

The root-owned setgid runtime directory supplies the socket group. `/tmp` is a
private 512 MiB tmpfs. Playwright creates only disposable browser profiles there;
the driver refuses a non-tmpfs temporary directory. No persistent context,
tracing, video, HAR, downloads, clipboard, extensions, cookie export or browser
control capability is exposed. The worker holds one fill at a time, rejects
concurrent fills, and kills its fill process group at the hard deadline. Closing
the broker connection cancels the fill. Parent pipe EOF kills the child group if
the socket supervisor dies. The unit additionally kills the entire cgroup.

## Protocol

One request/response per Unix connection: four-byte unsigned big-endian JSON byte
length, then UTF-8 JSON. Request cap 128 KiB, response cap 16 MiB. Every request has
an opaque `id` (1–128 ASCII letters, digits or hyphens), echoed in every response.

* `{id, op:"fill", intent, username, password_b64}` →
  `{id, op:"fill", outcome: FillOutcome}`. `intent` is exactly `FillIntent`.
  The PNG `screenshot.data` is base64 on the wire, restored to a Buffer by the
  client. There are no other value, DOM, cookie, selector or URL response fields.
* `{id, op:"health"}` → `{id, op:"health", ok:true, ready:boolean}`.
  `ready:false` means a fill is running. Health cannot be mistaken for a fill.

The client rejects mismatched ids/ops and malformed responses with the fixed
`browser_unavailable` refusal and closes the connection. Frame/chunk buffers are
zeroized. Password material supplied by the broker remains caller-owned; the
worker disposes only the `SecretMaterial` it creates. Node/V8 JSON and base64
strings cannot be reliably wiped; lifetimes are bounded to one disposable fill
process and no exception or Playwright output is forwarded.

## Verification

Run from `packages/vault`:

```sh
npx tsc -b
npx vitest run
TM8_VAULT_BROWSER_E2E=1 npx vitest run test/browser
```

Browser and SIGKILL tests skip with an explicit opt-in reason unless that variable
is set. They use local servers, dev mode and generated canaries only. Inspect
`systemctl show tm8-vault-fill` for `LimitCORE=0`, `MemorySwapMax=0`, the dedicated
uid, empty capabilities and cgroup kill policy. Inspect the socket with `stat` and
the browser process tree with `/proc`: no `--remote-debugging-port`, no listening
TCP socket owned by any descendant, and extensions disabled. Use `systemd-analyze
verify deploy/vault/fill-worker/tm8-vault-fill.service` before installation (adjust
the executable paths first). Do not turn on Playwright debugging or crash output.

The SIGKILL test scans captured stdout/stderr and all files under its temporary
runtime/profile tree, including any core files, for raw/base64/hex canaries. It
does not prove absence from physical memory, host journal configuration, swap or
external crash collectors. The unit adds `LimitCORE=0`, `MemorySwapMax=0`, tmpfs,
discarded browser output, fixed worker diagnostics and cgroup teardown; independent review must verify
those controls in the deployed environment. Same-uid agents or root compromise
are outside this local isolation claim; use the separate uid/VM boundary.

On this build host, run the opt-in suite with the existing library bundle:

```sh
LD_LIBRARY_PATH=/home/tm8/chromedeps/root/usr/lib/x86_64-linux-gnu \
  TM8_VAULT_BROWSER_E2E=1 npx vitest run test/browser
```

Tests 2/3/4/6/7/13 explicitly use the in-process test-only option selecting
`--no-sandbox --single-process --no-zygote --disable-gpu`. Each fill still launches
a fresh browser (single-process Chromium only supports one context lifetime on
this host). These tests exercise origin and mechanism behavior; they do not
validate the production Chromium sandbox or protection-key seccomp policy.
Production-entry tests use a fake executable to prove CLI/env test switches are
explicitly refused by fixed name, sandbox flags are retained, failed probes never report ready,
and fills fail closed. Test configuration reaches disposable children only over
an inherited private IPC channel, never through the broker socket or environment.

## Browser policy details

Top-frame and form checks use the shared exact-origin normalizer. Redirect hops
are fetched without automatic following and checked before the next request;
same-origin hops are resolved inside the worker and fulfilled at the initial
same-origin URL. Relative links/forms therefore resolve against that initial URL
(use an explicit site base URL if a login depends on redirected path semantics).
No cross-origin response is ever fulfilled under a trusted origin. A checked
submit may follow an off-origin GET redirect, reported as `finalOrigin`; a 307/308
that would forward a password body off-origin is aborted. Cross-origin requests
carrying raw, URL/form-encoded, base64/base64url or JSON-escaped password variants
are blocked as a best-effort defense; arbitrary transformations are not covered.

Screenshots mask every form control in every frame and text-containing elements
found from the already-filled DOM values; no password is supplied to `evaluate`.
Iframes are fully masked. After submit the document is conservatively fully masked
because reflection can move a filled value anywhere after navigation. Both the
pre-submit and end screenshot are taken; the current seam returns the final one
and the earlier PNG is zeroized. Masking is defense in depth for a trusted site;
it is not a guarantee against arbitrary malicious rendering or transformations.

## Known limits for the independent review

The lead integration review (subtask `01a1fac0-e500`) left these open on purpose.
None blocks the flag-off build with test material only. The security review and the
penetration test must assess each one before the vault holds a real secret.

* Masking finds text in the DOM and in form values. Canvas drawing, CSS generated
  content, transformed text and closed shadow roots on the bound origin can still
  show a filled value in the screenshot that is returned to the agent.
* The off-origin value guard checks HTTP requests only. Page WebSockets are closed
  and service workers are blocked, but neither WebRTC nor WebSockets opened from
  dedicated workers has been shown to be covered. Custom encodings are not covered.
* The agent chooses `startUrl` within the bound origin. On multi-tenant origins,
  restrict it to the item's login path or to an allowlist (follow-up).
* If a fill child fails to spawn and never emits `exit`, the worker stays busy
  and refuses fills until it restarts. This fails closed and affects availability only.
* The broker must set `FillIntent.devMode` from its own configuration, never from
  the agent's request. Changing an item's origin must require an owner WebAuthn
  step-up, because the origin is the fill's only trust anchor.

## Rollback

Set the vault flag off, stop/disable `tm8-vault-fill`, and stop broker calls to its
socket. Verify its cgroup is empty; remove only the stale socket after that check.
Restore the previous read-only release/browser paths and unit, daemon-reload,
then verify with generated test material before restarting. Removing this unit
needs no database migration and must fail fills closed. Remove the tmpfiles entry
or dedicated account only after the broker no longer needs the shared directory;
never recursively remove `/run/tm8-vault` while the broker is running.
