# Ops

Running tm8: configuring it, starting it, and the runbooks for the parts that bite.

| Document | What it is |
|---|---|
| [`CONFIG.md`](CONFIG.md) | **Start here.** Configuration, environments, and how to start it. Cited directly by `scripts/start.mjs`, `scripts/dev.mjs` and the sidecar source |
| [`ENVIRONMENTS.md`](ENVIRONMENTS.md) | **PROD and STAGING are two different tm8's.** Read before pointing any CLI anywhere |
| [`SIDECAR-PACKAGING.md`](SIDECAR-PACKAGING.md) | The Postgres sidecar: packaging and lifecycle. The major version here is pinned against CI |
| [`MESSAGE-DELIVERY-LATENCY.md`](MESSAGE-DELIVERY-LATENCY.md) | Why a message to a running agent takes ~60s to land, and how to tell delivered from lost |
| [`VOICE-CHANNELS.md`](VOICE-CHANNELS.md) | Voice channels — fresh checkout to two tabs talking |
| [`VOICE-VERIFICATION-2026-07-31.md`](VOICE-VERIFICATION-2026-07-31.md) | What was actually verified, and what was not |
| `livekit-dev.yaml` | LiveKit dev config used by the voice runbook |

## The distinction that matters most

`ENVIRONMENTS.md` is not background reading. The CLI's default target and the
server you are editing are not the same machine, and a command that looks local
can act on production.

## Migrations are immutable once applied

`db/migrate.mjs` records a sha256 of each migration body and **fails** if a file
that has already been applied has changed — including its comments. Add a new
file; never edit an applied one.

## Related

- Deploy procedure for the hosted node: `../../deploy/`.
- Host-level notes for the production box live in `../../utho/`, which is
  deliberately untracked because it contains credentials.
