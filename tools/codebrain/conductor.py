#!/usr/bin/env python3
"""
CodeBrain v3 conductor — the loop, as code.

This is the piece whose absence capped v2. Everything else in v3 is a better-designed
roster; without this, a human still spawns every phase and relays every handoff, which
is exactly the dependency that made v2 "not a system".

Ported from ralph-loop/hooks/stop-hook.sh: a loop, a completion promise, and an escape
hatch. Ralph blocks a session's exit and re-feeds the same prompt; tm8 has no Stop hook,
so the equivalent here is an external driver that re-reads durable graph state each tick
and decides what runs next.

## The state rule that makes this reliable

**A phase is complete iff its member has posted on the anchor since the run began.**
Author id, not prose. Earlier today I wrote a waiter that grepped the anchor for the word
"standard" and it fired immediately on text that was already there — a false trigger that
looked exactly like success. Keyword state is unfalsifiable; `author_id = <member>` and
`created_at > run_start` cannot be satisfied by accident.

## Wedged-session handling

Measured this session: 2 of 4 spawns produced a live PTY that did zero tool calls and
never reported (v2's VERIFY sat that way for 30 minutes). `work_sessions.status` does not
tell you this and neither does liveness — a wedged session is live. The only signal that
discriminates is **tool calls over elapsed time**, from the transcript. So: if a session
has made no tool calls after WEDGE_SECS, terminate and respawn it once, then give up and
escalate rather than loop forever on it.
"""
import argparse
import json
import os
import subprocess
import sys
import time

SP = os.path.dirname(os.path.abspath(__file__))
IDS = json.load(open(os.path.join(SP, "members.json")))
M = IDS["members"]
PG = "postgresql://127.0.0.1:5442/tm8_prod"

MAX_ITERATIONS = 20          # ralph's escape hatch. Never run past it.
MAX_CONCURRENT = 1           # 4 cores; spawns wedge under load.
WEDGE_SECS = 240             # no tool calls by now => wedged, not slow.
PHASE_TIMEOUT = 2400         # a phase that has not reported by now is escalated.
GATE_WAIT = 900              # how long a human gate waits before proceeding on assumption.
POLL = 20
GATE_DEFAULT = None   # a human may pre-authorise a fallback; the agent never supplies it
PROMISE_GRACE = 90   # seconds after a post to wait for the promise before flagging
# packages/execution/src/spawn/worktree-provisioning.ts:95 names the branch
#   `tm8/${worktreeId.replace(/-/g,'').slice(0,8)}`
# That is the top 32 bits of a UUIDv7's 48-bit millisecond timestamp, so it DROPS 16 bits
# and every worktree created inside the same 2^16 ms window gets the SAME branch name.
# `git worktree add` then fails with worktree_add_failed for the second one. Measured:
# three v3 member entities created seconds apart all map to tm8/01a057c6.
# v2 never hit this because it spawned one phase at a time; parallel lenses hit it every run.
WORKTREE_BRANCH_WINDOW = 66   # seconds; > 65.536s guarantees a distinct branch name

# Only a phase that WRITES code needs an isolated worktree. Everything else reads, and a
# read-only phase in `project` mode gets the real checkout with no branch to collide on.
# This removes the 66s stagger for 15 of 17 members and sidesteps the collision entirely
# for them — a workaround applied where it is actually needed instead of everywhere.
WRITES_CODE = {"implement"}
PROJECT = os.environ.get("CB3_PROJECT")   # projects.id; required for --workdir worktree

# Stage -> member keys that run IN PARALLEL. A gate stage ends in a human decision.
STAGES = [
    ("TRIAGE",    ["triage"],                                            False),
    ("EXPLORE",   ["explore-similar", "explore-arch", "explore-surface"], False),
    ("CLARIFY",   ["clarify"],                                           True),
    ("ARCHITECT", ["arch-minimal", "arch-clean", "arch-pragmatic"],       True),
    ("IMPLEMENT", ["implement"],                                         False),
    ("REVIEW",    ["rev-guidelines", "rev-bugs", "rev-tests",
                   "rev-silent", "rev-types", "rev-history"],            False),
    ("GRADE",     ["grader"],                                            False),
    ("SHIP",      ["ship"],                                              False),
]

# Depth routing from TRIAGE. Charging full rigour to every change is why a pipeline
# costs 10x and delivers 1x.
DEPTH = {
    "direct":   ["IMPLEMENT", "REVIEW", "GRADE"],
    "standard": ["EXPLORE", "CLARIFY", "IMPLEMENT", "REVIEW", "GRADE", "SHIP"],
    "full":     [s[0] for s in STAGES if s[0] != "TRIAGE"],
}

