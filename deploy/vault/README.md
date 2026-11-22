# Secure Vault: deploy, verify and roll back

Open this runbook before deploying a tm8 build that contains the Secure Vault
(task `01a1fa87`), before rolling one back, and before anyone turns the vault on.
The isolated browser worker has its own runbook: [fill-worker/README.md](fill-worker/README.md).

**The vault ships OFF.** No real secret may enter it until the independent security
review and the penetration test (brief MSG 15) have both passed and an operator has
recorded that. Nothing in this directory provisions a server, a KMS key, a bucket, a
retention policy or a payment processor, and none of it installs or enables itself.

## 1. What a flag-off deploy changes

| Part | With `TM8_VAULT_MODE` unset or `off` |
| --- | --- |
| Server relay `/v2/vault/*` | Present. After authentication every call answers `503`, code `upstream_unavailable`, reason `vault_disabled`. Unauthenticated calls get the usual `401` first. No broker is contacted and no other vault knob is read. |
| Capture page `/vault/capture/*` | `404` for everyone, never the SPA. |
| Settings → Secure vault (UI) | Says “The vault is switched off.” It calls only the same-origin relay and sends no bearer. |
| Broker and fill worker | Not running. Nothing starts them. |
| Chat paste guard | Its own knob, `TM8_VAULT_PASTE_GUARD`, which this deploy also leaves unset or `off`. Off, the server builds nothing, and every message is stored as sent. Any value but `off` or `on` refuses to boot: the node never listens, and the journal shows `tm8-server failed to start: vault relay: TM8_VAULT_PASTE_GUARD must be off or on`. Turning it on is §5's last subsection. |
| Database | Migrations **450** and **451** apply (below). They write no member data. The one row 450 inserts is the audit chain's genesis head. |

**Migration 450 (`450_vault_store.sql`)** creates:
- schema `vault`. Every table that holds member data has RLS. The two exceptions are:
  - `session_hashes`, which no role but the schema owner can read; it is reached only
    through security-definer functions;
  - `audit_head`, the one global chain-head row, which the broker reads. That is the
    cross-tenant count leak listed in §6.
- three `NOLOGIN` roles: `tm8_vault_owner`, `tm8_vault_broker` and `tm8_vault_audit_writer`;
- membership in the owner and audit-writer roles for the migrating role.

`tm8_app` gets no reach into the schema. The role creation is race-safe, so concurrent applies on one cluster do not collide.

450 reuses a vault role that already exists only if the role has exactly the attributes 450
would have given it: no `LOGIN`, `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`,
`REPLICATION` or `INHERIT`, and membership in no other role. Otherwise 450 fails with
`42501` (`vault: a vault role exists with attributes or memberships 450 does not grant`)
and applies nothing. The reason: the broker works as `tm8_vault_broker`, and row security
does not bind a superuser or `BYPASSRLS` role. Roles that hold a vault role, such as the
migrating role or the broker's login role, are not checked.

**Migration 451 (`451_vault_alert_notifications.sql`)** adds one function,
`internal.vault_notify(...)`, through which the relay files vault alerts in the owner's inbox.

## 2. Deploy (flag off)

The rule in force: this task authorizes code and tests only. A deploy is a production
change, so it needs the owner's agreement for that occasion, and the SERVER cutover
cannot be run from an agent session.

1. On the deploy machine (root `ssh utho`), print the plan:
   `./deploy/utho/deploy.sh prod <sha> --plan`
2. Read the migration delta it prints in full. For the vault it must be exactly:
   - `A db/migrations/450_vault_store.sql`
   - `A db/migrations/451_vault_alert_notifications.sql`
   
   Anything else in the delta belongs to other work on main. Account for it before going on.
3. Confirm the prod environment has no `TM8_VAULT_*` knob, or only `TM8_VAULT_MODE=off` and
   `TM8_VAULT_PASTE_GUARD=off`.
4. Run the deploy without `--plan`. It requires typed confirmation, and it applies the
   migrations under its explicit superuser URL.

## 3. Verify after the deploy

Run these against prod's public origin, replacing `<origin>`. None of them needs a
secret. The relay admits only a member's or an agent's own session, never the node's
loopback owner, so a call without a session gets `401` on any address.

```sh
# The relay is mounted and refuses before any vault decision: 401 without a session.
curl -s -o /dev/null -w '%{http_code}\n' <origin>/v2/vault/status            # expect 401
# The capture page is not served while the vault is off.
curl -s -o /dev/null -w '%{http_code}\n' <origin>/vault/capture/x            # expect 404
curl -s <origin>/vault/capture/x                                             # expect: the vault is off on this node
```

- **Signed in:** open Settings → Secure vault. It says “The vault is switched off.” The
  browser's network panel shows `503` for `/v2/vault/status`.
- **Journal:** the server's boot log does NOT contain `vault relay on`. That line
  appears only when the mode is not off. Nor does it contain `vault paste guard on`, which
  appears only when `TM8_VAULT_PASTE_GUARD=on`.
