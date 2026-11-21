# Platform improvements workflow registry

Task 01a1fa88-979a-7667-a9de-d4ef6ff744e8 · 2026-11-20

Ask Jev completed before launch. No review gate was waived. Secure Vault is an
independent workstream; its separate security review remains in force.

## By workflow

| Workflow | Specification | Status | Trigger | Actor |
|---|---|---|---|---|
| Task access visibility | [Task access](platform-task-access.md) | Approved | Open task Access | Viewer |
| Short conversation titles | [Short titles](platform-short-titles.md) | Approved | Create chat or work session | Launcher |
| Attention triage | [Attention](platform-attention-triage.md) | Approved | Open Needs you | Viewer |
| Resilient uploads | [Uploads](platform-resilient-uploads.md) | Approved | Upload file or publish artifact | Person/agent |

## By component

| Components | Workflow |
|---|---|
| `task-access/`, panel hosts, `facade/launch-access.ts`, SessionLaunchRecord | Task access |
| `contract/intent-title.ts`, chat start, spawn manifest, launch composers | Short titles |
| `attention/`, pending reader, shared inbox and rail | Attention triage |
| `contract/upload-recovery.ts`, UI upload task, CLI file/artifact, raw PUT route | Resilient uploads |

## By journey

| Journey | Workflow |
|---|---|
| See repositories, recorded run posture and current readable account metadata | Task access |
| Find a conversation using a short label while retaining the entire prompt | Short titles |
| Choose the highest priority human action and inspect FYI separately | Attention triage |
| Finish delivery after a transient failure without duplicating work | Resilient uploads |

## By state

| Observable states | Workflow |
|---|---|
| Loading, ready, incomplete, stale, unavailable | Task access |
| Generated label, explicit name, empty-intent fallback | Short titles |
| Loading, action needed, FYI, seen, resolved, load error | Attention triage |
| Preparing, transferring, retry wait, paused, complete, cancelled, permanent failure | Resilient uploads |

## Integration and deployment

No migration, dependency or catalog-operation addition is required. Rebase on the
current main and revalidate before merging. Publish the PR/commit, review evidence,
test results, deployed SHA and rollback target to the task. Task completion requires
the deployment and live verification; a merged PR alone is insufficient.