# Depth must thin the FAN-OUT too, not only pick stages. Measured on the tm8 run: TRIAGE
# routed `standard` and asked for "explore(1)" and "review(3 lenses)", and the conductor ran
# 3 and 6 anyway — because DEPTH only selected stage NAMES. So `standard` saved one stage and
# nothing else, and the throughput saving claimed for depth routing was mostly imaginary.
# Caps are per (depth, stage); a stage absent here runs its full roster.
FANOUT = {
    "direct":   {"REVIEW": 2},
    "standard": {"EXPLORE": 1, "REVIEW": 3},
    "full":     {},
}


def members_for(depth, stage, keys):
    """The members to actually run for this stage at this depth, in roster order."""
    cap = FANOUT.get(depth, {}).get(stage)
    return keys[:cap] if cap else keys


def sql(q):
    r = subprocess.run(["psql", PG, "-t", "-A", "-F", "\t", "-c", q],
                       capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip())
    return [ln.split("\t") for ln in r.stdout.strip().splitlines() if ln]


def tm8(args, check=True):
    r = subprocess.run(["tm8"] + args, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"tm8 {' '.join(args[:3])}: {r.stderr.strip()[:300]}")
    out = r.stdout
    try:
        return json.loads(out[:out.rindex("}") + 1], strict=False)
    except Exception:
        return {"raw": out}


def q(s):
    return s.replace("'", "''")


def posted_since(anchor, member_id, since):
    """The state predicate. Author id + timestamp, never keywords."""
    return bool(sql(f"""select 1 from public.messages
                         where anchor_id='{q(anchor)}' and author_id='{q(member_id)}'
                           and created_at > timestamptz '{q(since)}' limit 1"""))


def last_body(anchor, member_id):
    r = sql(f"""select replace(body,E'\t',' ') from public.messages
                 where anchor_id='{q(anchor)}' and author_id='{q(member_id)}'
                 order by created_at desc limit 1""")
    return r[0][0] if r else ""


PROMISE = "<promise>PHASE COMPLETE</promise>"


def promised(anchor, member_id, since):
    """Did this member DECLARE completion, not merely post?

    Measured 2026-08-31: explore-surface posted a full, correct report and never emitted the
    promise, and the conductor advanced anyway — because only SHIP's promise was ever read.
    Every identity is told to emit the promise only when the statement is unequivocally true,
    so treating a post as a declaration discards the one signal that distinguishes "I am done"
    from "here is what I have so far". Now every phase is held to it.
    """
    r = sql(f"""select 1 from public.messages
                 where anchor_id='{q(anchor)}' and author_id='{q(member_id)}'
                   and created_at > timestamptz '{q(since)}'
                   and body like '%<promise>PHASE COMPLETE</promise>%' limit 1""")
    return bool(r)


def relay_path(task, stage):
    return os.path.join(SP, f"_relay-{task[:13]}-{stage}.txt")


def relayed_human(task, stage):
    """A human decision that reached the run through an agent, recorded ATTRIBUTABLY.

    The gate resolves on `entities.kind='member'`. A human who answers through an operator
    relay is authored by a team_member, so the predicate returns False — correct about the
    ANCHOR, wrong about the WORLD. That mismatch fired on this task: the anchor ended up
    asserting both "human decided Q1(b)" and "no human decision arrived, proceeding on an
    assumption, re-run everything if corrected". A downstream phase reading only the second
    would have re-run work for no reason.

    HONEST LIMIT, and it is the whole point of the design: this is ATTRIBUTABLE, NOT
    UNFORGEABLE. An agent can write this file and claim a human verified something. What it
    buys is that the claim becomes an explicit, auditable, attributable act with a named
    capture method — instead of a predicate silently defaulting and a record silently
    contradicting itself. Making a lie visible is a weaker guarantee than making it impossible,
    and it is the one available without the human signing something.
    """
    p = relay_path(task, stage)
    if not os.path.exists(p):
        return None
    txt = open(p).read()
    return txt if "capture: human-verified" in txt else None


def decisions_path(task):
    return os.path.join(SP, f"_decisions-{task[:13]}.txt")


def record_decision(task, text):
    """Store a human's gate decision VERBATIM, once.

    CLARIFY's closing finding, and the last thing standing between a human's answer and the
    code written from it: the gate controls WHETHER the run proceeds, not WHAT it proceeds
    with. The decision reached downstream by an agent retyping it in prose — a channel with a
    MEASURED error rate on this very task. `conftest.py:14` for `:16`, wrong twice, and a BUILD
    agent following that brief would have patched an import statement.

    So the decision is written once and thereafter only ever COPIED, never restated. A sha256
    is recorded so any later claim to be quoting it can be checked rather than trusted.
    """
    open(decisions_path(task), "w").write(text)
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def decisions(task):
    p = decisions_path(task)
    return open(p).read() if os.path.exists(p) else ""


