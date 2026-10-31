# JEB slot (licensed, owner-supplied)

REA talks to JEB through JEB's own MCP server on loopback (`127.0.0.1:8425`), started
headless inside the analysing sandbox (REA docs/jeb-analysis.md). REA never installs JEB.

## What to drop, and where

Copy into `/home/tm8/rea-lab/engines/jeb/drop/` on tm8-server, over scp or sftp only:

| File | Notes |
| --- | --- |
| your JEB **Linux** build, `*.zip` | or the unpacked JEB folder (one holding `bin/app/jeb.jar`). It must list `--mcp` in `java -jar bin/app/jeb.jar -c --help` (REA verified 5.48.0.202610071539) |
| your licence key | you type it at JEB's own prompt during interactive setup; do not drop it as a file |

```sh
scp jeb-pro.zip tm8@<tm8-server>:/home/tm8/rea-lab/engines/jeb/drop/
ssh tm8@<tm8-server> chmod 0600 '/home/tm8/rea-lab/engines/jeb/drop/*'
```

Never paste a licence key into a tm8 message, task, doc or chat, and never commit it.

## Then, from a terminal on tm8-server

```sh
/home/tm8/rea-lab/bin/rea-sandbox setup jeb --interactive   # answer JEB's EULA and licence prompts
/home/tm8/rea-lab/bin/rea-sandbox engines                   # jeb -> ready
```

`setup jeb` unpacks JEB into `install/`, starts its MCP server on a fixture, and writes
`READY` only once REA's `inspect-jeb-client` has reached it. JEB keeps its activation in
`install/bin/`; the sandbox has no network, so activation must work offline. Exit codes:
0 ready, 2 still waiting for your files, 1 failed (logs in
`/home/tm8/rea-lab/cases/setup-jeb/out/setup-jeb/`).

Once ready, JEB is mounted read-only into the **static** profile only. A session starts it
for a target with `rea-sandbox jeb <target>` while its REA is warm, then uses REA's JEB tools
(`inspect_jeb_client`, `list_jeb_units`, `decompile_jeb_item`, ...). Roles that get it:
mobile, and the human `all` role.