- **Database:** as the migration owner, check:
  - `select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname like 'tm8_vault\_%'` gives three rows, all `f`;
  - `select count(*) from vault.items` gives `0`;
  - `select has_schema_privilege('tm8_app','vault','USAGE')` gives `f`.

## 4. Rollback

**Code.** Redeploy the previous sha with the same script:
`./deploy/utho/deploy.sh prod <previous-sha>`. With the vault off, no vault state is lost.
The previous build simply has no `/v2/vault` relay or capture route.

**Paste guard.** Set `TM8_VAULT_PASTE_GUARD=off`, or remove it, and restart the server.
Text it already redacted stays redacted. The guard never stores what it removed, so no
rollback can bring that text back.

**Schema.** Roll back only if the schema itself must go; the previous build ignores it.
Roll back 451 before 450, as the migration owner, with the vault off. Each down file's
header holds the authoritative commands:

```sh
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/451_vault_alert_notifications.down.sql
psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '451_vault_alert_notifications.sql'"
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/450_vault_store.down.sql
psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '450_vault_store.sql'"
```

- **451's down** drops only the function. Inbox rows it already wrote stay until the owner decides otherwise.
- **450's down** drops schema `vault` and everything in it. It also drops each vault role
  that no other database still holds. It touches no graph table and does not alter `tm8_app`.

  Under flag-off the schema is empty. Once the vault is on, this down DESTROYS every vault
  row and the audit chain. Archive the checkpoint sink and the deletion ledger first.

  After any later re-apply, grant `tm8_vault_broker` to the broker's login role again,
  because a dropped role takes its memberships with it.

**Re-deploying later.** If the code is redeployed later, `migrate up` applies 450 and 451 again.
A vault role that survived the down, because another database on the cluster still holds
it, is reused as it is. If its attributes or memberships have changed since, 450 refuses
with `42501` and applies nothing. Restore the role to the attributes listed in §1. Never
loosen the check.

## 5. Turning the vault on: NOT authorized yet

Each step below needs its own explicit owner decision. Production also needs the
recorded review gate. The broker enforces the rules listed here at start, and refuses
with a fixed line naming only the knob: `vault broker: invalid <KNOB>`. It never prints
the value.

### Modes

| Mode | What it allows |
| --- | --- |
| `dev` | Local development only. |
| `pre_review` | Test secrets only. At most `TM8_VAULT_PRE_REVIEW_MAX_ITEMS` live items per member (default 20). Fills and API calls go only to the exact test origins in `TM8_VAULT_PRE_REVIEW_FILL_ORIGINS` and the hosts in `TM8_VAULT_PRE_REVIEW_API_HOSTS`. |
| `production` | Refuses to start unless every condition below holds. |

`production` requires all of the following:
- `TM8_VAULT_REVIEW_GATE=passed`;
- `TM8_VAULT_KMS_KIND=gcp-kms`;
- a checkpoint sink (`TM8_VAULT_AUDIT_SINK`, `file` or `gcs`) signed through `TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION`;
- no local KEK file and no local checkpoint key;
- an mTLS listener, with the relay's client certificate pinned (`TM8_VAULT_RELAY_CLIENT_CERT_SHA256`);
- a dedicated database role.

`TM8_VAULT_SPEND` must stay `false`: payments are `disabled_v1`, and the broker refuses `true`.

**The relay refuses `production` today (review F03).** A broker can be configured as above,
but the tm8 server will not boot with `TM8_VAULT_MODE=production`. See *Relay key isolation*
below for why, and for what lifts it.

### Topology A: the only production shape

The broker runs on its own host under its own uid. The relay in the tm8 server reaches
it only over mutual TLS:

| Side | Knobs |
| --- | --- |
| Relay (tm8 server) | `TM8_VAULT_MODE`, `TM8_VAULT_BROKER_URL` (an https origin), `TM8_VAULT_RELAY_TLS_KEY_FILE`, `TM8_VAULT_RELAY_TLS_CERT_FILE`, `TM8_VAULT_RELAY_TLS_CA_FILE`, `TM8_VAULT_RELAY_PRIVATE_KEY_FILE`, `TM8_VAULT_AGENT_RUN_AS`, `TM8_VAULT_RETIRED_KEY_SHA256` |
| Broker | `TM8_VAULT_BROKER_MTLS_LISTEN`, `TM8_VAULT_BROKER_TLS_KEY_FILE`, `TM8_VAULT_BROKER_TLS_CERT_FILE`, `TM8_VAULT_BROKER_TLS_CA_FILE`, `TM8_VAULT_RELAY_CLIENT_CERT_SHA256`, `TM8_VAULT_RELAY_PUBLIC_KEY_FILE`, `TM8_VAULT_RETIRED_KEY_SHA256` |