def ledger_path(task):
    return os.path.join(SP, f"_done-{task[:13]}.json")


def ledger(task):
    p = ledger_path(task)
    return set(json.load(open(p))) if os.path.exists(p) else set()


def inflight_path(task):
    return os.path.join(SP, f"_inflight-{task[:13]}.json")


def mark_inflight(task, key, sid):
    """Record a stage as STARTED, not merely completed.

    The ledger only recorded completion, so a conductor restarted mid-stage could not tell
    "already running" from "never started" — the two look identical to it. Restarting while
    IMPLEMENT was live would have spawned a SECOND session against the same task and the same
    worktree. That is the duplicate-spawn failure the EXPLORE lenses caught earlier, and it
    would have been the conductor causing it rather than catching it.
    """
    d = {}
    if os.path.exists(inflight_path(task)):
        d = json.load(open(inflight_path(task)))
    d[key] = sid
    json.dump(d, open(inflight_path(task), "w"), indent=1)


def inflight(task):
    p = inflight_path(task)
    return json.load(open(p)) if os.path.exists(p) else {}


def clear_inflight(task, key):
    d = inflight(task)
    d.pop(key, None)
    json.dump(d, open(inflight_path(task), "w"), indent=1)


def live_elsewhere(task, key):
    """Is a session for this member ALREADY running, started by another conductor?

    Returns the session id if so. Checked before spawning, so a restart adopts the running
    session instead of racing it.
    """
    sid = inflight(task).get(key)
    if not sid:
        return None
    r = sql(f"""select status from public.work_sessions where entity_id='{q(sid)}'""")
    return sid if r and r[0][0] not in ("exited", "failed") else None


def mark_done(task, key):
    d = ledger(task); d.add(key)
    json.dump(sorted(d), open(ledger_path(task), "w"), indent=1)


def ever_completed(anchor, member_id, key=None, task=None):
    """Has this member's phase already been ACCEPTED for this task?

    The conductor's own ledger is the authority for "I accepted this phase", because message
    content is not. My first attempt asked the anchor for a promise-bearing report — and it
    FAILED its own falsification test on explore-surface, which delivered a complete, verified,
    high-value report and never emitted the promise. That version would have respawned it on
    every run forever, which is precisely the loop that hung the stage.

    So: the ledger records what the conductor accepted; the anchor records what the phase said.
    Ask the ledger. The promise check remains as a secondary signal for a phase completed by
    some earlier conductor whose ledger is gone.
    """
    if key and task and key in ledger(task):
        return True
    return bool(sql(f"""select 1 from public.messages
                         where anchor_id='{q(anchor)}' and author_id='{q(member_id)}'
                           and body like '%<promise>PHASE COMPLETE</promise>%' limit 1"""))


def tool_calls(session_id):
    d = tm8(["session", "transcript", session_id, "--limit", "1", "--format", "json"], check=False)
    return (d.get("stats") or {}).get("toolCalls", 0), d.get("lastActivityAt")


def idle_secs(session_id):
    """Seconds since this session last did ANYTHING.

    The wedge test used to be `tool_calls == 0 and elapsed > WEDGE_SECS`, which only catches a
    session that never started. Measured twice, both missed: IMPLEMENT's first attempt made ONE
    tool call and hung 31 minutes; then rev-guidelines, rev-bugs and rev-tests all made 1-3
    calls and stopped dead at the same minute, invisible for the full 40-minute PHASE_TIMEOUT.

    A count cannot distinguish "working slowly" from "stopped after one call". Time since last
    activity can, and it is the same signal for both failure shapes.
    """
    d = tm8(["session", "transcript", session_id, "--limit", "1", "--format", "json"], check=False)
    ts = d.get("lastActivityAt")
    if not ts:
        return None
    r = sql(f"select extract(epoch from (now() - timestamptz '{q(ts)}'))")
    return float(r[0][0]) if r else None


