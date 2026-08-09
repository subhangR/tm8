# 5 — Sandboxing: what this node can actually do

> Design document, exported from the tm8 graph at entity `019fdc8d-56c4-78a3-b853-3d233482892a` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 5 — Sandboxing — what this node can actually do

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

### 3.5 Layer 4 — Sandboxing: what is actually available here

Measured on tm8-server:

| capability | state |
|---|---|
| `bwrap`, `docker`, `podman`, `firejail` | **absent** |
| `unshare`, `nsenter`, `setpriv`, `runuser`, `systemd-run` | present |
| `kernel.unprivileged_userns_clone` | `1` |
| `kernel.apparmor_restrict_unprivileged_userns` | **`1` — unprivileged user namespaces blocked** |
| passwordless sudo for `tm8` | **no** (`sudo: a password is required`) |
| server OS user | single uid `110(tm8)`; `tm8priv` exists as a *separate whole server* |

Honest tiering:

- **T0 — env + per-identity `HOME`, one OS uid (recommended now).**
  Delivers per-user credentials, per-user rate limits, per-user GitHub attribution, and a real
  audit trail. **It is not a security boundary:** every session runs as uid 110, so any agent can
  `cat <dataDir>/homes/<other-identity>/claude/.credentials.json`. 0700 protects against *other
  UNIX users on the box*, exactly as commit `fab65c2` does for scratch dirs, and against nothing
  else. This must be stated in the UI copy in the same voice S12 uses for project trust
  (*"v1 does not sandbox — trust is informed consent"*). Anything else is a lie told by a
  padlock icon.

- **T1 — per-identity OS user (`runuser`/`setpriv` per session).** The first real boundary.
  Needs the server to hold `CAP_SETUID`/`CAP_SETGID` or a small audited setuid helper, plus user
  provisioning, plus a group/ACL answer for the shared `projects.working_dir` (C4). `systemd-run
  --uid` exists on this box but needs the same privilege.

- **T2 — container/microVM per session.** Phase 2 / hosted. Not reachable here: no container
  runtime, and AppArmor blocks the unprivileged-userns route that would otherwise allow
  rootless bwrap. (This is the same wall that already breaks Codex's own sandbox on this kernel.)

**Design consequence:** put session launch behind a `SessionLauncher` port —
`launch({command, cwd, env, uid?})` — with `DirectPtyLauncher` (T0) as the only implementation.
T1 then becomes a second implementation, and neither `composeEnv` nor `SpawnService` changes.
Do this in the same change as T0 or it never happens.