- The relay signs every request with an Ed25519 key (`TM8_VAULT_RELAY_PRIVATE_KEY_FILE`).
  The broker holds only the public half (`TM8_VAULT_RELAY_PUBLIC_KEY_FILE`).
- The relay refuses to boot unless its key files are `chmod 600` and owned by the server's user.
  That keeps other users out. It does not keep out a process that runs as the server's user,
  and today every agent session, terminal and tool does (*Relay key isolation*, below).
- **The browser origin travels inside the signature (attestation v2).** The relay forwards no
  `Origin` header. For a browser session only, it signs into the attestation the `Origin` that
  the server's own Origin and CSRF checks accepted. A CLI or agent session never gets one. The
  broker serves a human-only command only when that signed origin is exactly one of
  `TM8_VAULT_WEBAUTHN_ORIGINS`, and it ignores any raw `Origin` header. So:
  - set `TM8_VAULT_WEBAUTHN_ORIGINS` to the origins browsers load tm8 from;
  - set `TM8_ALLOWED_ORIGINS` on the server to the same list, so both sides match origins exactly.
- **Upgrade the relay and the broker together.** The version is signed. A broker refuses a v1
  attestation with `bad_signature`, and a v1 broker refuses a v2 relay the same way.

**Unix socket (`TM8_VAULT_BROKER_SOCKET`).** The broker always listens on it, in production
too, next to the mTLS listener. It refuses to start unless the socket's directory is
exactly `0700` and owned by its own uid, and it makes the socket `0600`. So only that
same uid can connect.
- **Default path:** `/run/tm8-vault-broker/broker.sock`. A non-root broker cannot create a
  directory in `/run`, so its unit creates one with `RuntimeDirectory=tm8-vault-broker`
  and `RuntimeDirectoryMode=0700`.
- **Never `/run/tm8-vault`.** The fill worker's `tmpfiles.conf` makes that directory
  group-shared (`2770`), and the broker refuses it.
- **Only `dev` and `pre_review`** may point the relay at the socket. A relay under a
  different uid on the same host has no supported socket path; that is an open review
  item. In production the relay refuses the socket.

### Relay key isolation (review F03)

The relay's signing key lets its holder call the broker as any member, and its TLS key lets
it connect. Today the tm8 server starts agent sessions, terminals and tools as its own user:
`pty.spawn` in `packages/execution/src/pty/PtyHostService.ts` passes no uid or gid, and a
search of every package's source (2026-11-21) found no spawn that sets another uid, gid or
`sudo -u`. So an agent can read both key files, and the memory of
the server process that holds them. Some agent postures wrap shell commands in the provider's
own sandbox (codex `--sandbox`). That sandbox runs as the same user, depends on the posture,
does not cover terminals, and does not work on every node (`spawn/sandbox-probe.ts`). The keys
cannot rely on it.

Five controls ship now. None of them is the boundary itself.

- **The relay refuses `production`.** Boot stops with
  `vault relay: TM8_VAULT_MODE production is refused (review F03): ...`. It comes after the
  checks that exactly one of the socket and the URL is set and that production uses the URL,
  after the agent-boundary checks below, and before any key file is opened. No knob lifts it. Only a
  code change in `packages/server/src/vault/config.ts` does, and only after all of these:
  1. Agent execution runs outside the key holder's reach, behind an OS or service boundary that
     the agents cannot change. The open owner decisions are D1 (the docker group), D2 (which
     boundary) and D3 (the signer); see design doc `01a1fe13`.
  2. Reach checks show that no agent process can read the keys, the server's memory, host
     credentials or docker and root paths (D5, checks R1-R9).
  3. The relay keys are rotated at cutover. Agents could read the keys a `pre_review` relay
     held, so treat those keys as exposed.
  4. The cross-member identity forgery test passes in staging. D7 covers the staging resources
     and D9 who runs the test.

  `dev` and `pre_review` still boot. They hold synthetic test secrets only.
- **The broker pins the relay's certificate.** A CA can issue more than one client
  certificate, so a chain to `TM8_VAULT_BROKER_TLS_CA_FILE` is not enough. Whenever
  `TM8_VAULT_BROKER_MTLS_LISTEN` is set, in every mode, the broker also requires
  `TM8_VAULT_RELAY_CLIENT_CERT_SHA256`: the SHA-256 of the relay certificate's DER. A pin set
  without a listener is refused as stray config.
  - **Computing the pin.** Either form works:
    - `openssl x509 -noout -fingerprint -sha256 -in relay.crt`, keeping the 32 colon-separated
      pairs after `=`;
    - `openssl x509 -in relay.crt -outform DER | sha256sum`, keeping the 64 hex digits.

    The pin is a hash of a public certificate, not a secret, so it can sit in the unit's
    environment. The keys stay in their `0600` files; never move a key into an environment
    variable.
  - **What it refuses.** The broker checks the pin once per connection, as the TLS 1.3
    handshake completes.
    - A connection with any other certificate closes with no response.
    - A request that arrived with that handshake is dropped before any handler runs.
    - Each refusal increments the broker's refused-peer counter and logs
      `{"event":"vault_broker_mtls_peer_refused","fingerprint":"<sha256 hex>"}`, the
      fingerprint of the refused public certificate.
    - Nothing alerts on these yet.
  - **What it does not cover.** The pin closes every other certificate the CA issued. It cannot
    help once the relay's own key is read. That is what the production refusal is for.
  - **Rotation.** The broker accepts exactly one pin. Issue the new relay certificate, set the
    broker's pin to it and restart the broker, then restart the relay with the new certificate.
    The relay is refused in between, so plan a short outage.
