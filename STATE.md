# tm8 STATE

**Updated:** 2026-07-25 (W0 in progress)
**CTO/coordinator:** Vega (sess_1784943069601_y42xw5b9m). Only Vega commits.
**Maestro project:** proj_1784943131214_fkap03n0m (workingDir: this repo).
**Execution bible:** docs/tm8-architecture/09-IMPLEMENTATION-PLAN.md. Architecture FINAL (00-08). Do not relitigate.

## Amendments (user-directed, override the docs)

- **AM-1 (2026-07-25): No Tauri. tm8 is server + web only.**
  - `apps/desktop` does not exist and will not be built. `packages/ui` is a browser app; Vite dev on 4611; production bundle served by tm8-server (4610).
  - The ONLY spawn path is the server-side PTY host (old maestro's `MAESTRO_PTY_HOST=server` mode becomes the primary path, not a variant). The `session:spawn` payload shape (session, command, cwd, envVars, manifest path, ids, provenance) is preserved verbatim on the server path (R29).
  - Terminals: xterm in browser — WebGL renderer on Chromium with DOM fallback; NO WebGL/Canvas addon assumptions beyond that; unmount terminals of exited sessions; bounded log-strip memory. Terminal perf parity with old maestro is the regression bar (G3).
  - M2/M3 items mentioning Tauri/apps/desktop are re-scoped to: web boot flow (browser → tm8-server auth auto-owner → workspace UI) and server-side spawn plumbing.
  - AM-1 is now canonical in the master corpus as **T-D21** (05-DECISIONS.md) + status amendment on 09; both re-vendored here 2026-07-25. Draco's persona updated design-side (lift scope = PTY host + terminal components only).
  - Design-session nuances to carry: (a) the G3 perf-parity bar is measured against old maestro's **desktop** terminal on the same machine — web-only rendering inherits old maestro's WebGL-on-Chromium web path, so parity is achievable but must be **measured explicitly, never assumed** (Polaris owns the measurement at W5); (b) with "install the app" gone, the **one-command start story** (tm8-server starts sidecar PG, serves/points to UI; `bun run dev` for dev + a single launcher for prod) is a W0/W1 deliverable — startup UX is part of the definition of done, owned by Altair's sidecar/ops workstream at W1.

## Wave status

| Wave | Status | Notes |
|---|---|---|
| W0 (M0 scaffold + contract + conformance) | **IN PROGRESS** | Repo created, corpus vendored (tm8-architecture 00-09 + COMBINED, collab-v2-api-design 00-05, UI data contract, entity-graph design, gaps doc), workspace scaffolded (contract/server/execution/cli/ui, db/migrations, tools/conformance). Contract package + conformance harness authoring underway. |
| W1 (db+RPC+RLS · identity · sidecar+scheduler) | not started | |
| W2 (facade+derived truth · events+WS · conformance completion) | not started | Gate G1 = M1 |
| W3 (UI transplant + RealFacade · web boot) | not started | waits on Atlas's collab-v2-ui W5 (T-D18) |
| W4 (execution lifts · SpawnService+execution.* · CLI+adapter) | not started | |
| W5 (spell port, transcript, acceptance, perf parity) | not started | Gate G3 = Phase 1 done |

## Gates

- G0: not yet — needs contract package building + conformance harness running red against stub server.
- G1/G2/G3: pending.

## Ground rules (law)

- Workers/leads NEVER run git. Vega reviews diffs and commits per verified wave.
- Package-disjoint ownership per 09 §1. Cross-boundary needs route through Vega.
- Scoped `tsc -b`/`vitest` only; never parallel vite builds.
- `packages/server` + `packages/execution` run under node, never bun (node-pty).
- Ports 4610 (server) / 4611 (UI dev) / 5442 (sidecar PG); data ~/.tm8 (dev ~/.tm8-dev).
- Polaris independently verifies from W2 onward; a claim Polaris did not reproduce is not green.

## Team (expanded 2026-07-25 — seven sub-teams under tm8 Org)

- Rigel (Platform lead): contract + db/RPC + identity/RLS — workers Cygnus (db/RPC), Lyra (identity/RLS).
- Altair (Server lead): facade + events + sidecar lifecycle code + scheduler — workers Deneb, Sirius, Castor.
- Orion (Execution lead): PTY lifts + SpawnService + CLI — workers Draco (lift scope per T-D21: PTY host + terminal components only, no Tauri), Phoenix.
- Atlas (UI lead): existing Collab V2 UI team; joins at W3 (M2) after their mock build completes.
- **Ops — Argo (lead) + Vela (CI/packaging): one-command start story, CI-as-merge-gate (conformance suite), env isolation, release packaging incl sidecar distribution (R15).** Supersedes the earlier note assigning one-command start to Altair — sidecar *lifecycle code* stays Altair/Castor; start story/packaging/CI = Argo. Active from W0.
- **Quality — Polaris (lead; audits only, writes no product code, reports only to Vega) + Lynx (builds test machinery: conformance plumbing post-G0 handoff, golden-workflow rigs, execution.prompt PTY round-trip rig, SpawnService parity fixtures, perf rigs).** Active from W0.
- **Gateway — Cepheus (lead) + Pavo + Volans: DORMANT until G3 (Phase 2 owners; do not spawn in Phase 1).**

Ownership boundary during W0: Rigel owns tools/conformance until G0; Lynx works in tools/rigs/ only, takes conformance extension post-G0.
