# Workflow: short chat and work-session titles

Version: 1; reviewed against source 2026-11-20; status: Approved.
Open when changing automatic chat/session naming. This document specifies the
single naming workflow; root integration owns its final review and deployment.

## Registry

| View | Mapping |
| --- | --- |
| Workflow | Automatic short title; trigger: new chat or work-session launch |
| Components | `contract/intent-title`, `chat/handlers`, `spawn/manifest`, UI `prompt-title`, `domain/launch`, quick launch and craft launch |
| Journey | Enter intent → see a short title → open the complete original instructions |
| States | `TITLE_INPUT` → `EXPLICIT_TITLE` or `DERIVED_TITLE` → `CREATED`; creation refusal → existing error/retry state |

## Required behavior and tree

1. `TITLE_INPUT`: caller supplies the complete prompt/task plus an optional name.
   - A nonblank explicit chat/session name wins, subject to existing input limits.
     Do not shorten it or overwrite a later manual rename.
   - Without an explicit name, derive a label from the intent: omit conversational
     request prefixes and Markdown decoration, use the first thought, and bound
     it to six words and 56 Unicode characters. Remove a dangling connector if
     the label was cut. Keep useful identifiers, Unicode and short labels.
   - Empty/nontext input uses `New chat` / `Work session`; existing composer and
     API prompt validation still applies. Naming never makes invalid work valid.
2. `DERIVED_TITLE`: evaluate synchronously before creation. No external model,
   background rename, new I/O, timeout, retry, lock or database state is introduced.
   The same intent produces the same title. A task-derived session name is an
   automatic name; its source task title remains untouched.
3. `CREATED`: store the resolved title in the normal creation transaction. Chat
   starts use the human draft for the title even when the posted opening body
   includes a crew brief/context. New Session still stores the complete prompt
   in the task description. Work-session row and launch manifest use the same
   resolver. The original task/prompt is never replaced by the label.
4. Existing chats/sessions keep their names. A title is not an identity or a
   uniqueness key: two launches may share a label. Existing mutation keys govern
   creation replays and concurrency; no later title write can race a rename.

## Handoffs and failures

| Boundary | Payload → success | Failure / timeout / recovery |
| --- | --- | --- |
| Pure naming | `{intent: string, fallback: string}` → nonempty short string | No I/O or asynchronous timeout; no resources created |
| UI → `chat.start` | Existing `StartChatInput`, including `body`, optional `title`, mutation key → existing `StartChatResult` | Existing `invalid_input`, `forbidden`, `not_found`, `upstream_unavailable`; retain/retry existing request flow, never retry naming separately |
| Server → `start_chat` | Existing RPC positionals, resolved title and unmodified body → chat/message IDs | Existing transaction rollback and ledger replay; title adds no cleanup resource |
| UI → `execution.spawn` | Existing input; optional explicit title, tasks and complete prompt → existing spawn result | Existing admission, timeout and partial-launch handling; do not delete the prompt-bearing task on failed spawn |
| Session resolver → persistence/manifest | One resolved string → identical session/manifest title | Existing launch failure lifecycle; no independent naming persistence |

Creation request timeout budgets are unchanged. The naming step is bounded local
string work over already bounded API inputs; it cannot wait on another service.
Transient dependency failures, permanent validation failures, partial creation
and uncertain acknowledgements remain owned by the existing creation workflow.

## Observable states

| State | Customer | Operator | Database | Logs |
| --- | --- | --- | --- | --- |
| Input / derived | Draft or current creation progress; New Session previews derived name | Existing request state | No new row yet | Existing request events; no prompt/title content added |
| Explicit | User's chosen name | Same chosen name | Unchanged until creation commits | No naming job |
| Created | Short automatic name or chosen name; complete prompt in transcript/task | Same persisted title | Chat/session title and full original body/task | Existing creation/audit events |
| Refused / timeout | Existing error, retry or uncertain-launch message | Existing error/launch state | Existing transaction/launch outcome | Existing failure codes; no naming-specific failures |

Cleanup inventory: none added. Titles are fields in existing creation resources.

## Verification and assumptions

- Test polite prefixes, Markdown, question/sentence boundaries, long identifiers,
  Unicode, empty/nontext input, short labels and the word/character bounds.
- Exercise chat handler RPC arguments: automatic label, explicit-name precedence,
  unchanged opening body, and no post-creation rename.
- Exercise session resolution plus manifest title: explicit name, task fallback,
  teammate fallback and untouched task text.
- Exercise UI submission: derived short names and verbatim prompt storage.
- Assumption: a deterministic compact extract is sufficient for a useful first
  label; this change does not claim semantic model summarization.
- Verified: chat SQL replay hash excludes title/body; new naming does not alter
  replay identity. Session persistence and manifest already share one resolver.
- Existing data has no reliable explicit/automatic-title provenance, so a bulk
  rewrite could replace chosen names. No backfill is performed.

Source audit: the work-session resolver supplies both persistence and manifest;
New Session, launch popup, legacy quick launch, craft launch and GateApp defaults
all now reach the shared policy. Explicit New Session input keeps its existing
80-character limit. Focused verification passed: 15 contract, 7 chat handler,
81 manifest and 100 UI tests; contract/prompt/execution and CLI builds passed.

## Integration reality check (2026-11-20)

Independent Sol review verified the code against this workflow. Upload review
closed interrupted receipts, unknown settlement cleanup, completed-writer races,
and active-writer SQLSTATE handling. Attention review verified priority, personal
headlines, complete paging and failed-sibling read ownership. Access review checked
viewer gates, metadata allowlists, masking and recorded/current distinctions.
Short-title creation seams and prompt preservation pass the focused test suites.
Deployment remains a separate completion requirement recorded on the task.