- **The relay checks the agent boundary at boot (design doc `01a1fe13`, D5: checks R1 to R8).**
  `TM8_VAULT_AGENT_RUN_AS` names where agent sessions run, apart from this server:
  `uid:<uid>`, `uids:<first>-<last>` or `gvisor:<first>-<last>`, in decimal uids from 1 to
  4294967294. Which form is the owner's decision D2, so it is a knob and not a constant.
  - Production refuses to boot without it. In `dev` and `pre_review` it is optional, and
    without it boot is unchanged. A malformed value refuses in every mode but `off`.
  - With it set, boot refuses in every mode on any failure, and names each one:
    `vault relay: refused (review F03 agent boundary): R3 TM8_VAULT_AGENT_RUN_AS cannot be met while ...`.
    The files checked are the signing key and, over mutual TLS, the TLS key, certificate and CA.
  - On a host shaped like today's (the server in the docker group, `/proc` without `hidepid`,
    cores piped to a program), setting it stops boot. Leave it unset there.

  | Check | Refuses when |
  | --- | --- |
  | R1 | this server's uid is in the agent range, or an agent uid owns one of the files |
  | R2 | a file's path is not canonical (a link, `.` or `..` in it), or the file or any directory up to `/` is owned by an agent uid or writable by group or others; a sticky directory is allowed |
  | R3 | this server is in the docker group, or can open a container daemon socket: docker, containerd, podman, CRI-O or BuildKit, under `/run` or `/var/run` |
  | R4 | an agent could hold a group that reaches root, the journal, the vault or this server (`FORBIDDEN_AGENT_GROUPS` in `packages/server/src/vault/boundary.ts`, and every group this server is in): as its private group, its passwd primary group, or a listed member |
  | R5 | Yama `ptrace_scope` is 0; or, for `uid:` and `uids:`, a proc mount this process sees lacks `hidepid=invisible` (or `2`, `4`, `ptraceable`) or names an agent group in `gid=`. A gVisor sandbox has its own `/proc`, so that half is skipped |
  | R6 | the core limit is not 0 soft and hard (`LimitCORE=0`), or `kernel.core_pattern` pipes cores to a program, which ignores the limit |
  | R7 | a relay key is on `TM8_VAULT_RETIRED_KEY_SHA256` (next item) |
  | R8 | over mutual TLS: the certificate does not match the TLS key, is a CA, or is outside its validity, or the CA file is not exactly one PEM block holding a CA certificate |

  The order is the knob's form, each file's `stat`, R1 to R6, the production refusal, the reads,
  R7, then R8. An unreadable or malformed host file fails its check.
  - **A pass is not the boundary.** These are this process's reads of its own host, once, at
    boot. A pass does not lift the production refusal.
  - **Not checked.** R9, the signer socket's peer, waits on decision D3. The spawner does not
    read the knob yet (design doc N1), so nothing makes agents run as it. Users and groups only
    NSS knows (N2), ACLs beyond the group mask, LSM rules and other mount namespaces are not seen.
    R4 assumes an agent's private group has its uid as gid. A change after boot is not seen: the
    design's 10-minute re-check is a follow-up. A file can still change between its `stat` and its
    read; R2 is what keeps agents from changing it.
- **Retired keys (checks R7 and B2).** `TM8_VAULT_RETIRED_KEY_SHA256` lists the SHA-256 of each
  retired key's public half as DER SubjectPublicKeyInfo: up to 256 entries, comma-separated, each
  64 hex digits or 32 colon-separated pairs. Set the same list on both sides.
  - The relay refuses to load a listed signing key or TLS client key. With a non-empty list it
    parses the TLS key at boot, and refuses one it cannot parse.
  - The broker refuses a listed relay public key at start, and closes an mTLS connection whose
    certificate carries a listed key.
  - A malformed list refuses in every mode but `off`.
  - Compute an entry with `openssl pkey -in relay.key -pubout -outform DER | sha256sum`, or
    `openssl pkey -pubin -in relay.pub -outform DER | sha256sum`. A fingerprint is not secret.
  - The list ships empty. No key has been rotated or listed.
