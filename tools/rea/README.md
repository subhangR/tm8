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
rea-sandbox intake <file|dir|https-url>...   # copy into the case's targets/ (read-only, sha256 logged)
rea-sandbox call <tool> '<json>'             # one tool call in this session's warm REA for the case
rea-sandbox tools [<tool>...]                # what this role may call; with names, the schemas
rea-sandbox run -- <rea args>                # one REA CLI command
rea-sandbox mcp                              # stdio MCP server for an MCP client
rea-sandbox doctor [provider]                # `rea doctor --json` with this session's engines
rea-sandbox engines                          # every engine slot: missing / present / ready
rea-sandbox setup ida|jeb|hopper             # install the owner's licensed engine and prove it
rea-sandbox jeb <target>                     # start JEB's MCP server in this session's container
rea-sandbox scope | ps | stop                # what I may do / running sandboxes / end my warm REAs
```

How the case and the warm REA are chosen:

- The case is `--case <name>`, else the first id in `TM8_TASK_IDS`, else
  `session-<TM8_SESSION_ID>`, else `adhoc`. It lives at `<lab>/cases/<case>/{targets,out,work}`.
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

## Licensed engines (IDA Pro, Hopper, JEB)

The owner's files go to `<lab>/engines/<slot>/drop/` over scp/sftp, and then
`rea-sandbox setup <slot>` installs them. Each slot's README says exactly what to drop. A
slot becomes `ready` only after REA has analysed a fixture through that engine.

Licences never enter an image (`.dockerignore`), git (`.gitignore`) or a tm8 message, and
they are mounted only in the static profile.
