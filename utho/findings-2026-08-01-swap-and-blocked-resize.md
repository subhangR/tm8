# Swap added; instance resize blocked by Utho account state

**Date:** 2026-08-01 · **Instance:** `tm8-server` / cloudid `1670787` · **Outcome:** swap shipped, resize
blocked upstream, no data lost

## Summary

The task was to relieve memory pressure by resizing `1670787` from plan 10315 (4 CPU / 8 GB) to
10316 (6 CPU / 16 GB). **Swap was added successfully and removed the OOM cliff with no downtime.
The resize itself could not be completed — Utho accepts the request, returns `success`, and never
applies it.**

Two power cycles were performed. Row counts across both Postgres clusters were **identical before
and after** (132 tables, 1098 rows).

## The resize does not work, and reports success

`POST /v2/cloud/1670787/resize` with `{"type":"cloud","plan":"10316"}` returns:

```json
{"status":"success","message":"Cloud Resize request sent!"}
```

It was attempted twice and applied neither time. Specs stayed 4 CPU / 8192 MB / cost 3594,
confirmed both from `GET /v2/cloud/1670787` and from inside the guest (`nproc`, `free -h`).

| Attempt | Instance state when sent | What Utho did | Specs after |
|---|---|---|---|
| 1 | `Shutdown` | powered it **on** | unchanged |
| 2 | `Running` | powered it **off** | unchanged |

So Utho *does* begin the resize workflow — it toggles power — then aborts silently. Immediately
after attempt 2, `poweron` returned:

```json
{"status":"error","message":"A task is already in process, Please wait for complete the same or contact support."}
```

The stuck task cleared on its own after a few minutes and the VM powered back up unaided.

### Suspected cause — account gating, not a technical fault

`GET /v2/account/info` reports:

| Field | Value |
|---|---|
| `credit` / `availablecredit` / `balance` | `2853.53` INR |
| `kyc` | `0` |
| `verify` | `0` |
| `email_verified` | `0` |
| `cloudlimit` | `10` |

Target plan 10316 costs **5514 INR/month**; available credit is **below one month of it**, and the
account is unverified. This is correlation, not proof — **no Utho endpoint surfaces a reason.**
This is the same failure shape as the Mumbai incident: reads all claim health, the real constraint
is invisible.

**To unblock:** top up credit and/or complete KYC in the dashboard, then re-issue the resize.

## `resizeplans` contradicts `/v2/plans` on disk size

`GET /v2/cloud/{id}/resizeplans` is instance-specific and more authoritative than `/v2/plans`.
All 20 resize targets report **`disk: "160"`** — including 10316, which `/v2/plans` lists as 320 GB.

The likely reading: **a resize preserves the existing disk; only a fresh deploy gets the plan's
disk size.** If true, the "disk grows and cannot shrink, so resize is one-way" concern does not
apply to resize. **Unverified** — no resize ever completed.

Note the two endpoints also use **different currencies**: `/v2/plans` `price` is USD (`64.46`),
`resizeplans` `price` is INR (`5514`). Current plan is 3594 INR ≈ $42.01.

### A cheaper plan meets a 16 GB requirement

| Plan | CPU | RAM | INR/mo | vs current (3594) |
|---|---|---|---|---|
| 10315 (current) | 4 | 8192 | 3594 | — |
| **10325** | 2 | 16384 | **3420** | **−174 (cheaper)** |
| 10316 (target) | 6 | 16384 | 5514 | +1920 |

`10325` satisfies "16 GB required" for *less than the current bill*, trading CPU 4 → 2. It may also
succeed where 10316 is blocked, since it costs less than the available credit.

## `bandwidth_used` is NOT a reliable health check

`utho/api-notes.md` and the Mumbai writeup recommend `bandwidth_used == 0` as the cheap test for
"this VM never networked". **On this instance that field reads `0` while the VM is fully networked.**

Measured on a healthy box with 7h28m uptime, serving traffic over both eth0 and the tailnet:

```
eth0:  3613863120 bytes received   2633395347 bytes transmitted
API:   "bandwidth_used": 0
```

The Mumbai diagnosis was still correct, but `bandwidth_used == 0` **does not imply** no networking —
it produces false positives. Use in-guest `/proc/net/dev` counters instead.