- **The broker checks its own host at start (check B3).** It may not be in the docker group or
  able to open a container daemon socket (the R3 list). Production refuses to start with
  `vault broker: refused (host boundary: docker_group, container_socket)`; `dev` and
  `pre_review` log `vault_broker_host_boundary` and run. The core-dump and swap half of B3 is the
  memory check in *Plaintext in broker memory*. Groups only NSS knows, a daemon on another path
  or on TCP, and sudo grants are not seen.

### Database

- `TM8_VAULT_DATABASE_URL` names a LOGIN role whose only membership is `tm8_vault_broker`.
- The role is not a superuser and has no `BYPASSRLS`, because either one ignores vault
  RLS. It also has no `CREATEROLE` or `CREATEDB`, and no membership besides
  `tm8_vault_broker`. Production refuses any other role. The other modes start, but log
  `vault_broker_database_role_not_dedicated`.
- The URL carries no password; the password comes from `PGPASSFILE` only.
- Never point the broker at the migration owner or at `tm8_app`.

### Files the operator creates (the broker never provisions them)

- **`TM8_VAULT_DELETION_LEDGER`:** the append-only deletion and revocation ledger. It
  holds one JSON line, fsynced, for each:
  - deleted item;
  - revoked grant;
  - consumed one-use approval.

  Each line is written before the transaction that makes the change commits. At every
  start, the broker replays the whole file before it serves, so a restored database backup
  never revives a deleted item, a revoked grant or a consumed approval.

  Keep the file on different media from the database, and never restore it from the same
  backup: a ledger rolled back with the database undoes its own guarantee. The file is
  0600 and owned by the broker user. The start stops with `vault broker: start failed`,
  before the socket binds, when a line cannot be parsed or names a grant or approval
  under another item. Either one means the file has been damaged.

  When the file cannot be written:
  - deleting an item fails and deletes nothing;
  - a use that needs a one-use approval fails and nothing runs;
  - revoking a grant still revokes it in the database and then reports the error. Until a
    retry succeeds, a restore could bring that grant back.
- **Checkpoint sink:**
  - `file` uses the directory `TM8_VAULT_CHECKPOINT_DIR`;
  - `gcs` uses the bucket `TM8_VAULT_GCS_BUCKET`.

  tm8 writes create-only objects. It never sets, holds or locks a bucket's retention.
  **Do not enable Bucket Lock or any irreversible retention** until the owner decides so
  explicitly.

  **The sink is the audit chain's independent anchor (review F01).** The database's own
  record of what was anchored is only a hint. On every verification the broker:
  - reads the newest signed checkpoint back from the sink itself;
  - checks its signature with the checkpoint key;
  - requires the chain to contain that exact head.

  Startup runs in this order: verify, anchor anything left unanchored, verify again, check
  freshness. Only then does it bind. Each `TM8_VAULT_CHECKPOINT_INTERVAL_MS` the broker
  anchors a new head and verifies from its last verified seq. Each
  `TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS` (default one hour) it walks every event from seq 1,
  which also finds an old event edited in place.

  A failure is logged as `vault_audit_anchor_failed` with one of these reasons:

  | Reason | Meaning | Effect |
  | --- | --- | --- |
  | `anchor_rollback` | The sink holds a signed head beyond the database's chain, for example a database restored from an older backup. | Fails closed until an operator restarts the broker on a good database. |
  | `anchor_conflict` | The sink's head is not in the chain (a fork or a rewritten event), or a file sink holds two heads for one seq. | Same. |
  | `anchor_missing` | A head the database recorded as anchored, or that this process saw retained, is gone from the sink. | Same. |
  | `anchor_invalid` | The retained object is malformed, or its signature does not verify: another key, or KMS refusing the version (destroyed or disabled). | Same. |
  | `anchor_unavailable` | The sink or KMS cannot be read right now. | Audited actions continue only within the budget below. |
  | `anchor_stale` | An event has stayed unanchored, or the anchor unverified, for longer than `TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS` (default 15 minutes). | Audited actions fail closed until a checkpoint and a verification cover it. |

  The budget must be at least twice the checkpoint period, so one missed checkpoint does not
  fail the broker closed. A start is refused when its sink cannot be read. It is also refused
  when it cannot anchor events that have stayed unanchored for longer than the budget.

  Operating rules that follow from this:
  - **Production GCS needs a retention policy on the bucket before the broker starts.** It
    may be locked or unlocked. The broker only reads it, logs it as
    `vault_checkpoint_sink {retention}`, and refuses to start without one
    (`audit_unavailable`).
  - **Give the bucket no lifecycle rule that deletes or rewrites objects under
    `checkpoints/`.**
  - **Grant the broker's service account no more than this:** `storage.objects.create`,
    `storage.objects.get` and `storage.objects.list` on the bucket, plus
    `storage.buckets.get` to read the retention policy. Give it no delete and no update.
  - **Keep a KMS checkpoint key version enabled while it signed the newest retained
    checkpoint.** After rotating `TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION`, the old version
    stays the newest signer until the chain advances and the next checkpoint is anchored.
    The broker accepts another version of the same cryptoKey only.
  - **A local checkpoint key (`dev` and `pre_review` only) vouches only for itself.**
    Rotating it needs a fresh checkpoint directory.
  - **A new, empty database needs a fresh bucket or directory.** An old sink holds heads
    the new chain never had, so it is reported as `anchor_rollback`.
  - **No knob bypasses a rollback.** The supported recovery is to restore a database that
    contains the newest anchored head. Starting over with a new database and a new sink is
    an owner decision; keep the old sink as evidence. A database that recorded anchors in
    a sink, pointed at a new, empty one, fails with `anchor_missing`, as intended.
  - **A checkpoint written to the sink whose database record then failed is not lost.** The
    next verification reads it back from the sink, so the anchor stays fresh. Until the chain
    advances, each attempt to anchor that same head again fails and logs
    `vault_checkpoint_failed`.
