# 11 — The Spawn Contract

Status: **proposed**, derived by experiment against the live prod node on 2026-08-02.
Origin: tm8 task `019fbec1-bc7d-7845-81fa-42969537d5cf`, "Agent Spawning between claude and codex".

This document is the output of steps 1–3 of that task: reproduce the failures, classify them,
then define what a spawn is actually allowed to promise. Docs `00`–`08` are FINAL and this does
not amend them; it fills in a contract that was never written down, which is why the two
providers drifted apart without anyone being able to point at the clause they broke.

Everything below marked *measured* was observed on the prod node (`127.0.0.1:17777`,
deployed build `f607461`) on 2026-08-02. Nothing below is inferred from reading the spawn code.

---

## 1. What the complaint actually was

The founder's report was four words long: *"Spawing sessions are not great."* The task was groomed
with no defect list because none existed. So the first job was to produce one.

The headline result is not what the task's own framing predicted:

> **Spawning is not unreliable. Spawning is 100% reliable and produces dead sessions.**

Measured over 25 spawns (12 sequential mechanical cycles, 5 concurrent, 8 ad-hoc):

| what | result |
|---|---|
| `session spawn` returned a session id | 25 / 25 |
| manifest written | 25 / 25 |
| session listed by `session liveness` immediately | 25 / 25 |
| median spawn latency | 0.76s (range 0.65–1.8s) |
| orphaned sessions left behind by a *completed* spawn | 0 |

There is no flakiness in the spawn call to chase. The unreliability is entirely downstream:
what comes back is sometimes a session that cannot execute a single command, and tm8 has no
way to tell the difference — see D1 and D2 below.

---

## 2. The matrix

Both directions, both providers, one probe each: spawn, send a message, require the child to run
a shell command and report its output back on its own session anchor.

| # | parent | child | spawn | child ran a command | verdict |
|---|---|---|---|---|---|
| A | claude-code | claude-code (Haiku) | ok, 0.8s | yes, replied in 38s | **PASS** |
| B | claude-code | codex, posture `auto` (the default) | ok, 0.77s | **no — bwrap failure** | **FAIL (D1)** |
| C | claude-code | codex, posture `bypassPermissions` | ok | yes, replied in 23s | PASS |
| D | codex | claude-code | ok | yes, child addressable | **PASS** |
| E | codex | codex, posture `bypassPermissions` | ok | yes | PASS |
| F | codex | codex, posture `auto` (the default) | ok | **no — bwrap failure** | **FAIL (D1)** |

Two things this settles:

- **Cross-provider spawning is not broken as a protocol.** Rows C, D and E cross the provider
  boundary in both directions and work. Parentage, identity and workdir separation are all correct.
- **Rows C/D/E were only reachable at all because of one teammate.** Of the four codex teammates
  in the Space, exactly one (`019fbf89-aae2-796f-bcf2-a561da10d083`) carries
  `permission_mode = 'bypassPermissions'`. The other three — including all three GPT 5.6 teammates
  the task names as the counterparties to test against — are `NULL`, so they resolve to the default
  `auto` and land in row B/F. **Before this investigation, codex-as-parent was structurally
  untestable**: spawning is done by running a shell command, and running a shell command is exactly
  what D1 breaks.

---

## 3. The defect list

### D1 — codex sessions are spawned with a sandbox that cannot start `environment` → `contract`

**Symptom.** Every shell command inside a spawned codex session fails with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. The session boots normally,
reaches "Ready when you are.", accepts messages, acknowledges the instruction — and then silently
stops. It never reports the failure, never retries, and stays `running` and live indefinitely.

**Reproduction.** Spawn any codex teammate whose `permission_mode` is not `bypassPermissions`;
send it any message that requires running a command. 100% reproducible — it is structural, not flaky:
`buildAgentCommand` emits `--sandbox` unconditionally for every posture but one.

**Root cause — and the task description had this wrong.** The recorded cause was "bwrap is not on
PATH" plus "CapEff: 0000000000000000". Both are true statements about this node and neither is the
cause:

