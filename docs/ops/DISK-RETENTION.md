# Disk retention and the disk alert

On 2026-10-20 the root disk of the tm8 host reached 97%. Postgres lives on that disk. A one-off
cleanup freed 6 GB. This document describes the rules that make the next cleanup unnecessary,
and the checks that only root can do.

The rules run as the `ops.disk-guard` scheduler job (`packages/server/src/scheduler/jobs/disk-guard.ts`),
every 30 minutes and once at boot. The decisions are pure functions in
`packages/server/src/ops/disk-retention.ts`, and the I/O is in `ops/disk-inventory.ts`.

## What grows, and the rule for each

Measured on the host on 2026-10-20, at 93% used (after the cleanup):

| What | Size | Rule |
|---|---|---|
| `<dataDir>/scratch/<sessionId>/` (sessions' own checkouts, clones, `node_modules`, logs) | 63 GB | Once the session has **exited/failed for 6h**: each checkout that is clean with every commit on a remote is removed through `git worktree remove`. Ignored `node_modules`/`dist`/`.vite`/`coverage`/`.turbo` are removed. When nothing unique is left, the dir goes. Loose files (logs, notes) are kept for 30 days after the session. |
| `<dataDir>/worktrees/<project>/<id>` and ad-hoc `<dataDir>/worktrees/<name>` | 55 GB | Same checkout rule, with the session found by `work_sessions.workdir_path`. The allocation row becomes `missing` at the next reconciliation. The worktree entity's status is never touched. |
| `/opt/tm8/candidates/` | 4.6 GB | DB dumps (`*.dump`, `*.sql`, ...) are removed after **3 days**, because a candidate dir is never the backup of record. Other candidates: the newest 4 are kept, older ones go after 3 days. |
| `/opt/tm8/prod-prev.*` | 6 GB in 7 builds | Keep the newest 2 (`staging-prev.*`: 1; `*-failed.*`: 1). |
| `/opt/tm8/ui-candidate-*` | 1.4 GB | Keep the newest 2. |
| `/opt/tm8/rollbacks/*`, `ui-rollbacks/*` | 1 GB | Keep the newest 2, once 7 days old. |
| `/opt/tm8/deploy-backups/*.dump` | 0.9 GB | Keep the newest 3. `tm8-ui-dist*` copies: newest 2. |
| `~/backups/*.dump` | 0.15 GB | Keep the newest 5. |
| `/tmp/<21-char id>/{client,ssr}` (Vitest 4 module dumps from killed runs, 35–90 MB each, ~600 of them) | 1.5 GB after cleanup | Removed after 6h. **At the source:** spawned sessions now get `TMPDIR=<dataDir>/tmp`, so new dumps land in the managed dir. |
| `<dataDir>/tmp/*` (the managed session TMPDIR) | new | Removed after 2 days untouched. |
| `/tmp/tm8-smoke-*` | small | Removed after 2 days. |
| `/tmp/node-compile-cache` | 0.5 GB | Wiped when over 1 GiB. |
| `~/.npm/_cacache`, `~/.cache/pnpm` | 0.8 GB, 0.4 GB | Wiped when over 1 GiB each. |
| `~/.bun/install/cache` | 0.8 GB | Wiped when over 4 GiB. Installed `node_modules` are hardlinks and survive the wipe. |
| `<dataDir>/blobs` | 3.8 GB | Not this job's: uploads are swept by `files.upload-slot-sweep` / `files.deleted-blob-purge`. |
| `<dataDir>/chat-threads`, `<dataDir>/journals` | 0.9 GB, 0.7 GB | **No rule yet.** These are session evidence. Proposal: archive (compress) after 30 days and remove after 180, but only with the owner's ruling. |
| `~/.cache/pi-models`, `ms-playwright`, `puppeteer`, `huggingface` | 2.2, 0.9, 0.7, 0.5 GB | Not wiped. They are tools, not caches: a wipe forces a re-download in the middle of someone's run. Listed here so growth is visible. |

### What the job never does

- It never deletes work that exists nowhere else. A checkout that is dirty, has commits on no remote, has no
  remote, or cannot be probed is **flagged**. That means it is kept, logged, listed in the job status, and sent
  to the owner once.
- It never deletes a path that is, or contains, the cwd of a running process.
- It never treats an unknown session as ended. A checkout whose session cannot be read must be idle for
  7 days before the clean-and-pushed test is even applied.
- It never deletes what a `LAST_*` or `*_TREE` pointer file names.
- It never takes git's index lock (`GIT_OPTIONAL_LOCKS=0`). Removal is `git worktree remove` without
  `--force`, so a tree that turned dirty after the plan is refused at the last moment.

## The alert

The job reads the data dir's volume through `statfs`. At **85%** it alerts the owner (`warn`), and at **92%**
the alert is `critical`. It re-alerts every 6h while the level stays up, alerts at once when the level rises,
and alerts again on recovery. The node has no channel of its own to the owner, so delivery is a command:

```
TM8_DISK_ALERT_COMMAND='tm8 message send --to <owner chat id> "$TM8_ALERT_TEXT"'
```

The command can be anything that reaches a human: a tm8 message, the WhatsApp bridge's `/say`, or a pager.
Without it the alert is logged only. The desktop status strip shows disk usage either way
(`node.metrics.get`).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `TM8_DISK_GUARD` | `apply` on `TM8_ENV=prod`, `report` elsewhere | `report` lists what `apply` would remove, in the job status (`wouldDelete`). |
| `TM8_DISK_GUARD_SHARED` | `1` on prod | Only one server per machine should sweep `/tmp`, the home caches and the deploy root. Staging and private sweep only their own data dir. |
| `TM8_DISK_ALERT_PCT` / `TM8_DISK_CRITICAL_PCT` | 85 / 92 | |
| `TM8_DISK_ALERT_COMMAND` | unset | See above. |
| `TM8_DEPLOY_ROOT` | parent of the server cwd when that cwd is `prod`/`staging`/`private` | |
| `TM8_SESSION_TMPDIR` | `<dataDir>/tmp` | `off` lets sessions inherit the server's TMPDIR. |

To see what the job would do before switching it on, set `TM8_DISK_GUARD=report` and read
`scheduler.jobs[ops.disk-guard].lastOutcome.detail.wouldDelete` in `/health`.

## Root-only checks

The server runs as `tm8` and cannot read or bound the following. Root needs to check each one. Don't guess
at them:

1. **Postgres data dir size and growth**: `du -sh /var/lib/postgresql/*/*` and
   `select pg_size_pretty(pg_database_size(datname)), datname from pg_database order by 1 desc`.
   Look for scratch test databases on the 5443 cluster (`node scripts/pg-scratch-gc.mjs` lists them).
2. **WAL and archive**: `du -sh /var/lib/postgresql/*/*/pg_wal`. Check `archive_mode`, `archive_command`,
   `wal_keep_size`/`max_slot_wal_keep_size`, and inactive replication slots
   (`select slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) from pg_replication_slots`).
   An inactive slot pins WAL forever.
3. **Postgres logs**: `du -sh /var/log/postgresql`, and confirm logrotate covers them.
4. **systemd journal**: `journalctl --disk-usage`. Set `SystemMaxUse=` in `/etc/systemd/journald.conf`
   (e.g. 1G) if it is unbounded.
5. **`/opt/tm8/backups`**: unreadable to `tm8`. Check its size and what rotates it.
6. **`/var/log`, `/var/cache/apt`, `/var/lib/docker`** (if present): `du -xsh /var/*`, `apt-get clean`,
   `docker system df`.
7. **Units**: the slot units are rendered by `install.sh --systemd`. To deliver alerts, add
   `TM8_DISK_ALERT_COMMAND` to the prod unit's environment.
8. **Free-space reserve**: `tune2fs -l /dev/vda1 | grep 'Reserved block count'`. The 5% root reserve is what
   keeps Postgres able to write at "100%" for a non-root user.
