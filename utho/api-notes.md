# Utho REST API — working notes

Everything here was verified by direct use against the live API on 2026-08-01, not read
from documentation.

## Auth & base URL

```
Base:  https://api.utho.com/v2/
Auth:  Authorization: Bearer <token>
```

Tokens are created at **Account → API Token** in the dashboard. A token grants **full
account control** — treat it as a root credential.

```bash
curl -sS -H "Authorization: Bearer $UTHO_TOKEN" https://api.utho.com/v2/cloud
```

## Documentation is effectively unavailable

`https://utho.com/api-docs/` is **JavaScript-rendered** — fetching it returns only a page
title, so it can't be scraped or read by tools.

**The usable source of truth is their Go SDK:**

- `https://github.com/uthoplatforms/utho-go` — `utho/cloud_instances.go` contains every
  endpoint path and the exact request struct field names
- `https://github.com/uthoplatforms/terraform-provider-utho` — working parameter examples

Fetch the raw file and extract paths:

```bash
curl -sS https://raw.githubusercontent.com/uthoplatforms/utho-go/main/utho/cloud_instances.go \
  | grep -oE '"/[a-z]+"'
```

## Endpoints

### Read

| Method | Path | Notes |
|---|---|---|
| GET | `/cloud` | List all instances (full detail per instance) |
| GET | `/cloud/{id}` | Single instance |
| GET | `/cloud/images` | OS images, e.g. `ubuntu-24.04-x86_64` |
| GET | `/cloud/dczones` | **Zone list — undocumented but essential** |
| GET | `/plans` or `/cloud/plans` | Plans with `id`, `cpu`, `ram`, `disk`, `price`, `is_available` |
| GET | `/pricing` | Similar, with currency-formatted prices |
| GET | `/firewall/{id}` | Firewall detail **including all rules** |

### Instance actions

All are `POST /cloud/{id}/<action>`:

`poweron` · `poweroff` · `powercycle` · `hardreboot` · `rebuild` · `resetpassword` ·
`resize` · `destroy` · `delete` · `assignpublicip` · `enablerescue` · `disablerescue` ·
`mountiso` · `umountiso` · `snapshot/create` · `restore` · `backups/enable` ·
`backups/disable` · `update` · `updaterdns/` · `billingcycle`

### Endpoints that do NOT exist

These return `401 {"status":"error","message":"Not Found GET"}` — note the misleading
`401`, which suggests an auth problem rather than a bad path:

`/datacenter` · `/datacenters` · `/dc` · `/dclocation` · `/location(s)` · `/region(s)` ·
`/zones` · `/sshkeys` · `/sshkey` · `/availability`

Some paths return **HTTP 200 with an empty body** — also effectively nonexistent:
`/ssh/keys`, `/cloud/sshkey`, `/account/sshkeys`, `/cloud/dcslug`, `/cloud/dclocation`,
`/cloud/location`.

## Gotchas that cost real time

### Power endpoints hang and never return a body

`POST /cloud/{id}/poweron` (and siblings) accept the request and act on it, but **never
send a response**. `curl` exits `28` (timeout) even on success.

Consequences:

- **A short `-m` aborts the request before Utho processes it.** `-m 20` silently failed to
  power on an instance; `-m 90` worked. Allow 90 s or more.
- **Never trust the response** — poll `GET /cloud/{id}` for the real state.
- `POST /cloud/{id}/stop` returns an empty body and does nothing. The correct action is
  **`poweroff`**.

> Note: `poweron`/`poweroff` **did** respond promptly on 2026-08-01
> (`{"status":"success","message":"Power off Request has been completed!"}`). The no-response
> behaviour is intermittent, so allow the long timeout regardless — but a fast reply is not a
> sign anything is wrong.

### Resizing

`POST /cloud/{id}/resize` with body `{"type":"cloud","plan":"<planid>"}` (field names from
`utho-go`'s `ResizeCloudInstanceParams`; `type` is the plan's own `type` field).

**It returns `{"status":"success","message":"Cloud Resize request sent!"}` even when it will
never apply the resize.** Utho toggles the instance's power — genuinely starting the workflow —
then aborts silently, leaving specs unchanged. Poll `GET /cloud/{id}` for `cpu`/`ram`; do not
trust the response. A `poweron` issued too soon after returns
`"A task is already in process"`; that stuck task clears itself in a few minutes.

Valid targets come from `GET /cloud/{id}/resizeplans`, which is instance-specific and
disagrees with `/v2/plans` — it reports `disk: "160"` (the current disk) for every target, and
prices in **INR** where `/v2/plans` uses **USD**. See
[findings-2026-08-01-swap-and-blocked-resize.md](findings-2026-08-01-swap-and-blocked-resize.md)
for the full case, including the suspected credit/KYC gate.