def spawn(member_key, task, brief, extra=None):
    """Spawn lean, then deliver the brief as a message.

    The first-turn injection budget is 32,768 UTF-8 bytes and a full brief blows it
    (`payload_too_large`). Measured twice. So --context carries one line and the real
    instruction arrives on the anchor, where it is durable anyway.
    """
    ctx = os.path.join(SP, f"_ctx-{member_key}.txt")
    # The brief is delivered to THIS SESSION's anchor, not the task anchor — say so.
    # I changed the delivery target and left this text pointing at the task anchor, which sent
    # IMPLEMENT hunting through 60+ task messages for a brief that was never there.
    open(ctx, "w").write(f"CodeBrain v3 · {member_key}. Your brief was delivered as a message "
                         f"to THIS SESSION (not the task anchor) — it is the first message you "
                         f"received. Read it, do your phase, post your REPORT to the TASK "
                         f"anchor, and stop.\n")
    # --workdir worktree fails with `worktree_requires_project` unless the project is named
    # explicitly; --launch-project wants the projects.id, not the project entity id.
    writes = member_key in WRITES_CODE
    args = ["session", "spawn", "--teammate", M[member_key], "--task", task,
            "--access-mode", "acceptEdits",
            "--workdir", "worktree" if writes else "project",
            "--context", f"@{ctx}", "--mutation-id", f"cb3-{member_key}-{int(time.time())}",
            "--format", "json"] + (["--launch-project", PROJECT] if PROJECT else []) + (extra or [])
    sid = tm8(args)["entity"]["id"]
    bf = os.path.join(SP, f"_brief-{member_key}.txt")
    open(bf, "w").write(brief)
    # Address the SESSION, not the task anchor. A stage's lenses all share one task anchor,
    # so a brief sent there is delivered to every sibling — explore-similar received
    # explore-arch's brief on the first run and had to reject it as a crossed dispatch.
    # A work session is an anchor like any other; this is the private channel.
    # Reports still go to the TASK anchor, where they are shared and durable.
    tm8(["message", "send", "--to", sid, "--body", f"@{bf}",
         "--mutation-id", f"cb3-brief-{member_key}-{int(time.time())}", "--format", "json"])
    return sid


def release(sid, key):
    """Terminate a session the moment its phase is done.

    A session left alive after reporting is not idle-and-harmless: it keeps receiving anything
    posted to the task anchor, and its later messages are indistinguishable from the CURRENT
    run's work because completion is keyed on member. Release makes "one member, one live
    session" true. It also frees a slot on a 4-core box.
    """
    tm8(["session", "terminate", sid, "--yes", "--format", "json"], check=False)
    print(f"      released {key} ({sid[:8]})")


def run_stage(name, keys, task, brief_of, dry):
    """Spawn a stage's members in parallel (capped), wait for every one to report.

    Returns (ok, notes). A member that wedges is respawned once; a member that wedges
    twice is escalated rather than retried forever.
    """
    started = sql("select now()")[0][0]
    live, attempts, done, notes, sids = {}, {}, set(), [], []
    # Skip members already in the ledger. The stage-level check in main() only fires when ALL
    # members are complete, so a lens that finished was being re-spawned every time a SIBLING
    # was still outstanding. Measured: rev-history completed, then ran a second full pass
    # because five siblings had wedged.
    already = [k for k in keys if k in ledger(task)]
    for k in already:
        print(f"    · {k} already complete — not re-running")
        done.add(k)
    pending = [k for k in keys if k not in already]

    while len(done) < len(keys):
        while pending and len(live) < MAX_CONCURRENT:
            k = pending.pop(0)
            if dry:
                print(f"    [dry] would spawn {k}"); done.add(k); continue
            if live and k in WRITES_CODE:  # only worktree spawns can collide on branch name
                print(f"    …staggering {WORKTREE_BRANCH_WINDOW}s (branch-name collision window)")
                time.sleep(WORKTREE_BRANCH_WINDOW)
            existing = live_elsewhere(task, k)
            if existing:
                # Another conductor started this and is gone; adopt rather than duplicate.
                live[k] = (existing, time.time()); attempts[k] = attempts.get(k, 0) + 1
                sids.append(existing)
                print(f"    ADOPTED already-running {k} -> {existing} (not re-spawned)")
                continue
            sid = spawn(k, task, brief_of(k))
            mark_inflight(task, k, sid)
            live[k] = (sid, time.time()); attempts[k] = attempts.get(k, 0) + 1; sids.append(sid)
            print(f"    spawned {k} -> {sid}")
        if dry and not pending:
            break
        time.sleep(POLL)
        for k, (sid, t0) in list(live.items()):
            if promised(task, M[k], started):
                print(f"    ✓ {k} reported and promised complete")
                release(sid, k); done.add(k); live.pop(k); continue
            if posted_since(task, M[k], started) and time.time() - t0 > PROMISE_GRACE:
                # Posted a report but never declared completion. Do NOT silently treat that
                # as done — record it, because the two signals disagreeing is information.
                print(f"    ~ {k} posted WITHOUT the completion promise — accepting, flagged")
                notes.append(f"{k}: reported but never emitted the completion promise")
                release(sid, k); done.add(k); live.pop(k); continue
            el = time.time() - t0
            tc, _ = tool_calls(sid)
            idle = idle_secs(sid)
            # A session that has ALREADY POSTED is not wedged — it went quiet because it
            # finished. Measured: rev-history reported, went idle, was adopted by a restarted
            # conductor, and the idle test killed it 335s later before PROMISE_GRACE could
            # accept it. Idle-after-done and idle-after-hang look identical to a timer; the
            # discriminator is whether a report exists on the anchor. Check that first.
            if posted_since(task, M[k], started):
                print(f"    ~ {k} posted and went idle — accepting (not a wedge)")
                notes.append(f"{k}: reported but never emitted the completion promise")
                release(sid, k); done.add(k); live.pop(k); continue
            # Wedged = SILENT for WEDGE_SECS, whatever the tool count. A session that made one
            # call and stopped is wedged; the old `tc == 0` test called it healthy.
            # Idle time ALONE. The old `tc == 0 and el > WEDGE_SECS` clause survived here and
            # killed a SHIP session that was 3 seconds idle -- alive and mid-generation, just
            # with no tool call yet. Elapsed-since-spawn says nothing about liveness for an
            # adopted session; seconds since last activity is the only signal that does.
            # Fall back to elapsed only when the transcript gives us no timestamp at all.
            if (idle > WEDGE_SECS) if idle is not None else (el > WEDGE_SECS and tc == 0):
                # The failure mode liveness cannot see: live PTY, zero work.
                print(f"    ! {k} wedged (idle {int(idle or el)}s, {tc} tool calls) — terminating")
                tm8(["session", "terminate", sid, "--yes", "--format", "json"], check=False)
                live.pop(k)
                if attempts[k] < 2:
                    pending.append(k)
                else:
                    notes.append(f"{k}: wedged twice, escalated"); done.add(k)
            elif el > PHASE_TIMEOUT:
                print(f"    ! {k} over PHASE_TIMEOUT with {tc} tool calls — escalating")
                notes.append(f"{k}: no report after {int(el)}s ({tc} tool calls)")
                release(sid, k); live.pop(k); done.add(k)
    return (not notes), notes, sids


