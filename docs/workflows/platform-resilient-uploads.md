# Workflow: resilient file and artifact delivery

Version 1 · 2026-11-20 · Approved · task 01a1fa88-979a-7667-a9de-d4ef6ff744e8

## Actors, trigger and prerequisites

A signed-in person uploads a file through an attachment surface, or an agent
publishes an artifact/file through the CLI. The existing file grant and artifact
mutation ledgers remain the authority. This workflow changes recovery, not access.

## Tree and handoff contracts

1. VALIDATE: reject empty/oversized/unsupported input before sending bytes. Compute
   and retain checksum; keep original file/prompt bytes. No database effects.
2. INITIALIZE: `files.uploadInit(FileUploadInitInput) -> FileUploadGrant`, with one
   stable mutation ID. Transient failure retries that same payload; permanent
   failure terminates. Unknown response keeps that ID for manual resume.
3. TRANSFER: PUT the same bytes with the same grant. The server acknowledges an
   already staged slot, verifies size/checksum, and removes incomplete temporary
   bytes. A completed slot also acknowledges replay without writing bytes. A
   fully written blob whose settlement response was lost is retained and verified
   before a later writer settles it. An unknown database outcome never deletes it.
   A concurrent grant writer's lease causes bounded retry, then pause. No offset protocol is claimed: an interrupted transfer restarts that
   file, while a staged file resumes at completion.
4. COMPLETE: `files.uploadComplete(uploadId, FileUploadCompleteInput) -> CommandResult`
   using one stable completion ID. A lost response retries completion only. The
   database returns the same file entity and protects completed bytes from abort.
5. ARTIFACT: `artifacts.create|publish` sends the original manifest, inline bytes,
   expected version and mutation ID on every attempt. Its ledger replays the
   successful result even when the first response was lost. No new revision is
   created by recovery.

Each retryable step gets four attempts with exponential jittered backoff from
500ms, capped at 5s, respecting server `retryAfterSeconds` (and client `retryAfterMs`)
up to a 30s wait. Longer server waits pause without retrying early. Requests retain
their existing deadlines (browser JSON 15s, byte PUT 120s; CLI explicit timeout or
its operation default, byte PUT 60s). Retry delays are cancellable. Validation,
authentication/authorization, quota, size and version failures stop immediately.
Transport/rate-limit failures retry; unknown programming errors stop.

## State and observable behavior

| State | Customer | Operator/logs | Database |
|---|---|---|---|
| PREPARING / TRANSFERRING | Existing uploading chip | Ordinary request IDs; CLI reports retry stage/attempt/delay, never tokens | One pending slot, at most one staged blob |
| RETRY_WAIT | Upload stays pending | Retry request uses original IDs | Existing slot/revision unchanged |
| PAUSED | Cause and retry-to-resume action | CLI prints original mutation ID to reuse | Pending grant retained until expiry; completed entity preserved |
| COMPLETE | Existing attachment/artifact appears once | Normal completion receipt | One file/artifact revision, ledger result retained |
| CANCELLED / PERMANENT_FAILURE | Cancellation or specific refusal | Existing abort request and ordinary error | Pending slot aborted; completed content preserved |

Browser manual retry retains the grant, phase and IDs for the same File object,
space and anchor while the page remains open. A repeated concurrent start for that
same upload shares the task. Reload recovery requires reselecting the file; no
durable browser storage or byte-level resume is claimed. CLI cross-process resume
uses the original `--mutation-id`; local source bytes must be unchanged.

## Cleanup, conflicts and failure recovery

Cancellation/permanent failure aborts an unfinished grant once. Transient
exhaustion preserves it for resume; server expiry sweep reclaims abandoned slots.
Unknown completion outcome must never trigger destructive cleanup. Concurrent
completion/replay is serialized by the existing database ledger. Independent
uploads use independent mutation IDs. Abort of a completed slot retains its file.
Artifact staging cleanup follows the existing reference/expiry rules.

## Tests and assumptions

Test transient init/PUT/complete recovery, lost completion response, stable IDs,
paused manual resume, cancellation during backoff, permanent refusal, concurrent
starts, Retry-After limits, and artifact publish replay over the real client.
Reality check must verify these contracts against code/tests before approval.

Verified: raw PUT accepts staged slots; complete and abort protect completed files;
artifact create/publish check replay before changing data (055 artifacts migration).
Assumption: source File identity is retained by the composer's existing manual
retry. Existing upload grant expiry and garbage collection remain deployment policy.

## Integration reality check (2026-11-20)

Independent Sol review verified the code against this workflow. Upload review
closed interrupted receipts, unknown settlement cleanup, completed-writer races,
and active-writer SQLSTATE handling. Attention review verified priority, personal
headlines, complete paging and failed-sibling read ownership. Access review checked
viewer gates, metadata allowlists, masking and recorded/current distinctions.
Short-title creation seams and prompt preservation pass the focused test suites.
Deployment remains a separate completion requirement recorded on the task.
