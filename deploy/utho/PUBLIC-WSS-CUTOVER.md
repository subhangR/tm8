# Utho public HTTPS/WSS cutover runbook

This runbook is staged. The existing VPN listeners remain intact until every
positive and negative public-path receipt below is captured. Any loss of
authenticated HTTPS/WSS/interactive PTY, authorization ambiguity, or missing
rollback is a stop condition.

## 1. Preflight gates (all required)

1. Build and test the exact commit to deploy. Record `git rev-parse HEAD` and
   verify the worktree is clean. Run the repository check, migration check,
   server WebSocket suites, UI transport suite, CLI attach suite and secret
   scan. Confirm migration `087_single_use_stream_grants.sql` is pending exactly
   once and the database backup target has free space.
2. Confirm `tm8-prod` still binds only `127.0.0.1:17777`, runs as the unprivileged
   `tm8` account, has `TM8_DISABLE_AUTO_OWNER=1`, and will receive
   `TM8_ALLOWED_HOSTNAMES=tm8.sh` plus `TM8_ALLOWED_ORIGINS=https://tm8.sh`.
3. Confirm public DNS still resolves to this host; the Let's Encrypt certificate
   covers `tm8.sh`, is currently valid, and TLS 1.2/1.3 succeed. Confirm public
   app/DB high ports remain externally closed.
4. Snapshot, with root-only permissions: current release and previous release,
   database (`pg_dump`), nginx config, systemd unit/drop-ins, UFW numbered rules,
   and Tailscale status/rules. Validate the database dump can be listed.
5. Run `nginx -t` against a temporary config containing
   `nginx/conf.d/tm8-websocket.conf` and `nginx/sites-available/tm8-sh`. Its
   access log format must use `$uri`, never `$request_uri`, `$args`, Cookie,
   Authorization, Referer or `Sec-WebSocket-Protocol`.
6. Prove an admin path that does not depend on the rules being removed. Required:
   a restricted SSH source/CIDR or an equivalent private admin route, a tested
   Utho provider-console login, and a timed automatic firewall rollback. Public
   unrestricted SSH is not proof. If any of these is missing, firewall and VPN
   removal are prohibited.

## 2. Deploy replacement path while retaining VPN

1. Deploy the application release and migration with the repository's reversible
   release rotation. Do not edit UFW, SSH, Tailscale or DNS.
2. Install the systemd drop-in, run `systemctl daemon-reload`, restart only
   `tm8-prod`, and verify loopback `/health` reports database `ok`.
3. Install the nginx `http` include and public site as replacements for the
   snapshotted files. Keep every existing VPN listener/server block enabled.
   Run `nginx -t`, then reload (not restart) nginx.
4. Verify public HTTP redirects to HTTPS, HTTPS UI and `/health` succeed, the
   certificate chain is valid, and an unauthenticated API request is refused.

Rollback for this stage: restore the snapshotted nginx files and systemd
drop-in, run `nginx -t && systemctl reload nginx`, rotate the previous app
release back, and restart `tm8-prod`. Migration 087 is additive; rolling the app
back leaves it unused. Restore the database backup only if release rollback
cannot run against the additive schema.

## 3. Public positive and negative evidence (outside VPN)

Use a host with Tailscale/VPN disabled. Never paste credentials into command
arguments or URLs. `verify-ws-upgrade.mjs` reads credentials from environment
and prints only status plus the public selected protocol.

Positive receipts:

- Browser login over HTTPS sets `__Host-tm8-session` with Secure, HttpOnly,
  SameSite=Strict and Path=/; no credential appears in browser WS URLs.
- Event WSS upgrades with the cookie and receives a new durable event, then
  reconnects/resumes at the prior cursor.
- `execution.streams.attach` mints a fresh grant over authenticated HTTPS;
  interactive PTY output, text input, binary input and resize work through WSS.
  Interrupt the network once and prove a freshly minted grant reconnects at the
  prior raw offset/epoch without duplicated or skipped output.
- The 101 selects exactly `tm8-pty-v1`; it never selects or returns the grant.

Negative receipts (capture HTTP status and secret-free audit event only):

- no event cookie → 401; no PTY grant → 401;
- wrong Origin, including `http://tm8.sh` and an alternate HTTPS port → 403;
- expired, replayed, wrong-session, wrong-mode and wrong-identity grants → the
  same `403 attach refused` response;
- a view grant can render but binary input and resize do not reach the PTY;
- parallel use of one grant yields exactly one 101 and one indistinguishable 403;
- connection/rate limits yield 429, total saturation yields 503, oversized
  frames close with policy/size codes, slow consumers reconnect/resume, and idle
  plus absolute timeouts close cleanly;
- nginx and application logs contain no session cookie, Authorization bearer,
  PTY grant, grant hash, query argument or protocol-offer value.

Repeat a consumed grant only to prove replay; never reuse a grant intended for
the interactive positive test. Mint a new grant for every reconnect.

## 4. Remove VPN dependency only after accepted receipts

Before changing UFW, schedule an automatic restore from the root-only snapshot
for ten minutes later, verify it is queued, and keep the provider console open.
Then remove only the obsolete VPN application listener/rules. Keep the app and
database bound to loopback; keep default-deny incoming/routed; do not expose
17777 or the database port. Restrict SSH to the already-proven admin source/path.
Do not uninstall Tailscale if it remains the only verified admin route.

Cancel the timed rollback only after a second outside-VPN HTTPS/WSS/interactive
PTY run and an independent admin login both pass. Preserve the snapshot and
previous release until the observation window closes.

## 5. Post-cutover observation and rollback

Re-run all positive and negative probes after VPN application rules are gone.
Observe `/health`, `tm8-prod`, nginx error logs, secret-free PTY audit events,
connection counts, 429/503 rate, database pool health and certificate renewal.
Rollback on any unexpected attach, origin ambiguity, reconnect gap, elevated
5xx rate, or loss of admin access: let the timed firewall restore fire (or run it
from provider console), restore VPN nginx/rules, restore the prior nginx config,
and rotate the previous application release back.