- **Keys and the canary file:** mode `0600`, owned by the service user.
  - `TM8_VAULT_CANARY_FILE` holds operator decoy values, one per line, 12+ characters each.
  - The planting of canaries in production is still open.

### Process hardening (broker unit)

- Run under a dedicated non-login uid. Share the `tm8-vault` group only with the fill
  worker; agents and the tm8 server uid must not join it.
- Keep the broker out of the docker group and away from every container daemon socket. In
  production it checks both at start and refuses to run otherwise (check B3, *Relay key
  isolation* above).
- Set:
  - `LimitCORE=0` and `MemorySwapMax=0`. In production the broker checks both at start and
    refuses to run without them (see *Plaintext in broker memory* below);
  - not `ProcSubset=pid`: it hides `/proc/sys/kernel/core_pattern` and `/proc/swaps`, so the
    production check fails closed;
  - `UMask=0077` (the broker also sets umask 077 itself);
  - `NoNewPrivileges=yes`;
  - `ProtectSystem=strict`, with `ReadWritePaths` limited to the socket directory, the
    ledger and the checkpoint directory.

  The fill worker's unit is a working model.
- **`TM8_VAULT_FILL_SOCKET`:** the broker's default is the shipped worker unit's own path,
  `/run/tm8-vault/fill.sock`, and `test/broker/deploy-defaults.test.ts` keeps the two
  equal. If you move it, set the knob on both units.
- **Start command:** `node packages/vault/dist/broker/main.js`, with no argument. Any
  argument other than `enroll`, including `serve`, stops it with
  `vault broker: invalid arguments`. Mode `off` exits 0 before it opens a database, a KMS,
  a file or a socket.

### Plaintext in broker memory (review F05)

The broker wipes the plaintext buffers it owns. It cannot wipe everything: Node has no `mlock`
for the V8 heap and cannot wipe a string. So this section lists what is wiped, what is not, and
what the host must do. Nothing here claims locked-memory erasure.

**Wiped by the broker** (each has a regression test in `test/gcp` or `test/crypto.test.ts`):
- **KMS and token responses** (`gcp/http.ts`, `gcp/kms.ts`, `gcp/token.ts`):
  - requested uncompressed (`Accept-Encoding: identity`), so no decompression buffer holds them;
  - read as chunks that are used in place, not copied;
  - every chunk, and the joined copy, zeroed in a `finally` once parsed, on success and failure.
- **The decrypted DEK:**
  - decoded from base64 straight into a Buffer. A canonical-form check replaces the old
    re-encode to a string;
  - the parsed `plaintext` field is deleted as soon as it is decoded.
- **A DEK sent to KMS `encrypt`:** the request body is a Buffer the broker builds and zeroes. It
  is never a base64 or JSON string.
- **AES-GCM decryption** (`crypto/gcm.ts`; secret versions, the local-dev KEK, capture
  envelopes):
  - returns the one buffer `update()` wrote, not a concatenated copy;
  - `update()` yields real plaintext before `final()` checks the tag. So when the tag fails
    (a wrong AAD or a forged tag under the right key), that buffer is zeroed before the error
    propagates.

**Copies the broker cannot wipe.** These stay in memory until it is reused:
- the JSON text of a KMS response, as a V8 string, while `JSON.parse` reads it;
- the parsed `plaintext` value (the base64 DEK), as a V8 string. It is deleted from the object
  at once, but the string is not wiped. V8's young-generation collector may also have copied
  it;
- undici and OpenSSL internals:
  - TLS record buffers;
  - the HTTP parser;
  - the copy `fetch` makes of a Buffer request body;
- the OAuth access token, which is a string;
- every `SecretMaterial.utf8()` result: the string an HTTP header or Playwright's `fill`
  needs;
- CPU registers. SSE/AVX state can still hold AES round keys or plaintext bytes after an
  operation.

**Keeping memory off disk** (`src/broker/host-memory.ts`):
- **In every mode, at start, before it reads a key:** the broker writes 0 to its own
  `/proc/self/coredump_filter` and reads it back.
  - The kernel applies that filter to every core it writes, to a file or a pipe. So a core
    carries no heap, no stack and no mapped memory.
  - A core still holds the ELF headers, the vDSO, each thread's registers, the start of the
    command line and the list of mapped files.
