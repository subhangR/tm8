# Buzz — workflows, git-on-Nostr, and a maturity audit

## YAML workflows

Definitions stored as **kind:30620** (param-replaceable events), triggered manually via kind:46020.
Real schema at `crates/buzz-workflow/src/schema.rs:13-147`:

```
WorkflowDef { name, trigger, steps, enabled }
trigger: message_posted | reaction_added | diff_posted | schedule | webhook
step:    { if (evalexpr), timeout_secs, <flattened action> }
```

### The 7 actions — and how many actually work

| Action | Status |
|---|---|
| `send_message` | ✅ works |
| `delay` | ✅ works |
| `add_reaction` | ⚠️ feature-gated |
| `call_webhook` | ⚠️ feature-gated, SSRF-guarded |
| `send_dm` | ❌ `NotImplemented` |
| `set_channel_topic` | ❌ `NotImplemented` |
| `request_approval` | ❌ **stubbed and actively harmful** |

**`request_approval` is worse than missing.** The step returns `Suspended`, then `finalize_run`
marks the whole run **Failed** with *"approval gates not yet implemented (WF-08)"*
(`executor.rs:650-669`). The relay-side grant/deny/resume handlers and the DB `create_approval`
all exist but are **unreachable** — called only from tests (`lib.rs:229-253`,
`command_executor.rs:1281-1298`).

**⚠️ No workflow action can invoke or spawn an agent.** In a product whose entire pitch is
"agents are teammates", the automation layer cannot call one. The executor is ~1837 lines and
otherwise real (evalexpr conditions, templating, run lifecycle). Zero `todo!()`/`unimplemented!()` —
gaps are explicit `Err(NotImplemented)`, which is at least honest.

> **Lesson for tm8:** tm8's `execution.dispatch` and spawn-on-thread already do what Buzz's
> workflow layer cannot. Don't be impressed by the YAML — be impressed that we can already call an
> agent from an automation.

## Git on Nostr — the most mature subsystem in the repo

A **real Smart-HTTP git server inside the relay** that shells out to `git upload-pack` /
`receive-pack`, with **NIP-98 auth on every route** and no public repos
(`crates/buzz-relay/src/api/git/transport.rs:4-8,662-762`).

**Storage is stateless/object-store**: repos hydrate an ephemeral bare repo from object storage per
request into a tempdir; the only persistent state is a Postgres repo-name registry with per-pubkey
quota (`hydrate.rs:33-63`, `git_repo.rs:81-156`).

Two standalone crates, both with **zero stubs**:

| Crate | What it does |
|---|---|
| `git-credential-nostr` | A git **credential helper** that signs a kind:27235 NIP-98 event with your Nostr key, so HTTP auth needs no password (`lib.rs:152-266`) |
| `git-sign-nostr` | A `gpg.x509.program` replacement that **BIP-340 Schnorr-signs commits and tags with the Nostr key** (their NIP-GS), GPG-status-compatible (`lib.rs:895-935,1099-1332`) |

**Code review is real — but in a dedicated Projects UI, not in chat.**
`ProjectPullRequestFilesChangedPanel` gives per-file diffs with inline comments, approve /
request-changes / merge, backed by NIP-34 status events 1630-1633.

> Worth noting against the marketing: "code review in chat" is **not** what shipped. Review lives in
> a separate surface, exactly as it does in every other tool.

## Maturity audit

**Real and tested:** relay ingest/query/FTS, NIP-29 chat, the threads projection, the whole git
subsystem, workflow schema/trigger/eval/`send_message`/webhook, the kind:44200 metrics crate,
observer-frame crypto, the desktop timeline and observer panels. Test density is genuinely high
(725 test fns in `buzz-acp` alone).

**Scaffolded or dead:** workflow approval gating (marks runs Failed), `send_dm` /
`set_channel_topic`, **no agent-spawn action**, **no cost/token UI anywhere**, kind:9009 invites
(no-op), kind:39003 group roles (unemitted), remote-agent k8s lifecycle (vision-led).

**Overall:** a serious, well-tested three-week-old product with an unusually mature git layer, a
strong agent harness, and a deliberately thin agent-UX layer. Block's own "early stages" framing is
accurate — but the weak parts are *chosen* (auto-approve, ephemeral transcripts) as often as they
are *unfinished*.
