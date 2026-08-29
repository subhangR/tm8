# tm8 documentation

Every document lives under one of the ten sections below. Each section has its own
`README.md` that says what is in it and which file is the one to read first.

**New here, with tm8 running and no idea what to do?** Start at
[`GETTING-STARTED.md`](GETTING-STARTED.md) — the first hour, end to end. Nothing
below is a substitute for it; this map is written for people building tm8, not
using it.

**If you are building tm8, read one thing:** `architecture/01-LAWS.md`. Everything else is downstream of it.

| Section | What lives here | Start with |
|---|---|---|
| [`architecture/`](architecture/) | What tm8 is, the laws it obeys, the domain vocabulary, the decision log | [`01-LAWS.md`](architecture/01-LAWS.md) |
| [`api-and-cli/`](api-and-cli/) | The operation catalog and the CLI grammar built on it | [`API-CATALOG-GROUPED-GUIDE.md`](api-and-cli/API-CATALOG-GROUPED-GUIDE.md) |
| [`harness/`](harness/) | How an agent session is composed, prompted and discovers commands | [`HARNESS-ARCHITECTURE-EXPLAINED.md`](harness/HARNESS-ARCHITECTURE-EXPLAINED.md) |
| [`chat-and-messaging/`](chat-and-messaging/) | Messages, channels, the chat surface, session↔session communication | [`CHAT-SYSTEM-DESIGN.md`](chat-and-messaging/CHAT-SYSTEM-DESIGN.md) |
| [`ui/`](ui/) | The UI spec, the gap audit, and the build orchestration behind `packages/tm8_ui_2.0` | [`UI-SPEC-FINAL.md`](ui/UI-SPEC-FINAL.md) |
| [`identity/`](identity/) | Who is acting, everywhere — auth, actors, agent identity | [`IDENTITY-DESIGN.md`](identity/IDENTITY-DESIGN.md) |
| [`remote/`](remote/) | Phase 2: reaching a tm8 node that is not on this machine | [`REMOTE-END-TO-END-DESIGN.md`](remote/REMOTE-END-TO-END-DESIGN.md) |
| [`features/`](features/) | One directory per shipped or designed feature | [`features/README.md`](features/) |
| [`ops/`](ops/) | Running it: config, environments, the Postgres sidecar, runbooks | [`CONFIG.md`](ops/CONFIG.md) |
| [`history/`](history/) | Closed programs and the inherited Collab V2 design. Record, not law | [`history/README.md`](history/) |
| [`design-canvases/`](design-canvases/) | Frozen design-tool exports, two rounds. Read-only | — |

## The two documents that are not in here

Both sit at the repo root because tooling and habit expect them there:

- **`../README.md`** — the workspace layout, ports, and the hard rules.
- **`../HOW-TO-TEST.md`** — a contributor's hand-test of the G1A loop against a
  reset database. **Not a user manual** — for that, see
  [`GETTING-STARTED.md`](GETTING-STARTED.md). Parts of it have gone stale
  (it says 80 operations / 28 implemented; the node now mounts 165 and
  implements 163), so verify its figures before quoting them.
- **`../STATE.md`** — the Phase-1 delivery record and amendment ledger.
  **Treat it as historical.** It reads authoritative and is not; several of its
  figures were already stale at the time of the last program close. Verify any
  claim in it against the tree before acting on it.

## Conventions

- A section directory holds documents; a sub-directory holds a *sub-topic*
  (`harness/reviews/`, `ui/audit/`, `features/memory/`).
- Numbered files (`00-`, `01-`, …) are a reading order. Unnumbered files are
  standalone.
- A file whose name ends `-REVIEW`, `-EVIDENCE`, `-VERIFICATION` or `-LEDGER` is a
  record of what was checked, not a design. It is only as fresh as its date.
- Nothing here overrides `packages/contract`. When a document and the contract
  disagree, **the contract wins and the document is a proposal.**

## Paths moved

Every document was reorganised on 2026-08-02. Old paths appear in commit messages,
tm8 entities, and inside the applied migrations under `db/migrations/` — those
migrations are checksum-immutable and were deliberately left unedited.
[`MOVED-PATHS.md`](MOVED-PATHS.md) maps every old path to its new one.
