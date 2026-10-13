# Space links across servers

A **space link** lets agents working for you in one space (the *home*) act in another
space (the *target*) as you. When both spaces are on one node, a link needs no setup. This page
covers the case where the target space is on **another tm8 server**: a teammate's laptop, a
shared box, or a peer on your LAN or tailnet.

Remote links are **off by default**. Both nodes must turn them on.

## 1. What each node needs

| Setting | Home node | Target node | Why |
|---|---|---|---|
| `TM8_REMOTE_SPACE_LINKS=on` | required | required | Off: a link to another server is refused with `space_link_remote_disabled`, `tm8 link grant` is refused, and `/link/v1/*` answers 404. Read once at boot. |
| HTTPS on the target | — | required | The home node reaches the target over HTTPS only, with a certificate it trusts. Plain `http://` is refused (`invalid_url`). |
| `TM8_PUBLIC_ORIGIN` | recommended | — | The home node sends it when it claims a pairing code, so the target's admins can see where the link comes from. |
| `TM8_REMOTE_SPACE_LINKS_ALLOW_PRIVATE=1` | for a LAN / Tailscale target | — | By default the home node reaches **public** addresses only. This opt-in also allows 10/8, 172.16/12, 192.168/16, Tailscale's 100.64/10 and IPv6 `fc00::/7`. Loopback, link-local (including cloud metadata at 169.254.169.254) and reserved ranges stay refused. |
| `TM8_REMOTE_SPACE_LINKS_ALLOW_LOOPBACK=1` | dev only | — | Lets two servers on one machine link over plain `http://127.0.0.1`. Used by `scripts/e2e/remote-space-links-two-servers.sh`. Never set it on a real node. |

Set them like any other `TM8_*` variable: in the service env file, in `.env.local`, or, for the
desktop app, in the `env` block of its settings file ([`DESKTOP.md`](DESKTOP.md)). Each node
prints `remote space links: ON` at boot when the switch is on, and says which opt-ins are set.

**Tailscale.** `tailscale cert` / `tailscale serve` give the target a real certificate on its
`*.ts.net` name. That name resolves to a 100.x address, so the home node needs
`TM8_REMOTE_SPACE_LINKS_ALLOW_PRIVATE=1`.

## 2. Set up a link, end to end

Space **A** is on the home node. Space **B** is on the target node, at `https://lab.example`.
You are a member of both. Every step is human-only: an agent is refused, and it asks you to run
the step.

| Step | Where | CLI | UI |
|---|---|---|---|
| 1. Register the target server in A | home | `tm8 server add lab --url https://lab.example --space <A>` | Server rail → Add server |
| 2. Check the home node can reach it | home | printed by `server add`; again with `tm8 server probe lab` | the server's panel → Check reachability |
| 3. Add the link | home | `tm8 link add <B-space-id> --target-server lab --alias lab --space <A>` | Settings → Space links → pick "On lab", paste B's id → Add link |
| 4. Make a pairing code | **target** | `tm8 link grant <A-space-id> --label "laptop" [--allow-spawn] --space <B>` | Settings → Space links → Grant access → Make pairing code |
| 5. Sign in with the code | home | `tm8 link login lab --pairing-code <code> --space <A>` | Settings → Space links → paste the code on the link → Sign in |

The check in step 2 runs **on the home node**, not on your machine, because the home node makes
every link call. If it reports `unreachable (non_public_address)`, the target is on a private
address: set `TM8_REMOTE_SPACE_LINKS_ALLOW_PRIVATE=1` on the home node.

A pairing code is single use and expires in minutes. Only its hash is stored, so the CLI and the
UI each show it once. A code made for one space cannot sign in to a link for another
(`space_link_pairing_target_mismatch`).

Agents then reach B through the link from A:

```bash
tm8 --space lab entity query --kind task
```

## 3. While it runs

- **Status.** `tm8 link list` shows your own sign-in on each link. In Settings → Space links, a
  link to another server shows which server it is on, and **Unreachable** or **Offline** when the
  last call or check could not reach it. A call through the link records what it saw on the
  server (`reachStatus`), so a target that goes down reads as down until a call or a check gets
  through again.
- **Audit.** `tm8 link audit lab` on the home node. On the target node, admins of B see the
  inbound link and every call made through it: `tm8 link inbound`, `tm8 link inbound-audit`, or
  Settings → Space links → Links into this space.
- **Revoke.** A target admin runs `tm8 link revoke <link-id|home-space-id>`, or Revoke in the UI.
  The home node's next call gets a 401 and marks your row signed out. Restore it with
  `tm8 link restore`.

## 4. Ending it

| What | CLI | UI |
|---|---|---|
| Sign out (the home node also asks the target to end the session it minted) | `tm8 link logout lab` | Space links → Sign out |
| Remove your own row (the link stays for other members) | `tm8 link remove lab` | Space links → Remove |
| Remove the server (refused while a link still targets it) | `tm8 server remove lab --yes` | the server's panel → Remove server |

## 5. When it fails

| You see | It means |
|---|---|
| `space_link_remote_disabled` | `TM8_REMOTE_SPACE_LINKS` is off on the home node. |
| `does not support remote space links` / `space_link_remote_unsupported` | The target node is older, or its switch is off. |
| `unreachable (non_public_address)` | The target resolves to a private address. Set `TM8_REMOTE_SPACE_LINKS_ALLOW_PRIVATE=1` on the home node. |
| `unreachable (invalid_url)` | The server's URL is not `https://`. |
| `unreachable (tls)` | The home node does not trust the target's certificate. |
| `offline (…)` | The target refused the connection, reset it, or did not answer in time. |
| `space_link_pairing_required` | Sign-in to a link on another server needs `--pairing-code` (or the code field in the UI). |
| `space_link_pairing_refused` | The code was already used, expired, or never existed. Make a new one. |

To try it on one machine with two scratch servers, see
`scripts/e2e/remote-space-links-two-servers.sh`.
