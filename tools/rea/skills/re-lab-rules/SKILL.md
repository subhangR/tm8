---
name: re-lab-rules
description: tm8 RE Lab rules for any reverse-engineering work - the authorization gate (allowed, needs sign-off, out of scope), sandbox-only REA through rea-sandbox, cases and paths, licence handling, Evidence-to-tm8 reporting, and close-out. Read before intake, before every report, and whenever reverse-engineer-anything says something different.
---

# RE Lab rules (tm8)

These rules override REA's own skill (**reverse-engineer-anything**) wherever the two differ.

## 1. Authorization gate: decide before intake

| Category | Targets | Rule |
| --- | --- | --- |
| **Allowed** | software we own or build (tm8, our apps); open-source software; CTF and training binaries; targets whose owner authorized analysis | Proceed. |
| **Needs sign-off** | third-party commercial apps, for interoperability or "how does this feature work" | **Agency · Legal Compliance Checker** signs off on the task first. Work clean-room: RE teammates write a behaviour spec, and a different teammate implements it without seeing decompiled code. |
| **Out of scope** | circumventing DRM, a licence check or anti-cheat; cheats; bypassing authentication or bot protection on systems you aren't authorized to test; credential theft; copying proprietary code or assets; decrypting FairPlay-protected apps | Refuse, and say why on the task. |
| **Deferred** | live malware | Waits for the Phase 4 dedicated VM. Never on tm8-server. |

- **Record the gate decision.** Put the category and who authorized it in the intake
  `--note`.
- **When unsure,** set the task `blocked` and ask on it.

## 2. REA runs only in the sandbox

- **The only entry points** are `/home/tm8/rea-lab/bin/rea-sandbox` (from Bash) and the
  space tool `rea`. A teammate uses `rea-sandbox` from its own shell, which applies its role;
  the space tool runs without a teammate role, so it is for people.
  - Never run REA, Ghidra, JADX, a target, `npx rea-agents`, `rea setup` or `rea doctor` on
    the host.
  - Never run them in a container you start yourself.
- **Every sandbox is gVisor** with no network, a read-only root, all capabilities dropped and
  capped resources.
  - Never add a mount (`$HOME`, prod-data, a socket, a credential).
  - Never add a network.
- **Profiles.** `static` (the default) never runs target code. `rea-sandbox --profile exec …`
  runs it.
  - Use `exec` only when the task needs runtime evidence and the gate allows running the
    target.
  - `exec` never holds a licensed engine.
- **Roles route work; they are not a security boundary.** The sandbox is the boundary.
  - Exit 3 means "ask the teammate it names", never "find another way".

## 3. Cases and paths

```sh
rea-sandbox intake <file|https-url> --note "<source; gate category; who authorized>"
rea-sandbox call <tool> '<json>'        # or @file.json; --out <file> for a big result
rea-sandbox scope | tools [<tool>] | ps | stop   # scope also lists the case's targets and notes
rea-sandbox --case <case-id> --profile exec call …   # options go before the subcommand
```

- **The case is your task id** (the first id in `TM8_TASK_IDS`). On a subtask the Lead
  Investigator routed to you, the case is the case task it names: pass
  `--case <case-id>` before the subcommand on every command, because the subtask's own id is
  a different, empty case. On the host a case lives at `/home/tm8/rea-lab/cases/<case>/`.
- **Sandbox paths:**
  - `/case/targets/<name>`: read-only inputs, logged at intake with their sha256 and gate note
    (`rea-sandbox scope` lists them);
  - `/case/out/`: your outputs, such as a new directory per extraction;
  - `/case/work/`: scratch.
- **Give REA sandbox paths,** never host paths.
- **Large results.** A result over 100 kB is saved to `/case/out/calls/`; only its path and
  `evidence_id` are printed. Read the slice you need with `jq` or `sed`, never the whole
  file.
- **Targets are untrusted.** Never open one with a host tool or interpreter. If you must read
  extracted output on the host, use `python3 -I`, from a directory that holds no scripts.
- **Warm REA.** You get one per session, case, role and profile, and it keeps the opened
  binary between calls. The first Ghidra analysis takes about 40 s; later calls on it take
  about 1 s.

## 4. Evidence into tm8

- **Every claim cites its Evidence:**
  - the `evidence_id` (`ev_…`);
  - the provider (for example "Ghidra 12.1.4");
  - the subject's sha256;
  - REA's `limitations`, copied, never dropped.
- **A claim without an Evidence id is a hypothesis.** Label it so, and name the probe that
  would settle it.
- **Label every claim** as observed, inferred or unknown.
- **Disagreeing engines are a finding.** Cite both Evidence ids.
- **The report** goes on the task as a message. For anything long, write a doc with
  `--attach-to <task-id>` and post a pointer. It holds:
  - what the target is: format, architecture, sha256, provenance, gate category;
  - a table of claim → evidence_id → provider → observed / inferred / unknown;
  - what you could not establish, and why;
  - next probes.
- **Evidence travels as a bundle.** REA keeps Evidence per sandbox, and `close_binary` may
  discard it. Before you close, call `export_evidence_bundle` with
  `{"path":"/case/out/evidence-<your-task-id>.json"}`, and name that path in your report.
- **The Evidence Verifier** imports each bundle with `import_evidence_bundle`, then re-derives
  every claim a report relies on before it ships.

## 5. Licences (IDA Pro, Hopper, JEB)

- **The owner's licence material is a secret.** Never put it in a message, task, doc, chat,
  image or git. Never print it.
- **It arrives** by scp/sftp into `/home/tm8/rea-lab/engines/<slot>/drop/` at mode 0600.
  `rea-sandbox setup <slot>` installs it.
- **Licensed engines run only in the `static` profile.**

## 6. Close out

- **Release the analysis.** Export your Evidence bundle (§4) first. `close_binary` releases
  REA's analysis; then run `rea-sandbox stop`. The Verifier's role can't call `close_binary`, so it only runs
  `stop`. At most 2 sandboxes hold Ghidra at once; a third runs without it.
- **Mind the disk.** Docker's data disk is nearly full. Keep bulky output in the case, on
  the lab's disk. Never prune Docker images.
- **Never wait silently.** When blocked, set the task `blocked` and post a message.