- codex 0.146.0 **bundles its own bwrap** and says so in its banner: *"Codex could not find
  bubblewrap on PATH … Codex will use the bundled bubblewrap in the meantime."* The sandbox is
  present. It runs. It fails.
- The blocker is **AppArmor**, not capabilities. `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`
  is `1`, and `/etc/apparmor.d/unprivileged_userns` contains `audit deny capability`. Any unconfined
  binary that creates an unprivileged user namespace is transitioned into that profile and stripped
  of every capability. `CapEff: 0` is a *consequence* of that policy, not an independent fact.

The signature that distinguishes the two, measured here:

```
unshare -U  true      -> succeeds        (creating the userns is allowed: `allow userns`)
unshare -Ur true      -> write /proc/self/uid_map: Operation not permitted
bwrap --unshare-all --share-net ...  -> setting up uid map: Permission denied
bwrap --unshare-all             ...  -> loopback: Failed RTM_NEWADDR: Operation not permitted
```

A pure capability problem would fail identically in both bwrap shapes. These fail at different
depths for different reasons, which is what points at the LSM rather than at the capability mask.

**Why this matters for the fix.** It rules out the configuration workaround anyone would try first.
`sandbox_workspace_write.network_access = true` would skip the netns and preserve *filesystem*
confinement — I tested it specifically because it would have been the good outcome. It fails too,
earlier, at the uid map. **No codex sandbox setting works on this node.**

**But there is a clean host-level fix that keeps the sandbox**, and it should be preferred over
anything in the code: install the `bubblewrap` package (`0.9.0-1ubuntu0.1`, available, not
installed). It ships `/etc/apparmor.d/bwrap-userns-restrict`, the profile that grants bwrap the
userns capabilities the catch-all profile strips, **and** it puts a profiled `bwrap` on PATH so
codex stops falling back to its unprofiled bundled copy. Requires root.

#### D1a — the actual regression from maestro, which is a one-word change

The environment explains why the sandbox fails. It does **not** explain why tm8 asks for one and
maestro did not — and maestro is the thing this was ported from, running on this same host.

Checked directly. `maestro-cli/src/services/codex-spawner.ts` `buildCodexArgs` has **flag-for-flag
the same branch as ours**: `bypassPermissions` → `--dangerously-bypass-approvals-and-sandbox`,
everything else → `--ask-for-approval` + `--sandbox`. So the mapping is not the difference.

The difference is what reaches it:

| | maestro | tm8 |
|---|---|---|
| default permission mode | **none** — falls through to the team member's configured posture | `auto` (`DEFAULT_PERMISSION_MODE`) |
| `auto` in the vocabulary | absent; accessMode union is `['safe','acceptEdits','plan','fullAccess']` | added, and made the default |
| what `auto` emits for codex | n/a | `--ask-for-approval never --sandbox workspace-write` |

maestro's server carries an explicit comment on the fallback it uses instead: *"Fall back to the
winning team member's stored permissionMode … Without this, a team member's configured access level
(e.g. bypassPermissions) is silently dropped at spawn."* Its codex team members were configured
`bypassPermissions`, so no sandbox was ever requested and the AppArmor policy was never touched.

**Confirmed by maestro's own live records on this box:** 15 codex sessions
(`provider: openai, model: gpt-5.6-sol`), every one `completed`, running 4–28 minutes, with timeline
entries describing hundreds of successful shell commands — rebuilt PDFs and DOCX, 90 generated QA
PNGs. Their only recorded tool failure is a missing `libatk` for headless Mermaid rendering, i.e. an
ordinary missing library, not bwrap.

**`auto` itself is not the mistake, and it is worth being precise about that.** It was added for a
real thing: Claude Code has an actual `--permission-mode auto`, which lets the agent run what it
judges safe and escalates the rest. `types.ts` says so directly — *"`auto` is the one posture maestro
never had, because the CLI it maps to did not have it either."* For claude-code it is a sensible
default and it works.