def gate(task, stage, dry):
    """A human decision point that FAILS CLOSED.

    The previous version waited GATE_WAIT and then proceeded on the recommending phase's own
    recommendation. CLARIFY identified why that is not a gate, and it is the sharpest finding
    of this build:

        The timeout proceeds on the recommender's answer. When the human agrees, it looks
        like it worked. Had they DISAGREED, it would have proceeded on the agent's answer,
        silently overriding them, and nothing would have flagged it.

    So the failure only manifests in exactly the case the gate exists to catch, and a run
    where the human happens to agree produces no evidence the gate works at all. That is a
    control that cannot fail, which is not a control.

    Now: an unresolved gate STOPS THE RUN. It does not guess. A human may pre-authorise a
    fallback with --gate-default, which is a decision they made in advance and is therefore
    theirs; absent that, the pipeline halts and says so.

    Returns True if the gate is resolved and the run may continue.
    """
    print(f"    \u27e8GATE\u27e9 {stage} — raising attention")
    note = degraded_notice(task)
    if note and not dry:
        nf = os.path.join(SP, "_degraded.txt")
        open(nf, "w").write(f"## {stage} gate — what this environment still cannot verify\n{note}")
        tm8(["message", "send", "--to", task, "--body", f"@{nf}",
             "--mutation-id", f"cb3-degraded-{stage}-{int(time.time())}", "--format", "json"],
            check=False)
    if dry:
        return True
    tm8(["entity", "attention", task, "--reason", f"CodeBrain v3: {stage} needs a decision",
         "--points", "80", "--format", "json"], check=False)
    t0 = time.time()
    base = sql("select now()")[0][0]
    while time.time() - t0 < GATE_WAIT:
        # A human is an author that is NOT a team_member. An agent cannot satisfy this, by
        # design — including an agent faithfully relaying a human's answer. That relay is a
        # real need, but it must arrive on an attributable channel, not by an agent posting.
        if sql(f"""select 1 from public.messages m
                     join public.entities e on e.id=m.author_id
                    where m.anchor_id='{q(task)}' and m.created_at > timestamptz '{q(base)}'
                      and e.kind <> 'team_member' limit 1"""):
            print("    \u27e8GATE\u27e9 human answered on the anchor — proceeding")
            return True
        r = relayed_human(task, stage)
        if r:
            bf = os.path.join(SP, "_gate.txt")
            open(bf, "w").write(
                f"## {stage} gate resolved by a RELAYED human decision\n\n"
                f"Not a member-authored message on this anchor. An operator relayed a human's\n"
                f"answer and recorded it with a stated capture method. Recorded here so the\n"
                f"anchor cannot end up asserting both 'a human decided' and 'no human decided'.\n\n"
                f"{r}\n\n"
                f"ATTRIBUTABLE, NOT UNFORGEABLE: an agent could have written that record. What\n"
                f"this guarantees is that the claim is explicit and auditable, not that it is\n"
                f"true. A human answering directly on the anchor remains the stronger path.\n")
            tm8(["message", "send", "--to", task, "--body", f"@{bf}",
                 "--mutation-id", f"cb3-gate-relay-{stage}-{int(time.time())}",
                 "--format", "json"], check=False)
            print(f"    \u27e8GATE\u27e9 resolved by RELAYED human decision (attributable, not unforgeable)")
            return True
        time.sleep(POLL)

    if GATE_DEFAULT:
        bf = os.path.join(SP, "_gate.txt")
        open(bf, "w").write(
            f"## {stage} gate — unresolved, proceeding on the PRE-AUTHORISED default\n\n"
            f"No human decision arrived within {GATE_WAIT}s. Proceeding on the fallback a human\n"
            f"set in advance with --gate-default: **{GATE_DEFAULT}**.\n\n"
            f"This is not the recommending phase's own answer. That distinction is the whole\n"
            f"point: a timeout that resolves on the recommender's recommendation cannot ever\n"
            f"contradict it, so it would never catch the case a gate exists for.\n")
        tm8(["message", "send", "--to", task, "--body", f"@{bf}",
             "--mutation-id", f"cb3-gate-{stage}-{int(time.time())}", "--format", "json"], check=False)
        print(f"    \u27e8GATE\u27e9 no answer — proceeding on pre-authorised default: {GATE_DEFAULT}")
        return True

    bf = os.path.join(SP, "_gate.txt")
    open(bf, "w").write(
        f"## {stage} gate UNRESOLVED — run halted\n\n"
        f"No human decision arrived within {GATE_WAIT}s and no --gate-default was set.\n\n"
        f"The conductor is NOT proceeding on {stage}'s own recommendation. Doing so would mean\n"
        f"the timeout can only ever agree with the phase that asked, which makes the gate\n"
        f"incapable of catching the one case it exists for: a human who disagrees.\n\n"
        f"To continue: answer on this anchor as a human, or re-run the conductor with\n"
        f"--gate-default <option> to pre-authorise a fallback.\n")
    tm8(["message", "send", "--to", task, "--body", f"@{bf}",
         "--mutation-id", f"cb3-gate-halt-{stage}-{int(time.time())}", "--format", "json"], check=False)
    print(f"    \u27e8GATE\u27e9 UNRESOLVED — halting the run (fail closed)")
    return False


