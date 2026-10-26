# Chat harness foundation verification

Verified on 2026-10-10 against the integrated Claude/Codex foundation. The
architecture and private contracts are in [chat-harness-foundation.md](chat-harness-foundation.md).

## Integrated evidence

| Check | Result |
| --- | --- |
| Execution adapters, registry, environment and legacy Claude tests | 87 tests passed |
| Server chat, continuity helper, verified claims and human-auth tests | 150 tests passed |
| Model, effort, credential switching and existing chat UI composition | 100 tests passed |
| Affected PostgreSQL authorization, continuity, multi-member drain, MCP, RLS and catalog suites | 557 tests passed |
| Storage, attachment lifecycle and strict identity-call inventory fixtures | 74 tests passed |
| CLI chat command paths | 31 tests passed |
| Core typecheck and build; UI production build | Passed |
| Fresh migration application and identity-reader gate | Passed; 281 live readers audited |

Counts describe their named runs, not a claim that every repository test passed.
The affected database suites use an explicitly selected local scratch cluster;
they never use the production database. Runtime and credential reviewers also
independently reproduced the lost-ACK, failed final write, exact cleanup retry
and queued-successor cases against the committed continuity amendment.

## Live Codex evidence

The opt-in [chat-live-smoke.ts](../../packages/server/harness/chat-live-smoke.ts)
uses the production credential preparation, registry and orchestrator with an
isolated scratch database and private launch material. It ran two real Codex
subscription turns: turn one returned a nonce, and turn two recalled it after a
reasoning-effort change and replacement of the native process. Both turns
completed, generations advanced from 1 to 2, claimed efforts were low then
medium, the final runtime phase was idle, and owned resources were removed.

Run only against an explicitly owned test cluster, with a valid locally selected
Codex login:

```sh
TM8_CHAT_LIVE_SMOKE=1 \
TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres \
bun packages/server/harness/chat-live-smoke.ts
```

The installed Codex 0.161.0 HTTP-history probe separately proved that two local
mock Responses requests carry prior conversation input without relying on
`previous_response_id`. Cross-harness Codex → Claude → Codex switching was
verified with the real registry and PostgreSQL lifecycle using fixture children.
No live Claude inference was run: its available login did not provide a
validated portable credential lease. No live Groq inference was run.

## Boundaries

- Native checkpoint coverage remains unknown. Process replacement uses portable
  canonical history; successful launch or exit does not manufacture resume proof.
- Phase-one projection visibly refuses more than 256 earlier turns, more than
  4096 normalized parts, or a byte budget too small for mandatory attribution and
  uncertainty. It does not silently omit a prefix.
- Required capabilities with unknown enforcement are rejected during admission.
  Codex does not claim to load the Claude skills plugin or enforce unsupported
  built-in tool restrictions.
- A provider terminal is retained across lost dispatch acknowledgements. Success
  publication also requires its normalized final part to be durable; persistent
  write failure leaves that proof for atomic recovery without provider resubmission.
- Confirmed child exit and successful private cleanup are separate facts. Failed
  cleanup retains the original owner and exact grant for retry; only successful
  fenced durable lease release wakes queued work.

Repository-wide CI has inherited UI failures outside this change. Nineteen
matching failures were present in the earlier run at the identity-helper commit,
before the chat UI changes. Their presence is recorded rather than treated as
green CI; the changed chat UI suites above pass.