The mistake is that **codex has no equivalent**, so `auto` had to be *translated* for it — and the
translation chosen was `--ask-for-approval never --sandbox workspace-write`. That turns "let the
agent use its judgement", a posture with no infrastructure requirement on claude-code, into a hard
dependency on a working OS sandbox on codex. A default acquired a precondition that only one of the
two providers can fail, and nothing checked it.

So the regression is: **tm8 made a claude-shaped posture the global default, and its codex
translation silently requires a working sandbox where the behavioural oracle required nothing.**
Every codex teammate created without an explicit posture inherits it — 3 of the 4 in this Space had
`permission_mode` NULL. tm8's own comment on the codex `auto` mapping reasoned that codex sessions
naming no posture "must keep landing exactly where they land today", which faithfully preserved a
behaviour that was already broken on any node whose sandbox does not work.

This is also why the fix belongs at the preflight rather than in the mapping table: `auto → sandbox`
is the *right* translation on a node that can sandbox. It is only wrong on a node that cannot, and
that is a question about the node, not about the posture.

### D2 — a spawned session has no readiness or health signal at all `contract`

**Symptom.** tm8 reports a session as `running` and lists it in `session liveness` from the moment
the `work_sessions` row is written. That is a statement about a database row and a PTY handle. It is
not a statement about the agent, and there is no surface anywhere in tm8 that makes one.

**Consequence, measured.** The D1 session above was indistinguishable from a healthy session
through *every* tm8 surface for the entire 15 minutes I watched it: `status: running`, present in
`liveEntityIds`, entity looks normal, no error field, no warning. The only way to discover it was
dead was to attach to its PTY and read the screen.

