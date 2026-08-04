# Moved paths

`docs/` was reorganised on **2026-08-02**. Every document moved; many lost a
redundant `TM8-` prefix once its directory carried the same meaning.

References were rewritten repo-wide, with one deliberate exception: the applied
migrations under `db/migrations/` still cite old paths. `db/migrate.mjs` checksums
each applied migration and fails on any edit, so those comments were left alone.
Use this table when you follow one.

## Directories moved wholesale

| Old | New |
|---|---|
| `docs/ui-audit/` | `docs/ui/audit/` |
| `docs/plans/tm8-ui-orchestration/` | `docs/ui/orchestration/` |
| `docs/collab-v2-api-design/` | `docs/history/collab-v2/api-design/` |
| `docs/collab-v2-ui-plan/` | `docs/history/collab-v2/ui-plan/` |
| `docs/crib-supabase/` | `docs/history/collab-v2/crib-supabase/` |
| `docs/ui-snapshot/` | `docs/history/collab-v2/ui-snapshot/` |
| `T0-1 workspace structure review/` | `docs/design-canvases/2026-07-27-round-1/` |
| `T0-1 workspace structure review (1)/` | `docs/design-canvases/2026-07-28-round-2/` |
| `docs/tm8-architecture/` | `docs/architecture/` |
| `docs/graph/` | `docs/features/graph/` |

Contents kept their filenames and internal structure.

## Individual files (88)

