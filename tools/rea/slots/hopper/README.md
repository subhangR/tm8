# Hopper slot (licensed, owner-supplied)

REA drives Hopper on Linux through `HOPPER_LAUNCHER_PATH` and runs it on a private Xvfb
display (REA docs/installation.md#hopper). REA validates its unattended Linux path against
Hopper's demo mode; a licensed installation is supported, but activating the licence is the
operator's job, not REA's. Nothing here is downloaded from the vendor.

## What to drop, and where

Copy into `/home/tm8/rea-lab/engines/hopper/drop/` on tm8-server, over scp or sftp only:

| File | Notes |
| --- | --- |
| Hopper's **Linux** package for Ubuntu, `*.deb` | or an unpacked Hopper folder (one holding `bin/Hopper`). The image is Debian 13 |
| your activated Hopper user state, as `home/` | activate Hopper once on any Linux desktop, then copy the folders Hopper created under your home directory (under `~/.config` and `~/.local/share`) into `drop/home/`, keeping their paths: `drop/home/.config/...` |

```sh
scp Hopper-*.deb tm8@<tm8-server>:/home/tm8/rea-lab/engines/hopper/drop/
scp -r hopper-home tm8@<tm8-server>:/home/tm8/rea-lab/engines/hopper/drop/home
ssh tm8@<tm8-server> chmod -R go-rwx /home/tm8/rea-lab/engines/hopper/drop
```

Without `home/` Hopper still works, in the vendor's demo mode and its limits. Never paste
licence material into a tm8 message, task, doc or chat, and never commit it.

## Then

```sh
/home/tm8/rea-lab/bin/rea-sandbox setup hopper
/home/tm8/rea-lab/bin/rea-sandbox engines        # hopper -> ready
```

`setup hopper` unpacks the package into `install/`, keeps `drop/home/` as the slot's `home/`
(restored into each sandbox's fresh `$HOME` by the image's entrypoint), records Hopper's own
binary as `HOPPER_LAUNCHER_PATH` (REA checks it with `ldd`, so it cannot be a script), lists
any library the image lacks, and writes `READY` only after REA has analysed a fixture
through Hopper and returned Hopper-attributed Evidence; it says so if REA reports demo
mode. Exit codes: 0 ready, 2 still waiting for your files, 1 failed (logs in
`/home/tm8/rea-lab/cases/setup-hopper/out/setup-hopper/`).

Once ready, Hopper is mounted read-only into the **static** profile only: no sandbox that
runs a target sees the licence. Roles that get it: native, and the human `all` role.
