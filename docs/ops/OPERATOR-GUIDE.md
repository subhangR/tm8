# Running tm8 for other people — the operator guide

For anyone running a tm8 node that more than one person, or more than one
machine, will reach. If tm8 is only ever going to be opened on the machine it
runs on, [`INSTALL.md`](INSTALL.md) is all you need.

The shape is the same everywhere:

```
browser / CLI ──https──▶ reverse proxy (TLS) ──http──▶ tm8 server on 127.0.0.1:17777 ──▶ Postgres on 127.0.0.1:5442
```

tm8 **always binds loopback**. It refuses a non-loopback `TM8_BIND` at boot, and
that is deliberate: the one supported way in from another machine is a proxy that
terminates TLS, with the node in **multi** mode.

---

## 1. Install as a service

Linux (systemd), as root or with passwordless sudo. The `prod` slot installs
from `/opt/tm8/prod`, not from wherever you cloned, so clone there:

```bash
git clone https://github.com/subhangR/tm8.git /opt/tm8/prod
cd /opt/tm8/prod
TM8_PUBLIC_ORIGIN=https://tm8.example.com ./install.sh --env prod --service
```

What that leaves you:

| | |
|---|---|
| service | `tm8-prod.service`, `User=tm8`, `Restart=always` — `journalctl -u tm8-prod -f` |
| env file | `/etc/tm8/prod.env` (0640 root:tm8). Re-runs never overwrite it; `--print-env` shows what a fresh one would hold |
| data | `/var/lib/tm8/prod/data` (blobs, the sealed credential key, the setup token) and `/var/lib/tm8/prod/workspace` |
| database | `tm8_prod` on a cluster on 5442, loopback-only |
| server | `http://127.0.0.1:17777` — nothing else listens until you add the proxy (§3) |

The `prod` env file is written for a shared node:

```bash
TM8_NODE_MODE=multi                              # no loopback auto-owner — §2
TM8_PUBLIC_ORIGIN=https://tm8.example.com        # filled from the installer's env, else a stub
#TM8_ALLOWED_HOSTNAMES=
#TM8_ALLOWED_ORIGINS=https://tm8.example.com
#TM8_PROJECT_ROOTS=/srv/tm8/projects
```

The installer warns while `TM8_PUBLIC_ORIGIN` is unset or the mode is not
`multi`. After editing the file: `systemctl restart tm8-prod`.

