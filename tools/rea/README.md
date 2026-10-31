# tools/rea — REA (rea-agents) for tm8's RE Lab

[REA](https://github.com/morluto/rea) is a reverse-engineering MCP server and CLI. It
returns cited Evidence (`ev_…`, with the provider, the subject's sha256 and its limitations)
for native binaries, mobile apps, firmware, web/JS, pcaps and more. This folder runs it for
tm8 teammates on tm8-server. **REA never runs on the bare host.** Every REA process starts
in a fresh gVisor container that `rea-sandbox` launches.

The plan and the measured Phase 0 results are tm8 docs 01a191e9 (plan) and 01a1925e
(spike). Licensed-engine intake is tm8 doc 01a192bd.

## The sandbox

Every container gets:

- the gVisor runtime (`runsc`);
- `--network none`;
- a read-only root;
- all capabilities dropped and `no-new-privileges`;
- capped CPU, memory and pids (`limits` in `rea-sandbox.json`);
- a `noexec` tmpfs at `/tmp`;
- a fixed hostname and machine-id.

Only the case is mounted:

- `targets/` read-only;
- `out/` and `work/` writable.

Engines are mounted read-only at `/engines`. Nothing from `$HOME`, prod-data or any socket
is mounted.

**Profiles** keep licences away from target code:

| Profile | Use | Engines | Target execution |
| --- | --- | --- | --- |
| `static` (default) | analysis | every ready engine, including the owner's IDA / Hopper / JEB | refused (REA's `executesForeignCode` tools) |
| `exec` | process capture, GDB, Rizin debug, browser | no licensed or heavy engines | allowed, from an executable tmpfs at `/exec` |
| `run` (`cli`) | REA's CLI, unfiltered | no licensed engines | whatever the CLI does |

**Roles** come from `<lab>/etc/members.json`, which maps a tm8 team member to a role. That
file is per space and never committed. A role decides which REA tool families and engines a
teammate gets:

| Role | Engines |
| --- | --- |
| lead | none |
| native | ghidra, kuna, rizin, pwntools, pwndbg, ida, hopper |
| mobile | jadx, apktool, kuna, jeb |
| web | wabt, chromium |
| firmware | binwalk, unblob, rizin, kuna, ghidra, pwntools |
| verifier | kuna, ghidra, rizin, jadx, apktool, wabt, binwalk, pwntools, pwndbg; no tool that runs, mutates or discards |
| all | everything (the human / default) |

REA 6.8.0 can't filter tool families itself. `mcp` and `call` therefore filter
`tools/list`, and they refuse an out-of-scope `tools/call` with a routing hint. Roles route
work between teammates; they are not a security boundary. The sandbox is the boundary.

## Commands

```sh
rea-sandbox intake <file|dir|https-url>... --note "<source; gate category; who authorized>"
                                             # copy into the case's targets/ (read-only; sha256 and note logged)
rea-sandbox call <tool> '<json>'             # one tool call in this session's warm REA for the case
                                             # (json may be @file or -; --out <file> for a big result)
rea-sandbox tools [<tool>...]                # what this role may call; with names, the schemas
rea-sandbox run -- <rea args>                # one REA CLI command
rea-sandbox mcp                              # stdio MCP server for an MCP client
rea-sandbox doctor [provider]                # `rea doctor --json` with this session's engines
rea-sandbox engines                          # every engine slot: missing / present / ready
rea-sandbox setup ida|jeb|hopper             # install the owner's licensed engine and prove it
rea-sandbox jeb <target>                     # start JEB's MCP server in this session's container
rea-sandbox scope | ps | stop                # what I may do and the case's targets / running sandboxes / end my warm REAs
```

Options go before the subcommand: `rea-sandbox --case <case> --role <role> --profile exec call …`.

Exit status:

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | REA answered with an error (`isError`), or REA did not list a tool you named |
| 2 | bad input, a tool REA doesn't have, a refused `--role`, or REA unreachable or not installed |
| 3 | the tool is outside this role or profile. The message names the teammate who has it, and no warm REA starts. |

How the case and the warm REA are chosen:

- The case is `--case <name>`, else the first id in `TM8_TASK_IDS`, else
  `session-<TM8_SESSION_ID>`, else `adhoc`. It lives at `<lab>/cases/<case>/{targets,out,work}`.
- `intake` logs each target's sandbox path, sha256, size and `--note` to `work/intake.jsonl`,
  and `scope` lists them under `targets`.
- A **warm REA** is one long-lived container per session, case, role and profile. REA keeps
  the opened binary between calls, and the container stops after `mcp_idle_seconds` idle.
- A call for one case never reaches another case's warm REA.
- At most `ghidra_slots` (2) containers hold Ghidra at once. A third runs without it, and
  Kuna and Rizin still work.

## Files

| File | What it is |
| --- | --- |
| `rea-sandbox` | the launcher (Python, stdlib only) |
| `rea-sandbox.json` | lab path, image, limits, engines, roles |
| `catalog-6.8.0.json` | REA 6.8.0's 229 tools with family and effects, as REA itself reports them |
| `Dockerfile`, `bin/` | the image `tm8/rea:6.8.0`. Base pinned by digest, REA by npm integrity, sasquatch by sha256. Runs as uid 110 |
| `install.sh` | puts the launcher, config and licensed-engine slots in place. With `--build`, also builds the image |
| `fetch-engines.sh` | Ghidra, JADX MCP, apktool, Kuna, Rizin and WABT from their releases, each checked against a pinned sha256 |
| `build-engines.sh` | engines with no usable release binary: firmware (Binwalk, Unblob), python (pwntools, pwndbg), browser (Chromium), ida (the IDA MCP bridge) |
| `slots/{ida,jeb,hopper}/` | README and `setup.sh` for each licensed engine |
| `mcp-probe.py` | drives `rea-sandbox mcp` as an MCP client and records each answer |
| `escape-probe.sh` | checks from inside a static and an exec sandbox that nothing of the host is reachable ([below](#escape-probe)) |
| `tm8-tool/` | the space tool `rea`: `rea.sh` and its `spec.json` ([below](#the-space-tool-rea)) |
| `skills/` | builds the two tm8 space skills ([below](#skills)) |
| `teammates/` | the RE Lab teammates' personas and their builder ([below](#teammates)) |

## Install on a host

```sh
tools/rea/install.sh --build               # launcher + config + slots, and the image
tools/rea/fetch-engines.sh                 # release-binary engines (~730 MB of downloads)
tools/rea/build-engines.sh firmware        # and: python, browser, ida
/home/tm8/rea-lab/bin/rea-sandbox engines  # each free engine -> ready
```

Each step is idempotent. The lab (`/home/tm8/rea-lab`) and Docker's data must have room:

- engines: about 3 GB on the lab's disk;
- the image: about 2.1 GB unpacked on Docker's disk.

## Escape probe

```sh
tools/rea/escape-probe.sh [case]   # default case: escape-probe, removed afterwards
```

It starts a static and an exec warm REA for a throwaway case, then runs its checks inside each
container with `docker exec`:

- no host path (`$HOME`, prod-data, the lab, `/opt/tm8`) and no container-runtime socket is
  visible;
- the network is loopback only: no DNS, and every outside, metadata, bridge or host address is
  unreachable;
- root, targets and engines are read-only, and `/tmp` is `noexec`;
- every capability is dropped.

It prints one line per check and exits 1 if any check fails. Run it after any change to the
launcher, its config or the image.

## The space tool `rea`

`tm8-tool/` is tm8's space tool `rea`: `rea.sh` runs `rea-sandbox`, and `spec.json` holds its
inputs and help. Register it once per space, from `tm8-tool/`:

```sh
tm8 tool create rea --runtime bash --source @rea.sh --spec @spec.json --description "…" --when-to-use "…"
```

The tool is for people. A tool run carries no teammate id, so `members.json` does not apply:
its role is `--role`, or `all`. Teammates call `rea-sandbox` from their own shell instead,
which applies their role. The tool's runs on one case, role and profile share a warm REA.

## Skills

Two tm8 space skills, equipped on the RE Lab group so every member inherits them:

| Skill | What it is |
| --- | --- |
| `reverse-engineer-anything` | REA's own skill, word for word, checked against its sha256 in `build-skills.py`. On top is `tm8-preamble.md`. Its "Connect only when needed" section is replaced by `tm8-connect.md`, its reference links point at the copy on the host, and REA's MIT notice is appended. |
| `re-lab-rules` | `skills/re-lab-rules/SKILL.md`: the authorization gate, sandbox-only REA, cases and paths, Evidence reporting, licences and close-out. It wins wherever the two differ. |

Build both into `<lab>/build/skills/<name>.json`. The first run copies REA's skill and licence
out of the image into `<lab>/share/rea-agents-<version>`, read-only:

```sh
tools/rea/skills/sync-skills.sh
```

Create each skill once, then equip both on the group:

```sh
tm8 entity create skill <name> --parent none --content @<lab>/build/skills/<name>.json
tm8 skill equip <skill-id> --teammate <re-lab-group-id>
```

To update a skill, write only its `description` and `content` to a JSON file (a skill update
accepts no other field), then run
`tm8 entity update <skill-id> --expect-version <n> --content @<file>`.

Agents read the skills with `tm8 skill show <skill-id> 2>/dev/null | jq -r .content.content`.
Two other routes don't work:

- the harness's Skill tool doesn't have tm8 space skills;
- the load pointer in a session's context index prints only a header (tm8 follow-up
  01a192fe-2b0d).

Every persona therefore says how to read them (`teammates/load-skills.md`).

## Teammates

`teammates/` holds the RE Lab's seven tm8 teammates:

| Persona | Teammate | `rea-sandbox` role | Mode |
| --- | --- | --- | --- |
| `group.md` | RE Lab (the group) | lead | coordinator |
| `lead.md` | RE · Lead Investigator | lead | coordinator |
| `native.md` | RE · Native Binary Analyst | native | worker |
| `mobile.md` | RE · Mobile Analyst | mobile | worker |
| `web.md` | RE · Web & Electron Analyst | web | worker |
| `firmware.md` | RE · Firmware & Protocol Analyst | firmware | worker |
| `verifier.md` | RE · Evidence Verifier | verifier | worker |

`build-teammates.py <rea-sandbox.json> <out-dir>` fills each persona's placeholders and writes
`<out-dir>/<name>.json`, which holds the title, the role and the `content` to create the
teammate with. Placeholders are filled from two places:

- `{{team}}`, `{{gate}}`, `{{specialist-work}}` and `{{load-skills}}`, from the `.md` file of
  that name;
- `{{families}}` and `{{engines}}`, from the persona's own role in `rea-sandbox.json`, and
  `{{families:<role>}}`, from any role.

So a persona always states the scope that `rea-sandbox` enforces. The script writes nothing if
a placeholder is left over.

Create the group as a root and each specialist under it, from the `content` object of its
`.json`:

```sh
tm8 entity create team_member "RE Lab" --parent none --content @group.content.json
tm8 entity create team_member "<title>" --parent <group-id> --content @<name>.content.json
```

After a persona change, rebuild, then update only the identity: put `{"identity": …}` in a
file and run `tm8 entity update <id> --expect-version <n> --content @<file>`. The update merges,
so the teammate keeps its model and mode.

Map each teammate's id to its role in `<lab>/etc/members.json`. That file is per space and is
never committed. A teammate's session then gets its role from `TM8_TEAM_MEMBER_ID`, and a
mapped teammate can't widen it with `--role` (exit 2).

Besides the two skills above, the group also carries `security-audit`, and the Lead
Investigator and the Evidence Verifier carry `grounded-citations`.

## Licensed engines (IDA Pro, Hopper, JEB)

The owner's files go to `<lab>/engines/<slot>/drop/` over scp/sftp, and then
`rea-sandbox setup <slot>` installs them. Each slot's README says exactly what to drop. A
slot becomes `ready` only after REA has analysed a fixture through that engine.

Licences never enter an image (`.dockerignore`), git (`.gitignore`) or a tm8 message, and
they are mounted only in the static profile.