RUNFILE = os.path.join(SP, "_run.json")


def run_state(task, reset=False):
    """Persist the run's start time so a restarted conductor resumes instead of re-spending.

    Without this, `run_start = now()` on every invocation means a conductor that crashes
    (mine crashed twice on its first live run) re-spawns every phase that already reported.
    The graph already holds the truth; this file only remembers WHEN the run began, which is
    the one fact the graph cannot supply.
    """
    if not reset and os.path.exists(RUNFILE):
        d = json.load(open(RUNFILE))
        if d.get("task") == task:
            return d
    d = {"task": task, "started": sql("select now()")[0][0], "stages": {}}
    json.dump(d, open(RUNFILE, "w"), indent=1)
    return d


def record(state, stage, **kw):
    state["stages"].setdefault(stage, {}).update(kw)
    json.dump(state, open(RUNFILE, "w"), indent=1)


def metrics(task, state):
    """Measure the run instead of rating it by impression.

    Every number here is read from the graph or the transcript, not estimated: wall-clock per
    stage, output tokens per stage, and how many members declared completion versus merely
    posted. A pipeline whose value cannot be measured cannot be honestly rated.
    """
    rows = []
    for stage, d in state["stages"].items():
        toks = 0
        for sid in d.get("sessions", []):
            r = tm8(["session", "transcript", sid, "--limit", "1", "--format", "json"], check=False)
            # A terminated session can report outputTokens: null, and `int + None`
            # crashed the whole metrics table at the very end of a completed run.
            toks += (r.get("stats") or {}).get("outputTokens") or 0
        rows.append((stage, d.get("secs", 0), len(d.get("sessions", [])),
                     d.get("promised", 0), d.get("flagged", 0), toks))
    return rows