| Old | New |
|---|---|
| `docs/plans/TM8-API-CATALOG-GROUPED-GUIDE.md` | `docs/api-and-cli/API-CATALOG-GROUPED-GUIDE.md` |
| `docs/plans/TM8-CLI-GRAMMAR-REDESIGN.md` | `docs/api-and-cli/CLI-GRAMMAR-REDESIGN.md` |
| `docs/plans/TM8-CLI-SESSION-COMMAND-JOURNAL.md` | `docs/api-and-cli/CLI-SESSION-COMMAND-JOURNAL.md` |
| `docs/plans/DOMAIN-ARCHITECTURE-DECISIONS.md` | `docs/architecture/DOMAIN-ARCHITECTURE-DECISIONS.md` |
| `docs/plans/TM8-GRAPH-NATIVE-KERNEL-VARIANT.md` | `docs/architecture/GRAPH-NATIVE-KERNEL-VARIANT.md` |
| `docs/plans/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` | `docs/architecture/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` |
| `docs/plans/WORKSPACE-LAYOUT-REVIEW.md` | `docs/architecture/WORKSPACE-LAYOUT-REVIEW.md` |
| `docs/plans/TM8-CURRENT-BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md` | `docs/chat-and-messaging/BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md` |
| `docs/plans/TM8-CHAT-SURFACE-CHANGESET.md` | `docs/chat-and-messaging/CHAT-SURFACE-CHANGESET.md` |
| `docs/plans/TM8-CHAT-SURFACE-CONTEXT-AND-HANDOFF.md` | `docs/chat-and-messaging/CHAT-SURFACE-CONTEXT-AND-HANDOFF.md` |
| `docs/plans/TM8-CHAT-SYSTEM-DESIGN.md` | `docs/chat-and-messaging/CHAT-SYSTEM-DESIGN.md` |
| `docs/plans/TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` | `docs/chat-and-messaging/CHAT-UI-AND-LAYOUT-DESIGN.md` |
| `tm8-message-loopback-analysis.md` | `docs/chat-and-messaging/MESSAGE-LOOPBACK-ANALYSIS.md` |
| `docs/plans/TM8-NEW-CHAT-UI-IMPLEMENTATION-PLAN.md` | `docs/chat-and-messaging/NEW-CHAT-UI-IMPLEMENTATION-PLAN.md` |
| `docs/plans/TM8-NEW-CHAT-UI-UNRELATED-FAILURE-LEDGER.md` | `docs/chat-and-messaging/NEW-CHAT-UI-UNRELATED-FAILURE-LEDGER.md` |
| `docs/plans/TM8-SESSION-COMMUNICATION-MODEL.md` | `docs/chat-and-messaging/SESSION-COMMUNICATION-MODEL.md` |
| `T0-1 workspace structure review` | `docs/design-canvases/2026-07-27-round-1` |
| `T0-1 workspace structure review (1)` | `docs/design-canvases/2026-07-28-round-2` |
| `docs/plans/TM8-ARTIFACTS-DESIGN.md` | `docs/features/artifacts/ARTIFACTS-DESIGN.md` |
| `docs/plans/briefs/BRIEF-ARTIFACTS.md` | `docs/features/artifacts/BRIEF-ARTIFACTS.md` |
| `docs/plans/briefs/BRIEF-FOUNDATION.md` | `docs/features/foundation/BRIEF-FOUNDATION.md` |
| `docs/plans/TM8-BUILD-ORDER-AND-OWNERSHIP.md` | `docs/features/foundation/BUILD-ORDER-AND-OWNERSHIP.md` |
| `docs/plans/TM8-FOUNDATION-VERIFICATION.md` | `docs/features/foundation/FOUNDATION-VERIFICATION.md` |
| `docs/plans/MEMO-MEMORY-SEAM-QUESTIONS.md` | `docs/features/foundation/MEMO-MEMORY-SEAM-QUESTIONS.md` |
| `docs/plans/MEMO-WORKTREE-SEAM-ANSWERS.md` | `docs/features/foundation/MEMO-WORKTREE-SEAM-ANSWERS.md` |
| `docs/plans/TM8-NEW-ENTITIES-SESSION-DIGEST.md` | `docs/features/foundation/NEW-ENTITIES-SESSION-DIGEST.md` |
| `docs/plans/TM8-DERIVED-EDGES-ANALYSIS.md` | `docs/features/graph/DERIVED-EDGES-ANALYSIS.md` |
| `docs/plans/briefs/BRIEF-MEMORIES.md` | `docs/features/memory/BRIEF-MEMORIES.md` |
| `docs/plans/TM8-MEMORY-AND-STALENESS-DESIGN.md` | `docs/features/memory/MEMORY-AND-STALENESS-DESIGN.md` |
| `docs/plans/TM8-MEMORY-DESIGN-FINAL.md` | `docs/features/memory/MEMORY-DESIGN-FINAL.md` |
| `docs/plans/TM8-MEMORY-STALENESS-API-CLI-DESIGN.md` | `docs/features/memory/MEMORY-STALENESS-API-CLI-DESIGN.md` |
| `docs/plans/TM8-MEMORY-STALENESS-DESIGN-BRIEF.md` | `docs/features/memory/MEMORY-STALENESS-DESIGN-BRIEF.md` |
| `docs/plans/reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md` | `docs/features/memory/MEMORY-STALENESS-DESIGN-REVIEW.md` |
| `docs/resume-feature-plan.md` | `docs/features/resume/SESSION-RESUME-PLAN.md` |
| `docs/plans/TM8-SHARED-WORKSPACE-DESIGN.md` | `docs/features/shared-workspace/SHARED-WORKSPACE-DESIGN.md` |
| `docs/plans/2026-07-31-voice-channels-plan.md` | `docs/features/voice/VOICE-CHANNELS-PLAN.md` |
| `docs/plans/briefs/BRIEF-WORKTREES.md` | `docs/features/worktrees/BRIEF-WORKTREES.md` |
| `docs/plans/TM8-WORKTREE-DESIGN.md` | `docs/features/worktrees/WORKTREE-DESIGN.md` |
| `docs/plans/TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` | `docs/harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` |
| `docs/plans/TM8-AGENT-JOURNEY-WALKTHROUGH.md` | `docs/harness/AGENT-JOURNEY-WALKTHROUGH.md` |
| `docs/plans/TM8-HARNESS-ARCHITECTURE-EXPLAINED.md` | `docs/harness/HARNESS-ARCHITECTURE-EXPLAINED.md` |
| `docs/plans/TM8-HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md` | `docs/harness/HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md` |
| `docs/plans/TM8-PROMPT-REFERENCE.md` | `docs/harness/PROMPT-REFERENCE.md` |
| `docs/plans/TM8-RUNTIME-CONFIG-TEMPLATES-AND-MODEL-TIERS.md` | `docs/harness/RUNTIME-CONFIG-TEMPLATES-AND-MODEL-TIERS.md` |
| `docs/plans/TM8-SESSION-SURFACE-ENGINEER-PROMPT.md` | `docs/harness/SESSION-SURFACE-ENGINEER-PROMPT.md` |
| `docs/plans/reviews/HARNESS-PLAN-CONSENSUS.md` | `docs/harness/reviews/HARNESS-PLAN-CONSENSUS.md` |
| `docs/plans/reviews/HARNESS-PLAN-FINAL-REVIEW-opus-5.md` | `docs/harness/reviews/HARNESS-PLAN-FINAL-REVIEW-opus-5.md` |
| `docs/plans/reviews/HARNESS-REVIEW-haiku-4.5.md` | `docs/harness/reviews/HARNESS-REVIEW-haiku-4.5.md` |
| `docs/plans/reviews/HARNESS-REVIEW-sonnet-5.md` | `docs/harness/reviews/HARNESS-REVIEW-sonnet-5.md` |
| `docs/COLLAB_V2_ENTITY_GRAPH_DESIGN.md` | `docs/history/collab-v2/ENTITY-GRAPH-DESIGN.md` |
| `docs/COLLAB_V2_GAPS_AND_EXTENSIONS.md` | `docs/history/collab-v2/GAPS-AND-EXTENSIONS.md` |
| `docs/COLLAB_V2_UI_DATA_CONTRACT.md` | `docs/history/collab-v2/UI-DATA-CONTRACT.md` |
| `docs/collab-v2-api-design` | `docs/history/collab-v2/api-design` |
| `docs/crib-supabase` | `docs/history/collab-v2/crib-supabase` |
| `docs/collab-v2-ui-plan` | `docs/history/collab-v2/ui-plan` |
| `docs/ui-snapshot` | `docs/history/collab-v2/ui-snapshot` |
| `docs/plans/TM8-FINAL-DESIGN-SET-REVIEW.md` | `docs/history/program-w0-w5/FINAL-DESIGN-SET-REVIEW.md` |
| `docs/plans/TM8-FINAL-DESIGN-SET.md` | `docs/history/program-w0-w5/FINAL-DESIGN-SET.md` |
| `docs/plans/TM8-IMPLEMENTATION-ORCHESTRATION-W0-W5.md` | `docs/history/program-w0-w5/IMPLEMENTATION-ORCHESTRATION-W0-W5.md` |
| `docs/plans/TM8-PROGRAM-CLOSE.md` | `docs/history/program-w0-w5/PROGRAM-CLOSE.md` |
| `docs/plans/TM8-W0-AMENDMENT-DOSSIER.md` | `docs/history/program-w0-w5/W0-AMENDMENT-DOSSIER.md` |
| `docs/plans/TM8-W0-CONSISTENCY-MATRICES.md` | `docs/history/program-w0-w5/W0-CONSISTENCY-MATRICES.md` |
| `docs/plans/TM8-W0-G0.1-AMENDMENT-REPORT.md` | `docs/history/program-w0-w5/W0-G0.1-AMENDMENT-REPORT.md` |
| `docs/plans/TM8-W0-GATE-REPORT.md` | `docs/history/program-w0-w5/W0-GATE-REPORT.md` |
| `docs/plans/TM8-W0-W5-HANDOFF-STATE.md` | `docs/history/program-w0-w5/W0-W5-HANDOFF-STATE.md` |
| `docs/plans/TM8-W1-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md` | `docs/history/program-w0-w5/W1-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md` |
| `docs/plans/W2-DECOMPOSITION.md` | `docs/history/program-w0-w5/W2-DECOMPOSITION.md` |
| `docs/plans/TM8-W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md` | `docs/history/program-w0-w5/W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md` |
| `docs/plans/TM8-SEC1-STAGE2-ENUMERATION.md` | `docs/history/program-w0-w5/W2-SEC1-STAGE2-ENUMERATION.md` |
| `docs/plans/TM8-W3-PUBLIC-AND-AGENTIC-EVIDENCE.md` | `docs/history/program-w0-w5/W3-PUBLIC-AND-AGENTIC-EVIDENCE.md` |
| `docs/plans/TM8-W4-CLI-HANDOFF.md` | `docs/history/program-w0-w5/W4-CLI-HANDOFF.md` |
| `docs/plans/TM8-W4-CLI-IMPLEMENTATION-EVIDENCE.md` | `docs/history/program-w0-w5/W4-CLI-IMPLEMENTATION-EVIDENCE.md` |
| `docs/plans/TM8-W5-COORDINATOR-STANDING-ORDERS.md` | `docs/history/program-w0-w5/W5-COORDINATOR-STANDING-ORDERS.md` |
| `docs/plans/TM8-W5-DUO-STRUCTURE.md` | `docs/history/program-w0-w5/W5-DUO-STRUCTURE.md` |
| `docs/plans/TM8-AUTH-AND-IDENTITY-VERIFIED-STATE.md` | `docs/identity/AUTH-AND-IDENTITY-VERIFIED-STATE.md` |
| `docs/plans/TM8-IDENTITY-DESIGN-BRIEF.md` | `docs/identity/IDENTITY-DESIGN-BRIEF.md` |
| `docs/plans/TM8-IDENTITY-DESIGN.md` | `docs/identity/IDENTITY-DESIGN.md` |
| `docs/plans/TM8-IDENTITY-OPEN-THREADS.md` | `docs/identity/IDENTITY-OPEN-THREADS.md` |
| `docs/plans/PHASE-2-REMOTE-SERVER-INTEGRATION.md` | `docs/remote/PHASE-2-REMOTE-SERVER-INTEGRATION.md` |
| `docs/plans/TM8-REMOTE-DEEP-REPORT-A.md` | `docs/remote/REMOTE-DEEP-REPORT-A.md` |
| `docs/plans/TM8-REMOTE-DEEP-REPORT-B.md` | `docs/remote/REMOTE-DEEP-REPORT-B.md` |
| `docs/plans/TM8-REMOTE-END-TO-END-DESIGN.md` | `docs/remote/REMOTE-END-TO-END-DESIGN.md` |
| `docs/plans/TM8-REMOTE-STATUS-2026-07-29.md` | `docs/remote/REMOTE-STATUS-2026-07-29.md` |
| `docs/plans/TM8-UI-IMPLEMENTATION-PLAN.md` | `docs/ui/UI-IMPLEMENTATION-PLAN.md` |
| `docs/plans/TM8-UI-SPEC-FINAL.md` | `docs/ui/UI-SPEC-FINAL.md` |
| `docs/plans/TM8-WORKSPACE-LOAD-PERFORMANCE.md` | `docs/ui/WORKSPACE-LOAD-PERFORMANCE.md` |
| `docs/ui-audit` | `docs/ui/audit` |
| `docs/plans/tm8-ui-orchestration` | `docs/ui/orchestration` |

## Gone entirely

- `docs/plans/` — dissolved. Its 66 documents are distributed across
  `architecture/`, `api-and-cli/`, `harness/`, `chat-and-messaging/`, `ui/`,
  `identity/`, `remote/`, `features/` and `history/`.
- `docs/plans/briefs/` — each `BRIEF-*.md` now sits in its own feature directory.
- `docs/plans/reviews/` — harness reviews to `harness/reviews/`; the memory review
  to `features/memory/`.