- **Production refuses to start** (`vault broker: refused (host memory: …)`) unless all of these
  hold:
  - that filter reads back 0;
  - `RLIMIT_CORE` is 0, both soft and hard;
  - `kernel.core_pattern` is a file, not a pipe. The kernel ignores `RLIMIT_CORE` for a piped
    core (core(5)). Ubuntu's apport and systemd-coredump both pipe, and so does this build
    host;
  - the effective cgroup v2 `memory.swap.max` (the lowest on the broker's cgroup path) is 0.
    Swap that is off today could be turned on later, so `0` is required even with no swap
    active.
- **The other modes** log `vault_broker_host_memory` with the same facts, and run.
- **The core pattern is a host-wide setting.** Set a file pattern on the dedicated broker host
  (F03), for example `kernel.core_pattern=core`. With that pattern and the 0 limit, no broker
  core is written at all.

**Host checks before real secrets.** These need the real broker host, so none has been done:
- the unit: `systemctl show tm8-vault-broker -p LimitCORE -p MemorySwapMax`;
- the running process:
  - `grep 'core file' /proc/<pid>/limits` shows 0 and 0;
  - `cat /proc/<pid>/coredump_filter` shows `00000000`;
  - `grep VmSwap /proc/<pid>/status` shows `0 kB`;
- `memory.swap.max` in the broker's cgroup (`/proc/<pid>/cgroup` names it) reads `0`.
  `swapon --show` may still list swap;
- `sysctl kernel.core_pattern` does not start with `|`;
- **hibernation:** a hibernation image holds all memory.
  - Check `/sys/power/state` and the kernel command line for `resume=`.
  - Mask `hibernate.target`, `hybrid-sleep.target` and `suspend-then-hibernate.target`;
- **kdump:** a vmcore holds all physical memory. `/sys/kernel/kexec_crash_loaded` reads 0, or
  the dump target is access-controlled like the keys;
- **the VM:** memory snapshots, suspend-to-disk and live-migration images hold all memory. That
  is a cloud-provider setting the guest cannot check;
- **a crash test in staging:** start a pre_review broker holding a synthetic canary in a test
  item and `kill -SEGV` it. Then confirm that no core file or crash report holds the canary,
  raw or in base64 or hex.

### Owner enrollment

`node packages/vault/dist/broker/main.js enroll <memberId> <spaceId> <ttlSeconds>` prints
a one-time enrollment code on stdout. That code is the root of trust for the owner's
first passkey (an open review item), so:
- hand it over out of band;
- keep the TTL short;
- never paste it into a chat, a task or a log.

### Chat paste guard (`TM8_VAULT_PASTE_GUARD=on`)

Turning it on is a separate owner decision, not part of a flag-off deploy. It is the one
part of this build that works with the vault off: it puts nothing in the vault and holds no
secret. It does change what tm8 stores for every message a person sends, and its limits are
on the review list in §6. Whether to wait for the review is part of that decision.

With the guard on, the server replaces secret-shaped text that a person sends with
`[redacted:<kind>]` before it stores anything:
- `messages.post` and `chat.start`. The sender gets a `vault_paste_redacted` warning that
  names kinds of secret, never values. A post or start that no longer fits once marked is
  refused. When a start's opening message loses a secret, the title sent is dropped and the
  chat takes its default title from the redacted message: a title cut from the message can
  keep a piece of the secret too short to detect.
- `messages.edit`. An edit whose new text holds secret-shaped text is refused
  (`invalid_input`, reason `vault_paste_redacted`), and the message keeps its earlier text.
- A bridged person's message, and their edit at the provider: body, slash-command text and
  media captions. The chat gets one notice per message and one per edit, threaded on the
  stored copy.

It does not read agents' posts, bots, attachments or file names. With `TM8_VAULT_MODE=off`
the warning leaves out the capture-link advice. Detection is best-effort. Plan `01a1fab7` §10
lists what it does not catch, including the legacy WhatsApp bridge's own store.

To verify after the restart, check the boot log for `[tm8] vault paste guard on (vault off)`
(or `(vault on)`). Never post a real secret to test it.

## 6. Open before real secrets (gate items)

The independent review must close these or accept them in writing. The task's review list
on `01a1fa87` holds the full set with severities. The headline items:

**Database and keys**
- A trust-auth or superuser database login bypasses RLS. Production refuses it, but the
  other modes only log it.
- Relay key isolation (review F03). Agent sessions run under the tm8 server's uid, so
  `chmod 600` does not keep the relay's signing key or TLS key from them. The relay now refuses
  `production`, the broker pins the relay's certificate, both sides refuse a retired key, and both
  check their host at start: the relay R1 to R8 when `TM8_VAULT_AGENT_RUN_AS` is set, the broker
  B3 (§5, *Relay key isolation*). Still open:
  - the boundary itself, its reach checks, and the staging cross-member forgery test. The boot
    checks are point-in-time reads of a host's configuration, not proof of the boundary, and R9
    and the periodic re-check are not built;
  - owner decisions D1-D9 (design doc `01a1fe13`);
  - agents can read a `pre_review` relay's keys today. That relay holds test secrets only, and
    its keys must be rotated before any production cutover;
  - a refused certificate is only logged and counted. Nothing alerts on it.
- The KMS REST path (review F05). The broker now wipes the response bytes it owns and the GCM
  output on a failed tag. It cannot wipe V8 strings or undici/OpenSSL buffers. Production
  refuses a host that could write cores or swap. The host checks are not done on a real broker
  host (*Plaintext in broker memory*).

**Browser surface**
- The capture page shares the SPA's origin.
- The SPA has no CSP.
- The SPA still keeps a bearer in `localStorage`, though the vault transport never sends it.

**Owner enrollment and passkeys**
- The enrollment code is the root of trust.
- Attestation is format `none` only.
- The Argon2 cost cap.
- Revoking the last passkey.

**Grants and connectors**
- Connector requests (review F02). A connector policy is stored only for a built-in template
  that has vetted operations. It admits only those operations: the exact method and path, a
  rule for each query parameter, a strict body schema, and an allowlist of agent headers. The
  broker rebuilds the query and the form body it forwards. Both modes refuse GraphQL, JSON-RPC,
  XML-RPC/SOAP and batch requests, and method-override fields in the query, a form, a multipart
  part or top-level JSON. Still open:
  - Generic mode is the weaker mode. It checks the host, method, prefix, the generic deny
    segments and these detectors, but no schema.
    - The UI labels it weaker (brief addendum 5) in three places: the item's API policy, the
      grant form, and each per-use API approval, above Approve.
    - Each per-use API approval binds the mode the policy runs in (`enforcedMode`) and where the
      key goes. So an approval given under one mode never authorizes a request under the other.
    - A stored connector policy whose template lists no vetted operations is bound as generic,
      and the item's API policy shows it as generic too. `vault.policies.set` refuses to store
      one, and a test fails if a built-in template loses its operations.
    - Only a grantee whose grants all require approval per use gets an approval. The owner's own
      sessions and agents get none: their authorization is the owner's step-up
      `vault.policies.set` call that chose generic mode. No UI makes that call, so a policy can
      be set only through the API.
  - The detectors are heuristics. They miss a multiplexer at an unremarkable path in a format
    they do not parse, a document id sent without variables, and query languages over HTTP
    (SQL and kin). In generic mode they also refuse some ordinary requests:
    - a path segment named `batch`, `bulk` or `rpc`;
    - top-level JSON with a string `method` and `params`;
    - JSON with a document id and `variables`;
    - a multipart body with a `name=` of `query`, `operations` and kin anywhere in it.
  - Stripe PaymentIntent reads are not offered. A PaymentIntent carries its `client_secret`, and
    the response filter does not remove it.
  - A new connector needs its own vetted operation list. `catalogProblems` checks the rules'
    form, not the vendor's semantics.
- `startUrl` restriction.
- `devMode` must come from broker config.
- An origin change should require step-up.
- Paste detection, including the chat paste guard's limits (plan `01a1fab7` §10).

**Durability and alerts**
- Audit anchor (review F01). The broker reads its anchor back from the sink, as §5 describes.
  Still open:
  - No test has run against a real retained GCS bucket. This lane has no credentials and adds
    no paid service. The GCS paths are tested against a local HTTP fake that lists, reads and
    refuses like GCS. The rollback is tested against a real `pg_dump` restore, with a real
    file sink and a real broker start.
  - `vault.audit.verify` still reports the database's receipt in its `checkpoint` field,
    because the strict contract has no field for the retained anchor. Its `status` is the
    anchored verdict.
  - Events after the newest anchor are only as trustworthy as the database until the next
    checkpoint covers them. The budget bounds that window for a running broker, and a stopped
    broker anchors them at its next start.
  - A `file` sink is a witness on the same host. Whoever can write its directory can delete
    from it, and a database restore plus a deletion of the newer files goes unseen unless the
    process saw them first. Whether production may use it is an owner decision. So are
    locking the bucket's retention, and the recovery path after a rollback.
- The ledger needs separate media.
- Relay alerts queued in the broker are lost on a broker restart.
- Canaries have no production planting.
- Re-granting the broker role after a 450 rollback.
- `grant.dropped_on_leave` has no trigger.
- Recovery codes have no lifetime.

**Platform**
- RLS does not separate a human from an agent caller.
- Topology B (relay and broker under different uids on one host) is unsupported by the socket directory.
- 450 and 451 are not yet proven on PostgreSQL 17 locally; CI's server jobs run 17.
- The vault UI on a phone is untested.
- The named-server proxy has no vault.