def preflight(task, repo_path, dry=False):
    """Probe the environment and turn every gap into a gate.

    The clinfolio run made thirteen ratified decisions and asked for access ZERO times, while
    silently working around six missing capabilities. The worst was email: the fix for a
    silently-failing OTP send could only be tested by monkeypatching, because no provider
    exists here — and nobody was told at a gate.

    A BLOCKER halts the run. A DEGRADED item does not, but it is recorded and MUST be
    restated in the readiness report, because a claim that was never checkable must never be
    reported as checked.
    """
    import subprocess as sp
    r = sp.run([sys.executable, os.path.join(SP, "preflight.py"), repo_path],
               capture_output=True, text=True)
    report = r.stdout
    print(report)
    bf = os.path.join(SP, "_preflight.txt")
    open(bf, "w").write(report)
    if not dry:
        tm8(["message", "send", "--to", task, "--body", f"@{bf}",
             "--mutation-id", f"cb3-preflight-{int(time.time())}", "--format", "json"], check=False)
    return r.returncode != 2   # rc 2 == at least one BLOCKER


def degraded_notice(task):
    """The DEGRADED list, restated at every later gate. Absence of a check is not a pass."""
    p = os.path.join(SP, "_preflight.json")
    if not os.path.exists(p):
        return ""
    d = json.load(open(p))
    deg = {k: v for k, v in d.items() if v.get("status") == "DEGRADED"}
    if not deg:
        return ""
    lines = ["", "## STILL UNVERIFIABLE IN THIS ENVIRONMENT — restated from PREFLIGHT", ""]
    for k, v in deg.items():
        lines.append(f"- **{k}** — {v['detail'][:150]}")
        if v.get("ask"):
            lines.append(f"  - to close it: {v['ask'][:150]}")
    lines += ["", "Any claim resting on these is UNPROVEN, not proven. Say so in the report.", ""]
    return "\n".join(lines)