`resize` is **not** `rebuild`. `rebuild` destroys the disk.

### Power state strings

A stopped instance reports **`Shutdown`**, not `Stopped` or `Off`. Polling loops that wait
for `Stopped` will never terminate.

Also: `status` and `powerstatus` are independent. `status: Active` is a *billing//
provisioning* state and stays `Active` on a completely broken VM. Freshly deployed
instances pass through `Active`/`Shutdown` while imaging, then boot on their own — allow
about 60–90 s before intervening.

### `status: Running` does not mean functional

See [the incident writeup](incident-2026-08-01-mumbai-zone.md). It means the hypervisor
started the VM. A VM with no network attachment reports `Running` indefinitely.

**Do NOT rely on `bandwidth_used` as the reality check.** Earlier guidance here said `0` on a
long-running instance proves it never networked. **That is wrong — it produces false positives.**
Measured on `1670787` on 2026-08-01 while it was fully healthy and serving traffic over both
eth0 and the tailnet, at 7h28m uptime:

```
/proc/net/dev  eth0: 3613863120 bytes rx, 2633395347 bytes tx
GET /cloud/1670787  ->  "bandwidth_used": 0
```

The Mumbai diagnosis was still correct, but the field did not earn the credit. Check
in-guest counters (`/proc/net/dev`, `ip -s link`) or simply try to reach the box. See
[findings-2026-08-01-swap-and-blocked-resize.md](findings-2026-08-01-swap-and-blocked-resize.md).

### Useful fields in `GET /cloud/{id}`

- `bandwidth_used` — **unreliable**, reads `0` on healthy instances; see above
- `consolepassword` — VNC console password, without needing the dashboard
- `firewalls[]` — attached firewalls. **The server page in the dashboard may not show
  these**, so an attached firewall is easy to miss; check here.
- `networks.public.v4[]` — all public IPs with netmask/gateway. An instance can have
  several; the top-level `ip` field is not necessarily the one marked `primary: "1"`.
- `updated_at` is often the literal string `0000-00-00 00:00:00` — useless.

## Deploying an instance

`POST /cloud/deploy`. Field names come from `CreateCloudInstanceParams` in the Go SDK:

```json
{
  "dcslug": "inbangalore",
  "image": "ubuntu-24.04-x86_64",
  "planid": "10315",
  "enable_publicip": "true",
  "vpc": "",
  "subnetRequired": "false",
  "cpumodel": "amd",
  "root_password": "<password>",
  "firewall": "23438116",
  "billingcycle": "hourly",
  "cloud": [{ "hostname": "tm8-server" }]
}
```

Notes:

- `cloud` is an **array of objects**, each `{"hostname": "..."}` — not a plain string.
- `planid` comes from `GET /plans`. Filter on `is_available == "YES"`, and note that plans
  with `disk: "0"` expect separate storage.
- `firewall` takes an existing firewall id and **worked across zones** — a Mumbai-created
  firewall attached cleanly to a Bangalore instance.
- Supplying `root_password` is the reliable path. There is no working SSH-key endpoint
  (all candidates 404 or return empty), so install keys yourself over the first password
  session.
- The response returns the password and IP directly:

```json
{"status":"success","cloudid":"1670787",
 "message":"Cloud Server deploy in process ...",
 "password":"...","ipv4":"150.241.246.170"}
```

- Utho may return a password **different from the one you supplied** — use the one in the
  response.

### Deploy errors reveal capacity problems

Deploy is the only surface that reports zone exhaustion:

```json
{"status":"error","errorcode":"NONODEFOUND",
 "message":"Sorry, Public Network Resources not available at this zone, ..."}
```

**Always check `GET /cloud/dczones` and be ready to try several zones.** Two of six active
zones were exhausted on 2026-08-01 with no indication anywhere in the dashboard.

## Installing an SSH key from macOS

`sshpass` is not present on macOS, but `/usr/bin/expect` is. Working script:

```expect
#!/usr/bin/expect -f
set timeout 60
set pw     [lindex $argv 0]
set pubkey [lindex $argv 1]
spawn ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password \
          -o PubkeyAuthentication=no root@<IP> \
  "mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo '$pubkey' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && echo KEY_INSTALLED"
expect {
  -re {[Pp]assword:} { send "$pw\r"; exp_continue }
  "KEY_INSTALLED"    { puts "\n>>> confirmed"; exp_continue }
  eof {}
  timeout { exit 1 }
}
```

`PubkeyAuthentication=no` forces the password path, so the attempt can't be masked by an
agent key that happens to work.

Then always verify with `BatchMode=yes`, which disables password fallback — otherwise a
successful login proves nothing about the key:

```bash
ssh -i ~/.ssh/utho -o BatchMode=yes root@<IP> 'echo ok'
```