MCP connectors that need a preregistered confidential OAuth client (Slack) read
its secret from a `TM8_MCP_CLIENT_SECRET_*` variable in this file, and their OAuth
redirect is `TM8_PUBLIC_ORIGIN` + `/mcp/oauth/callback`; see
[mcp-connectors.md](../mcp-connectors.md#directory-providers).

Ports already taken (another Postgres on 5442, another service on 17777)?
`--pg-port <n>` and `--port <n>` move the slot. A Postgres the installer did not
create is never adopted silently — see [INSTALL.md](INSTALL.md#a-cluster-already-on-the-port).

### The agent login belongs to the service user

A session running on the **node's own** credential runs `claude` or `codex` as
the OS user the service runs as — `tm8`, whose HOME is not yours. Logging in
as root, or as yourself, does nothing for it. Log in as that user:

```bash
sudo -u tm8 -H claude auth login     # or: sudo -u tm8 -H codex login
sudo -u tm8 -H claude auth status    # {"loggedIn": true, …}
```

(The `tm8` account's HOME is the checkout, `/opt/tm8/prod`, so the login lands
in the checkout: `.claude.json` and `.codex/` are gitignored, and `.claude/`
shows as an untracked directory. Leave it there. `git clean` would log the node out.)

The installer checks this as `tm8` and prints that line when it is missing. If
a session is launched on the node's login anyway, the spawn is **refused by
name** ("the node has none … `sudo -u tm8 -H claude auth login`"). If the login
disappears after launch, the session is failed as `agent_onboarding_screen`
instead of hanging at Claude Code's first-run screen.

Members do not have to use the node's login at all. Each one can connect their
own account, or a space can hold a shared one, under **Settings → Credentials**.
Whether members may fall back to the node's login is a Node admin setting
(**Node admin → Node credentials**).

---

## 2. Single or multi — who the loopback socket trusts

| | `single` (default) | `multi` |
|---|---|---|
| A request from 127.0.0.1 with no credential and no forwarding header | **is the owner** (auto-owner) | anonymous — must sign in |
| A request through a proxy (`X-Forwarded-For`, …) | must sign in | must sign in |
| Meant for | one person, on the machine itself | anything another machine reaches |

The server prints which one it is at boot (`node mode: …`).

**An ssh tunnel is a loopback connection.** `ssh -L 9000:127.0.0.1:17777 server`
arrives on the loopback socket with no forwarding header, exactly like a
process on the box. The server cannot tell the two apart, so on a `single` node
**whoever holds the tunnel is the owner**. That is why "let a second machine
in" always means `multi`:

### A laptop owner letting a second machine in

1. Set `TM8_NODE_MODE=multi` in the env file and restart. From now on you sign
   in too — loopback no longer means "owner".
2. If the node has never been claimed, claim it (§5). That sets the owner's
   password.
3. Give the other machine a way in:
   - **Same tailnet or LAN:** a TLS proxy (§3), or `tailscale serve --bg
     <port>`, which terminates TLS for you. Set `TM8_PUBLIC_ORIGIN` to the
     URL people open.
   - **An ssh tunnel** is fine *on a multi node*: it reaches the sign-in page
     like anyone else, and the person signs in with their own account.
4. Add the person (§6).

Never open a tunnel to a `single` node for someone else, and never point a proxy
at one: everything that reaches it unproxied is the owner.

---

## 3. A reverse proxy

Two things matter: **WebSocket upgrades** (live terminals and events ride on
`/v2/ws`) and **long timeouts** (an attached terminal is a connection that
stays open for hours). Pass `Host` through unchanged; tm8 checks it.

### Caddy (TLS included)

```caddy
tm8.example.com {
    encode zstd gzip
    request_body {
        max_size 8MB
    }
    reverse_proxy 127.0.0.1:17777 {
        # Caddy proxies WebSocket upgrades and sets X-Forwarded-* by itself.
        flush_interval -1
        transport http {
            read_timeout 75m
            write_timeout 75m
        }
    }
}
```

Caddy obtains and renews the certificate on its own as soon as DNS for
`tm8.example.com` points at the box and ports 80/443 are open.

### nginx

```nginx
map $http_upgrade $tm8_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name tm8.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name tm8.example.com;

    ssl_certificate     /etc/letsencrypt/live/tm8.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tm8.example.com/privkey.pem;

    client_max_body_size 8m;          # TM8_MAX_BODY_BYTES defaults to 8 MiB

    location / {
        proxy_pass http://127.0.0.1:17777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $tm8_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 75m;
        proxy_send_timeout 75m;
    }
}
```

A production config with rate limits and a separate artifact-preview host is in
[`deploy/utho/nginx/`](../../deploy/utho/nginx/). It is written for tm8.sh, so
read it as an example rather than copying it.

### What tm8 needs to know about the proxy

| Variable | Set it to | Why |
|---|---|---|
| `TM8_NODE_MODE` | `multi` | §2 |
| `TM8_PUBLIC_ORIGIN` | `https://tm8.example.com` | The claim link, OAuth callbacks and space links use it. Its hostname is accepted as `Host` and `Origin` automatically |
| `TM8_ALLOWED_HOSTNAMES` | extra names, comma-separated | Only if the proxy answers to more than one name |
| `TM8_ALLOWED_ORIGINS` | exact `https://` origins | Optional, stricter: switches the Origin check to exact matching. `TM8_PUBLIC_ORIGIN` and the node's own `http://127.0.0.1:<port>` / `localhost` / `[::1]` origins are always added |
| `TM8_PROJECT_ROOTS` | e.g. `/srv/tm8/projects` | Limits which folders members can pick as projects. Unset means the whole disk |

A browser that gets **403 `Host "…" is not this node`** or **`cross-origin
request … refused`** is reaching tm8 under a name the node was not told
about. The message names the variable to set.

---

## 4. TLS

TLS is required for any node reached from another machine: sign-in, claim and
invite sign-up all send a password in the request body.

- **Caddy:** automatic (§3).
- **nginx:** `certbot --nginx -d tm8.example.com`, or any ACME client that
  writes the two paths above. Renewal reloads nginx; tm8 itself is untouched.
- **Tailscale:** `tailscale serve --bg 17777` (recent Tailscale; older releases
  spell it `tailscale serve https / http://127.0.0.1:17777`) gives
  `https://<machine>.<tailnet>.ts.net` with a real certificate. Use that URL as
  `TM8_PUBLIC_ORIGIN`.

---

## 5. Claiming the node

A fresh node has no password on any account. In `multi` mode the claim is the
only way in:

```bash
sudo cat /var/lib/tm8/prod/data/setup-token      # tm8c_…
journalctl -u tm8-prod | grep -A6 UNCLAIMED       # the same token, as a link
```

Open `https://tm8.example.com/#claim=<token>`, or paste the token into the
**Claim this node** card. Claiming sets the owner's password and burns the
token. Anyone who can read the boot journal (the `adm` and `systemd-journal`
groups) can read the token while the node is unclaimed, so claim it promptly.

---

## 6. Adding people

Invite them; you never learn their password. See
[`../identity/PROVISION-SECOND-ACCOUNT.md`](../identity/PROVISION-SECOND-ACCOUNT.md).

---

## 7. Backups and restore

**What to back up:**

1. The database: `pg_dump -Fc postgres://tm8@127.0.0.1:5442/tm8_prod`.
2. `/var/lib/tm8/prod/data`. It holds uploaded files **and the key that seals
   stored credentials**. A database restored without its matching data
   directory cannot decrypt anyone's connected accounts.

**Automatically:** every `install.sh` re-run that has migrations to apply
first writes `pg_dump -Fc` to `/var/lib/tm8/prod/backups/`
(`tm8_prod-<UTC time>-m<applied count>.dump`, mode 0600) and keeps the newest
five. `--no-backup` skips it. `TM8_BACKUP_DIR` moves it.

**Nightly**, for example in `/etc/cron.d/tm8-backup`:

```cron
15 3 * * * root umask 077 && pg_dump -Fc -f /var/backups/tm8/tm8_prod-$(date +\%F).dump postgres://tm8@127.0.0.1:5442/tm8_prod && tar -C /var/lib/tm8/prod -czf /var/backups/tm8/data-$(date +\%F).tgz data && find /var/backups/tm8 -mtime +14 -delete
```

Copy `/var/backups/tm8` off the machine; a backup on the same disk is not one.

**Restore:**

```bash
systemctl stop tm8-prod
pg_restore --clean --if-exists -d postgres://tm8@127.0.0.1:5442/tm8_prod /var/backups/tm8/tm8_prod-2026-10-13.dump
tar -C /var/lib/tm8/prod -xzf /var/backups/tm8/data-2026-10-13.tgz
systemctl start tm8-prod
```

Restore a dump onto the same tm8 version that took it, or an older version
plus the migrations that version needs. Migrations only go forward, so a dump
from a newer schema will not run on older code.

---

## 8. Upgrading

```bash
cd /opt/tm8/prod
git fetch origin && git checkout <tag-or-commit>
./install.sh --env prod --service
```

The re-run backs up (if migrations are pending), installs dependencies,
rebuilds the server **and** the UI, migrates, restarts the unit and checks
`/health`. It leaves the env file alone.

**A restart ends every running agent session.** Each one is a process under the
server. Pick a quiet moment. Sessions can be resumed afterwards, but whatever a
session was doing at that instant is interrupted.

**To roll back:** check out the previous commit and re-run the installer. If
the upgrade ran migrations, also restore the dump it took first (§7), because the
older code does not know the newer schema.

---

## Which deploy script is which

| Script | What it is for |
|---|---|
| `install.sh` | Sets up and upgrades a machine — this guide |
| `deploy/utho/deploy.sh` | Moves a pushed git ref onto the tm8.sh boxes (Utho) over ssh. Specific to those hosts |
| `deploy/prod/deploy.sh` | **Not a server recipe.** The maintainer's laptop "stable" node (7777/7778, `tm8_stable`), run from a checkout. Do not use it to deploy a server |