def read_depth(task):
    """Scan ALL of TRIAGE's messages, not just the latest.

    A phase's last message is usually "done, standing by" — not its report. Reading only
    the newest message silently returns the default, which here would downgrade a `full`
    routing to `standard` and quietly skip the security lenses. Silent downgrade is the
    worst possible failure for a routing decision, so scan every message and take the
    first that actually states a routing.
    """
    rows = sql(f"""select replace(body,E'\t',' ') from public.messages
                    where anchor_id='{q(task)}' and author_id='{q(M["triage"])}'
                    order by created_at asc""")
    for (body,) in [(r[0],) for r in rows]:
        low = body.lower()
        if "depth routing" not in low:
            continue
        tail = low.split("depth routing", 1)[1][:200]
        for d in ("full", "standard", "direct"):
            if d in tail:
                return d
    raise SystemExit("TRIAGE has not posted a depth routing on this anchor — run TRIAGE "
                     "first. Defaulting would silently pick a rigour level nobody chose.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task")
    ap.add_argument("--brief-dir", default=SP)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--project", default=None, help="projects.id for the worktree")
    ap.add_argument("--restart", action="store_true", help="forget prior run state")
    ap.add_argument("--force", action="store_true", help="re-run stages already complete on the anchor")
    ap.add_argument("--gate-default", default=None, help="human-preauthorised fallback if a gate times out")
    ap.add_argument("--repo", default=None, help="path to probe in PREFLIGHT")
    ap.add_argument("--ignore-blockers", action="store_true", help="proceed despite PREFLIGHT blockers")
    ap.add_argument("--max-iterations", type=int, default=MAX_ITERATIONS)
    a = ap.parse_args()

    def brief_of(k):
        p = os.path.join(a.brief_dir, f"brief-{k}.txt")
        # The decision block is CONCATENATED, never paraphrased. This is the fix for the relay:
        # no agent, including me, retypes a human's decision on its way to the code.
        d = decisions(a.task)
        # CLARIFY's last finding: a copy in the brief plus a hash of the FILE verifies the
        # object that cannot drift instead of the one that can. A concatenation bug corrupts
        # the copy, the file stays pristine, the recompute passes, and the phase proceeds on a
        # wrong decision block holding a green check.
        #
        # So do not copy. There is now exactly ONE object: the file. The brief REFERENCES it
        # and the phase must read it. One object cannot disagree with itself, and the hash
        # covers the thing actually acted on.
        import hashlib
        sha = hashlib.sha256(d.encode()).hexdigest()[:16] if d else ""
        head = (f"## HUMAN DECISIONS — read them from the file, do not work from any quote\n\n"
                f"A human decided this run's open questions. The decisions are NOT reproduced\n"
                f"here, deliberately: a copy can drift from the original and a hash of the\n"
                f"original would not catch it. There is one object and you must read it.\n\n"
                f"    sha256sum {decisions_path(a.task)} | cut -c1-16   # must print {sha}\n"
                f"    cat {decisions_path(a.task)}\n\n"
                f"If the hash does not match, STOP and report on the anchor: the decision record\n"
                f"has been altered and nothing downstream of it can be trusted. If it matches,\n"
                f"the file is what a human decided — follow it exactly and quote it verbatim.\n\n"
                f"{'-'*70}\n\n") if d else ""
        return head + (open(p).read() if os.path.exists(p) else (
            f"Run your phase ({k}) for CodeBrain v3 on this task. Follow your identity "
            f"exactly. Read the reports already on this anchor from the phases before you — "
            f"and where an explorer named files, READ THE FILES, not their summary. "
            f"Post your report to this anchor and stop."))

    global PROJECT, GATE_DEFAULT
    if a.project: PROJECT = a.project
    if a.gate_default: GATE_DEFAULT = a.gate_default
    state = run_state(a.task, reset=a.restart)
    run_start = state["started"]

    # TRIAGE must run BEFORE depth can be read — it is the phase that decides the depth.
    # read_depth() sat above the loop, so on a FRESH task the conductor halted with
    # "TRIAGE has not posted a depth routing" and could never bootstrap itself. Halting
    # rather than defaulting was right; doing it before running the phase that answers
    # the question was not.
    if not a.force and "triage" not in ledger(a.task):
        print("[T] TRIAGE  (1 member)")
        t0 = time.time()
        ok, notes, sids = run_stage("TRIAGE", ["triage"], a.task, brief_of, a.dry_run)
        record(state, "TRIAGE", secs=int(time.time() - t0), sessions=sids,
               promised=1 - len(notes), flagged=len(notes))
        if not a.dry_run:
            mark_done(a.task, "triage"); clear_inflight(a.task, "triage")
        if notes:
            print(f"    escalations: {notes}")

    depth = read_depth(a.task)
    print(f"run started {run_start}" + ("  (resumed)" if state["stages"] else ""))
    plan = [s for s in STAGES if s[0] in DEPTH[depth]]
    print(f"task {a.task}\ndepth {depth} -> {[s[0] for s in plan]}\n")

    if a.repo:
        print("[0] PREFLIGHT — probing the environment")
        if not preflight(a.task, a.repo, a.dry_run) and not a.ignore_blockers:
            print("\n\u27e8GATE\u27e9 PREFLIGHT found BLOCKERS — halting. A phase that cannot run "
                  "the tests cannot produce evidence.\n         Supply the access, or re-run with "
                  "--ignore-blockers to proceed with those claims marked UNPROVEN.")
            return 1

    it = 0
    for name, keys, is_gate in plan:
        it += 1
        if it > a.max_iterations:
            print(f"🛑 max-iterations ({a.max_iterations}) reached — stopping"); break
        # Already done in a previous run of the conductor? Then skip, do not re-spend.
        keys = members_for(depth, name, keys)
        if not a.force and all(ever_completed(a.task, M[k], k, a.task) for k in keys):
            print(f"[{it}] {name} already complete on this anchor — skipping (use --force to re-run)")
            continue
        print(f"[{it}] {name}  ({len(keys)} member(s))")
        t_stage = time.time()
        ok, notes, sids = run_stage(name, keys, a.task, brief_of, a.dry_run)
        record(state, name, secs=int(time.time() - t_stage), sessions=sids,
               promised=len(keys) - len(notes), flagged=len(notes))
        for k in keys:
            mark_done(a.task, k); clear_inflight(a.task, k)   # the conductor accepted this phase; never re-spend on it
        if notes:
            print(f"    escalations: {notes}")
        if is_gate and not gate(a.task, name, a.dry_run):
            print("\nrun halted at an unresolved gate — nothing downstream was spawned")
            break
        if name == "SHIP" and not a.dry_run:
            if "<promise>RUN COMPLETE</promise>" in last_body(a.task, M["ship"]):
                print("\n✅ <promise>RUN COMPLETE</promise> — run finished"); return 0
            print("\n⚠ SHIP did not give the promise. The run is NOT complete; read its "
                  "report for what is unmet. This is a legitimate ending, not a failure.")
    print("\n=== measured ===")
    print(f"{'stage':<11}{'secs':>7}{'agents':>8}{'promised':>10}{'flagged':>9}{'out-tokens':>12}")
    tot = [0, 0, 0]
    for stage, secs, n, pr, fl, toks in metrics(a.task, state):
        print(f"{stage:<11}{secs:>7}{n:>8}{pr:>10}{fl:>9}{toks:>12}")
        tot[0] += secs or 0; tot[1] += n or 0; tot[2] += toks or 0
    print(f"{'TOTAL':<11}{tot[0]:>7}{tot[1]:>8}{'':>10}{'':>9}{tot[2]:>12}")
    print("\nconductor finished — see anchor for state")
    return 0


if __name__ == "__main__":
    sys.exit(main())
