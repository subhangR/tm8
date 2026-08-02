# Server: `tm8-server`

Live, verified working as of 2026-08-01 11:54 UTC.

## Access

```bash
ssh utho
```

Equivalent explicit form:

```bash
ssh -i ~/.ssh/utho root@150.241.246.170
```

Both were verified with `BatchMode=yes`, which disables password fallback — so this
confirms key auth genuinely works and isn't silently falling back to a password prompt.

## Identity & specs

| Property | Value |
|---|---|
| Hostname | `tm8-server` |
| Public IPv4 | `150.241.246.170/24` |
| Gateway | `150.241.246.1` |
| Interface | `eth0` |
| Zone | `inbangalore` (Bangalore, India) |
| Utho `cloudid` | `1670787` |
| OS | Ubuntu 24.04.3 LTS |
| Kernel | `6.8.0-87-generic` |
| Arch | `x86_64` |
| CPU | 4 vCPU — AMD EPYC (with IBPB) |
| RAM | 7.8 GiB |
| Disk | 154 GB total, 153 GB available |
| Plan | `10315` — `basic`, 4 CPU / 8192 MB / 160 GB |
| Billing | Hourly, $42.01/mo equivalent |
| Timezone | `Etc/UTC` |
| DNS | `1.1.1.1`, `8.8.8.8` (via systemd-resolved on eth0) |
| SSH server | OpenSSH 9.6p1 Ubuntu-3ubuntu13.14 |
| Firewall (Utho) | `23438116` — "security groups" |
| Firewall (in-VM) | `ufw` — **inactive** |

Verified working: ICMP (~85 ms RTT from Mumbai-region client), inbound TCP 22, and
outbound egress (`curl ifconfig.me` returns its own IP).

## Utho cloud firewall `23438116`

Reused from the original deployment. Attached to this instance.

| Direction | Service | Proto | Port | Source |
|---|---|---|---|---|
| incoming | SSH | TCP | 22 | `0` (anywhere) |
| incoming | HTTP | TCP | 80 | `0` (anywhere) |
| incoming | CUSTOM | TCP | 7777 | `0` (anywhere) |
| outgoing | PING | ICMP | — | `0` |
| outgoing | ALL TCP | TCP | all | `0` |
| outgoing | ALL UDP | UDP | all | `0` |

Note **inbound ICMP is not permitted** by these rules. Ping currently works anyway, so the
rules appear to be applied statefully or not enforced for ICMP echo — do not rely on
inbound ping as a health check. Port 7777 is open, which matches the frozen tm8 stable
build's port; add rules via the dashboard or `POST /v2/firewall/23438116/rule` before
exposing new services.

## Changes made to this server

Everything below was applied by hand during setup. Nothing else has been installed or
changed — this is otherwise a stock Utho Ubuntu 24.04 image.

1. **SSH public key installed** for `root`:
   - `/root/.ssh` created, mode `700`
   - `/root/.ssh/authorized_keys` created, mode `600`, containing exactly 1 key:
     `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZU9JsWxSCZjMoW6T6FQ4NIEMkrxERhQ2razoW289yY subhang@utho`
   - Installed over a password session using `expect`, since `sshpass` isn't available on macOS.

No packages installed, no services enabled, no kernel or sysctl changes, no `ufw` changes.

## Changes made on the local Mac

**Keypair generated** (2026-08-01):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/utho -N "" -C "subhang@utho"
```

- Private key: `~/.ssh/utho` — **no passphrase**. Add one anytime with `ssh-keygen -p -f ~/.ssh/utho`
- Public key: `~/.ssh/utho.pub`
- Fingerprint: `SHA256:YxIMrFK75fhuMoibQxf497OVXTv5XgajuTGaVkGhM8o`

**`~/.ssh/config` entry appended** (file created, mode `600`):

```
Host utho
    HostName 150.241.246.170
    User root
    IdentityFile ~/.ssh/utho
    IdentitiesOnly yes
    ServerAliveInterval 30
```

`IdentitiesOnly yes` matters here — without it, ssh offers every key in the agent, and the
pre-existing `~/.ssh/tm8-ec2.pem` could be tried first and hit `MaxAuthTries` on servers
with a low limit.

**`~/.ssh/known_hosts`** gained the host key for `150.241.246.170` (ED25519).

## Hardening (not yet applied)

Password authentication is currently **enabled**, which is now unnecessary attack surface
since key auth is proven. The effective setting comes from drop-ins, last-numbered wins:

```
/etc/ssh/sshd_config.d/50-cloud-init.conf        PasswordAuthentication yes
/etc/ssh/sshd_config.d/60-cloudimg-settings.conf PasswordAuthentication no
/etc/ssh/sshd_config.d/99-root.conf              PasswordAuthentication yes   <-- wins
```

To disable it, edit the **`99-root.conf`** drop-in — changing `sshd_config` itself will
have no effect, because the drop-in overrides it:

```bash
ssh utho
sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/99-root.conf
sshd -t && systemctl reload ssh
```

`sshd -t` validates the config first — run it before reloading, or a syntax error will
take `sshd` down and lock you out. Keep an existing session open until you've confirmed a
fresh `ssh utho` still works.

## Recovery if SSH ever breaks

The Utho **web console (VNC)** reaches the VM out-of-band, independent of network and
`sshd`: dashboard → server → **Console**. There is also a **Reset Root Password** action on
the server page, and the API exposes a per-instance `consolepassword` field via
`GET /v2/cloud/1670787`.

Note that the console is *not* a substitute for network access — as the
[incident](incident-2026-08-01-mumbai-zone.md) showed, it works perfectly on a VM whose
networking is entirely absent, which can be misleading.