This is the defect that makes spawning *feel* "not great" independently of D1, and it will still be
there after D1 is fixed. It also makes test case 1 of the task ("**then** the child reaches a ready,
addressable state") currently **unfalsifiable** — there is nothing to assert against.

It also means an unauthenticated or unlicensed CLI presents identically: the agent boots, shows a
login prompt, and tm8 calls it a running session forever.

### D3 — a teammate's permission posture is invisible through the read API `security-observability`

**Symptom.** `team_members.permission_mode` is a real column, and the spawn path reads it
(`execution-handlers.js:114`). The entity read projection does not include it.

**Measured.** `Codex Teammate` `019fbf89-aae2-796f-bcf2-a561da10d083` carries
`permission_mode = 'bypassPermissions'` in the database. `tm8 entity get` on it returns content with
no such field. So the one teammate on this node that runs with **no filesystem confinement and no
approval gate** cannot be identified by anyone reading the graph — only by reading Postgres directly.

This lands squarely on this task's own security criterion. The description records the unsandboxed
state as "known, accepted, temporary". It is not *known* to anybody who did not run a SQL query.

### D4 — an agent killed by a signal is recorded as a clean, successful exit `lifecycle`

**Symptom.** SIGKILL a live agent process; the session is recorded as
`status='exited', exit_code=0, error=NULL` — byte-for-byte identical to an agent that finished
its work successfully.

**Root cause.** `PtyHostService.ts`: `const status = exitCode === 0 ? 'completed' : 'failed'`.
Measured against node-pty 1.1.0, the version this node runs:

```
exit 0    -> { exitCode: 0, signal: 0 }
exit 7    -> { exitCode: 7, signal: 0 }
SIGKILL   -> { exitCode: 0, signal: 9 }
SIGTERM   -> { exitCode: 0, signal: 15 }
```

Classifying on the exit code alone files every signal death as a completion. Worse, it makes
`describePtyExit` — the function written specifically to record signal deaths, carrying a long
comment about the "record law" that a died session must never be silent — **unreachable for exactly
the case it describes**, because it is only called on the `failed` branch.

A second, smaller bug in the same three lines: `signal ?? null` does not normalise node-pty's `0`,
so every clean exit carries `signal: 0`, which reads as a real signal to every `signal !== null`
test downstream. `exit 7` would be narrated as *"exited with code 7 after signal 0"*.

**Blast radius beyond a manual kill.** `tm8-prod.service` runs `KillMode=control-group`, so a single
`systemctl restart` SIGTERMs every live agent on the node — and recorded all of them as having
completed successfully. `raise-session-cap.sh` in the workspace does exactly that restart.

### D5 — nothing reaps a child whose spawner dies `lifecycle`

**Measured, accidentally and then confirmed.** I killed a harness script mid-run. The session it had
spawned seconds earlier was left `running` and live, with no parent process anywhere, and stayed
that way until I terminated it by hand. Session capacity stays consumed.

Explicit teardown, by contrast, is **correct and fast**: `session terminate --yes` transitions the
row to `exited`, reaps the process tree (verified — no leftover children), removes the session from
liveness, and releases capacity, in ~0.5s. 12/12 in the volume run. The gap is specifically the
*unsupervised* path.

### D6 — a spawned child inherits neither its parent's project nor its working directory `contract`

**Measured.** My own session runs with `workdirMode: project` in `/home/tm8/prod-workspace`. Every
child I spawned without an explicit `--launch-project` got `workdirMode: scratch` in
`/home/tm8/prod-data/scratch/<child-session-id>` — an empty directory.

This is defensible as a default, and it is *not* a security bug. It is recorded here because it
silently defeats the use case the feature exists for: two providers working the same issue (sheet
row #12) cannot work the same issue if the second one lands in an empty scratch directory and is
never told. Note this is adjacent to, and must not be conflated with, task
`019fbec3-e552-7cc7-8254-dcdc9856e144` (what context is *carried* across a spawn) — the point here
is only that the working directory is silently not inherited.

### D7 — the deployed node predates posture inheritance, so "the workaround works" was never true here `deployment`

`origin/main` carries `365019f feat(execution): child sessions inherit their spawner's permission
posture`. The deployed prod build is `f607461`, three commits behind it. `parentSessionId` appears
nowhere in the deployed CLI or execution dist.

**Measured consequence:** a `bypassPermissions` codex parent spawned a codex child, and the child's
manifest came back `permissionMode: auto` with `--sandbox workspace-write` — a broken child from a
working parent. Any conclusion that "setting `permissionMode` on the teammate fixes spawning" that
was reached by observing a child of an already-bypassed parent was reading a behaviour this node
does not have.

---

## 4. Classification

| class | defects | nature |
|---|---|---|
| environment | D1 (host half) | node policy; fixable only by an operator |
| contract | D1 (code half), D2, D6 | tm8 promises something it does not check |
| lifecycle | D4, D5 | tm8 records or reaps an ending incorrectly |
| security-observability | D3 | tm8 knows something it does not surface |
| deployment | D7 | the running node is not the reviewed code |

Two classes the task's step 2 predicted and that I did **not** find:

- **Credential availability as a spawn failure.** Every child received working credentials in every
  cell; no spawn failed for auth reasons. `composeEnv` forwards `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  / … from the **server process's** environment (`parentEnv` is `SpawnService.env`), never from the
  spawning session, so a child cannot inherit its parent's per-session credentials — the leak the
  task's risk section warns about does not exist.
- **Concurrent identity bleed.** Five concurrent spawns across both providers produced five distinct
  session ids, five distinct manifests each naming its own session, five distinct native agent ids,
  five distinct working directories, and correct parentage on all five. Test case 5 passes as-is.

One thing to state honestly rather than record as a pass: **credentials are not segregated per
teammate at all.** Sheet row #27 wants per-teammate credentials; what exists is one set of provider
keys on the server process, handed identically to every session it spawns. That is not a defect this
task introduced or can close — there is nothing per-teammate to segregate yet — but "no credential
defect found in the spawn path" should not be read as "row #27 is satisfied".

---

## 5. The contract

### 5.1 Preconditions, checked before anything is created

A spawn MUST verify, and MUST fail before booting a child if any is unmet:

1. The team member exists in the space. *(already enforced — `not_found`, no session row)*
2. The resolved `agentTool` is one tm8 can launch. *(already enforced — `invalid_input`)*
3. The agent CLI binary is resolvable on the composed PATH. *(already enforced — `not_found`)*
4. **The node can actually provide the confinement the resolved posture asks for.** *(new — D1)*

Precondition 4 is the one that was missing, and its absence is D1. Emitting a sandbox flag is not
the same as having a sandbox, and the only way to know which you have is to run the provider's own
sandbox and look.

### 5.2 Outcomes

A spawn has exactly two outcomes and no third:

- **Success** — a live, addressable session, with a durable `work_session` row, a manifest, and a
  child process whose exit will be recorded.
- **Failure** — an error naming *the precondition that was not met*, with no child booted. A durable
  `work_session` row in `failed` carrying the reason is correct and expected; that is a record of an
  attempt, not a half-created session.

"Live and addressable" today means *the row says running and a PTY exists*. Under D2 that is not
good enough, and §5.4 is the debt this contract deliberately leaves open.

### 5.3 Degradation is recorded, not silent — and not refused either

When precondition 4 fails, tm8 launches anyway **and writes down that it did**.

An earlier draft of this section said the opposite: refuse by default, degrade only on an explicit
opt-in. That was wrong, and D1a is why. Maestro ran codex unconfined on this node for its entire
life, successfully, because it never resolved a posture that demanded a sandbox. Refusing would make
tm8 stricter than the system it was ported from *and* still run no codex — worse on both axes, and
it would dress up "we broke it" as "we hardened it".

The real defect was never that codex ran unconfined. It was that **nothing said which of the two
had happened.** So the fix is the record, not the refusal.

| resolved posture | node can sandbox | behaviour |
|---|---|---|
| `bypassPermissions` | either | launch unconfined — nothing was ever going to be confined; no probe |
| anything else | yes | launch with `--sandbox` as before; `sandboxDegraded: null` |
| anything else | no | **launch unconfined**, warn in full once, and set `launch.sandboxDegraded` on the manifest to the reason |
| anything else | no, **and** `TM8_REQUIRE_CODEX_SANDBOX=1` | refuse, naming the precondition |

`launch.permissionMode` records what was **asked for**. `launch.sandboxDegraded` records whether it
was **delivered**. Reading them together is the only way to tell a confined codex session from an
unconfined one, and before this there was no way at all.

An operator who genuinely requires confinement sets `TM8_REQUIRE_CODEX_SANDBOX=1`. The strict posture
stays one environment variable away; it is simply not imposed on a node whose predecessor never
imposed it.

There is deliberately no half-measure that keeps `--ask-for-approval` and drops only `--sandbox`:
approvals with nobody at the terminal is an unattended hang, and it would buy no confinement in
exchange for it.

**The remedy that actually restores confinement** is still the host fix, and it should be preferred
over living with the degradation: install `bubblewrap`, which supplies the AppArmor profile and a
profiled binary on PATH. After that the probe passes and `--sandbox` goes out as written.

### 5.4 Readiness — what this contract does NOT yet promise

D2 is not closed by this document, and callers should not read §5.2 as promising more than it does.
A future amendment should define a per-provider readiness signal (the agent has drawn its prompt and
will consume input) and make `spawn` either wait for it or expose it, so that "addressable" becomes
a checkable claim rather than a synonym for "the row exists". Until then:

- `status: running` means *a process was started*, not *an agent is working*.
- Nothing in tm8 distinguishes a healthy session from one that cannot execute a command.

### 5.5 Endings

- An agent that exits by signal is `failed`, and the signal is recorded. *(D4 — fixed)*
- An agent that exits non-zero is `failed`, with the code recorded. *(already correct)*
- An agent that exits zero with no signal is `exited`. *(already correct)*
- Explicit `terminate` reaps the process tree and releases capacity. *(already correct)*
- A child whose spawner dies is **not** currently reaped. *(D5 — open)*

---

## 6. What changed in this repo

| change | defect | test |
|---|---|---|
| `PtyHostService` classifies on signal as well as exit code, and normalises node-pty's `signal: 0` | D4 | `test/pty-exit-classification.test.ts` (4) |
| `sandbox-probe.ts` — run the provider's own sandbox to find out whether it works; cached per process | D1 | `test/spawn-sandbox-preflight.test.ts` (4) |
| `buildAgentCommand` takes `sandboxUnavailable` and stops emitting a sandbox it cannot deliver | D1 | `test/spawn-sandbox-preflight.test.ts` (2) |
| `SpawnService.resolveSandboxPosture` — degrade and record by default; refuse under `TM8_REQUIRE_CODEX_SANDBOX=1` | D1, D1a, §5.3 | `test/spawn-sandbox-preflight.test.ts` (5) |
| `Tm8Manifest.launch.sandboxDegraded` — the manifest now says whether the posture was delivered, not only what was asked for | D1a, D3 | `test/spawn-sandbox-preflight.test.ts` (2) |

Not fixed here, and why:

- **D2** needs a per-provider readiness signal and a contract amendment; it is the largest remaining
  piece and it is design work, not a patch.
- **D3** is a projection change in the server's team-member read path, outside the execution package.
- **D5** needs a reaper keyed on spawner liveness; it interacts with the ghost-reconcile path that
  already exists (`test/ghost-reconcile.test.ts`) and should be designed with it.
- **D6** is a deliberate default; it needs a product decision, not a bug fix.
- **D7** is a deployment action: the node needs `origin/main`, and the restart needs root.

## 7. A hypothesis that was tested and refuted

Worth recording so nobody spends the afternoon on it again.

Three claude-code sessions failed to answer a probe sent in the first second after spawn, while an
identical probe sent 10–20s later was answered in 38s. The obvious reading was a **delivery race**:
tm8 writes the prompt into a PTY before the agent CLI is reading it, the bytes are lost, and neither
side is told — which would have been a second, independent face of D2.

Controlled test: same probe, same teammate, only the spawn→send delay varied, 0s versus 45s.

| provider | delay 0s | delay 45s |
|---|---|---|
| claude-code (Opus 5) | 2/2 acked | 2/2 acked |
| codex (GPT 5.6 Sol) | 1/1 acked | 1/1 acked |

**6/6 across both providers at both delays. There is no delivery race.** The prompt queue
(`PtyHostService.deliverPrompt` → bounded FIFO → `completePromptHandoff`) does hold a prompt across
the attach gap, and it works.

The original three failures were all the *same model* (Haiku 4.5) declining to comply with a probe
that told it to run one command and stop — a model-compliance observation, not a spawn defect. It is
recorded here rather than in §3 for exactly that reason.

The lesson for D2 stands and is unaffected: it rests on the codex evidence, where a session that
genuinely could not run anything was reported as healthy by every tm8 surface.

## 8. Standing environmental caveat

This node cannot sandbox codex, and until the `bubblewrap` package is installed that remains true.
With this change the consequence moves from *silent functional death* to *a working session that is
recorded as unconfined*. That is a real improvement on both halves — it works, and you can see what
it is — but it is still not a sandbox. Install `bubblewrap` and the degradation disappears on its
own, with no code or config change: the probe starts passing and `--sandbox` goes out as written.

**Applied to the running node, 2026-08-02:** all four codex teammates were set to
`permission_mode = 'bypassPermissions'` — the same configuration maestro's working codex team members
carried. This makes codex spawning work on the CURRENTLY DEPLOYED build (`f607461`), which has none
of the code above. Verified live: GPT 5.6 Sol spawned, ran `echo TM8_SOL_WORKS; id -un; uname -n`
and reported `TM8_SOL_WORKS tm8 tm8-server` back on its own session anchor in 20 seconds — the same
teammate that could not run a single command earlier the same day. Once the code lands, that config
becomes belt-and-braces rather than load-bearing.