## Latent bug found: nginx loses a boot race with tailscaled

**This predates the resize work and would have hit the next reboot for any reason.** The tailnet
migration happened 2026-08-01 and the box had not been rebooted since, so it was never exercised.

nginx binds **only** the tailnet address `100.112.76.32`. That address does not exist until
tailscaled is up. On the first reboot:

```
nginx: [emerg] bind() to 100.112.76.32:9999 failed (99: Cannot assign requested address)
nginx.service: Failed with result 'exit-code'
```

nginx is the entire external perimeter, so **tm8 was unreachable from the tailnet** until it was
restarted by hand. Every other unit came back fine, which makes this easy to miss.

### Fix applied

`/usr/local/sbin/wait-for-tailscale-ip` blocks until the address is actually assigned, wired in via
`/etc/systemd/system/nginx.service.d/10-wait-for-tailscale.conf`:

```ini
[Unit]
After=tailscaled.service network-online.target
Wants=network-online.target

[Service]
ExecStartPre=
ExecStartPre=/usr/local/sbin/wait-for-tailscale-ip 100.112.76.32
ExecStartPre=/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'
Restart=on-failure
RestartSec=5s
```

The empty `ExecStartPre=` clears the packaged `nginx -t` so the wait runs *before* it — the config
test is what failed originally.

**Verified on a subsequent real reboot:** `wait-for-tailscale-ip: 100.112.76.32 present after 3s`,
nginx `active`.

## Swap — the change that actually addressed the problem

Memory was the constraint, not CPU. Load stayed between 0.09 and 1.24 on 4 vCPU throughout, while
memory sat at 6.2 GiB of 7.8 GiB with **zero swap** — so pressure meant OOM kills, not slowdown.

```bash
fallocate -l 8G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
```

`swappiness=10` keeps swap as a safety net rather than a routine path. The fstab entry was verified
by cycling `swapoff` / `swapon -a` rather than trusting the written line, and has since survived two
real reboots.

This required no poweroff, no resize, and carried no data risk — and on the evidence it was the
larger share of the win. **16 GB with zero swap still OOM-kills, just later.**

> A low `free -h` reading right after a reboot is misleading here: the ~15 agent sessions that
> consumed the memory die with the box and have not yet reconnected. Pressure returns as they do.

## Also fixed

`/etc/hosts` had no `127.0.1.1 tm8-server` entry, so every `sudo` emitted
`unable to resolve host tm8-server`.

## Data-loss proof

Backups (`/root/preupgrade-backup-20260801T192551Z`, also copied off-box and sha256-verified after
transfer): `pg_dump -Fc` of both clusters, `pg_dumpall --globals-only`, and tars of
`/home/maestro/.maestro`, `/etc/tm8`, `/etc/maestro`, `/etc/nginx`.

**The restore was proven, not assumed** — `tm8_prod.dump` restored into a scratch database:
`pg_restore` exit 0, zero stderr, 66/66 tables and 901/901 rows matching live. Scratch DB dropped
after.

Both clusters were stopped cleanly before each poweroff (`database system is shut down`, 0 dirty
buffers), so no crash recovery was needed. Note `systemctl stop postgresql` is a **no-op** — that
meta-unit does not stop the clusters. The real units are `postgresql@16-prod` /
`postgresql@16-staging`.

Row counts were identical before and after: **132 tables, 1098 rows.**

`utho/backups/` was **not** gitignored. Dumps carry full prod data and role password hashes;
`backups/`, `*.dump`, and `globals-*.sql` were added to `utho/.gitignore`.

## Credentials

The Utho API token was used throughout this work. It remains **compromised and unrotated**, and
grants full account control. See [CREDENTIALS.md](CREDENTIALS.md).

`GET /v2/cloud/1670787` currently returns `consolepassword: PRQNf` — a **different value** from the
one recorded in `CREDENTIALS.md`, so console passwords rotate on their own and that file is already
stale. Rotating the API token remains the highest-severity open item, ahead of the upgrade.

## Not verified

- The cause of the resize refusal (credit/KYC is inference; no endpoint states it).
- Whether disk stays 160 GB after a *successful* resize.
- Whether 10315 becomes available in `resizeplans` again after moving off it.
- Whether 16 GB is sufficient headroom — no load test was run.
