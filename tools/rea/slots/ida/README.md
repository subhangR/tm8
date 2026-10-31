# IDA Pro slot (licensed, owner-supplied)

REA uses IDA through its headless profile: `idalib-mcp` from mrexodia/ida-pro-mcp (pinned,
already built into `bridge/`) driving the owner's IDA Pro 9.x through idalib. Nothing here
is downloaded from Hex-Rays; the installer and licence come from you.

## What to drop, and where

Copy into `/home/tm8/rea-lab/engines/ida/drop/` on tm8-server, over scp or sftp only:

| File | Notes |
| --- | --- |
| the IDA Pro **Linux** installer, `*.run` (9.0 or newer) | or an already-installed IDA folder (one holding `idalib/python`) |
| your licence, `*.hexlic` | a named/computer licence file. A floating licence needs a licence server, and the sandbox has no network |
| optional: `ida.reg` | only if setup reports that IDA wants its EULA accepted: copy `~/.idapro/ida.reg` from a machine where this IDA version has run once |

```sh
scp ida-pro_9x_x64linux.run your-licence.hexlic tm8@<tm8-server>:/home/tm8/rea-lab/engines/ida/drop/
ssh tm8@<tm8-server> chmod 0600 '/home/tm8/rea-lab/engines/ida/drop/*'
```

Never paste a licence into a tm8 message, task, doc or chat, and never commit it.

## Then

```sh
/home/tm8/rea-lab/bin/rea-sandbox setup ida
/home/tm8/rea-lab/bin/rea-sandbox engines        # ida -> ready
```

`setup ida` runs inside the sandbox (gVisor, no network) with only this slot writable. It
installs IDA into `install/`, adds IDA's own `idapro` package to the bridge, writes
`rea-ida-mcp.json` (REA's headless registration), and writes `READY` only after REA has
analysed a fixture binary through IDA and returned IDA-attributed Evidence. Exit codes: 0
ready, 2 still waiting for your files, 1 failed (logs in
`/home/tm8/rea-lab/cases/setup-ida/out/setup-ida/`).

Once ready, IDA is mounted read-only into the **static** profile only: no sandbox that runs
a target ever sees the licence. Roles that get it: native, and the human `all` role.
