# Incident: unreachable Utho VM — Mumbai zone 2 network exhaustion

**Date:** 2026-08-01 · **Duration of diagnosis:** ~2 hours · **Resolution:** redeploy in a different zone

## Summary

A Utho cloud server (`157.20.215.176`, zone `inmumbaizone2`) was completely unreachable
from the moment it was created. The Utho panel and API both reported it `status: Active` /
`powerstatus: Running` for its entire life.

**Root cause: Utho's `inmumbaizone2` had run out of public network resources.** The VM,
its disk, and two public IP addresses were all allocated, but the virtual NIC was never
attached to Utho's network. The instance was structurally incapable of passing a packet.

This was a provider-side capacity failure. Nothing about the SSH key, credentials,
firewall rules, or guest OS configuration was ever wrong.

## Affected instance

| Property | Value |
|---|---|
| `cloudid` | `1670785` |
| Hostname | `ubuntu` / `cloudserver-6s4dyk4b.mhc` |
| Primary IP | `157.20.215.176/23`, gateway `157.20.214.1` |
| Elastic IP | `144.31.146.156/24`, gateway `144.31.146.1` |
| Zone | `inmumbaizone2` (Mumbai) |
| rDNS | `157-20-215-176.network.microhost.com` |
| Created | 2026-08-01 09:42 UTC |

## Symptoms

- Every TCP port timed out — 21, 22, 25, 53, 80, 443, 2222, 3306, 8080. **Timeout, not
  connection-refused**, meaning packets were dropped silently rather than rejected.
- No ICMP response.
- **Both** public IPs were dark, primary and elastic.
- The VM **could not ping its own gateway**, despite a correct address and route.
- The VM had no outbound connectivity either — `ping 1.1.1.1` failed.
- `traceroute` from the internet reached Utho's edge (`103.15.80.138`) then stopped.
- The VNC console worked perfectly and the guest OS was healthy and fully booted.

## What was ruled out, and how

Each of these was eliminated with direct evidence, not assumption:

| Hypothesis | How it was disproven |
|---|---|
| Wrong SSH key / username / hostname | `ssh -v` never printed `Connection established` — it hung in `connect()`, before any credential is transmitted. No key or username can affect this. |
| Client network / ISP blocking | `github.com:22` reachable, `1.1.1.1` pinged fine from the same Mac. |
| Utho network or routing broken | The instance's own gateway `157.20.214.1` replied to ping from the internet in ~40 ms. |
| Utho filtering the whole subnet | Neighbouring VMs `157.20.215.175` and `157.20.215.180` in the same `/23` replied to ping. |
| Utho cloud firewall | `GET /v2/firewall/23438116` showed an explicit inbound `SSH/TCP/22` rule from source `0` (anywhere). |
| In-VM firewall | `ufw status` → `inactive`. |
| Missing IP or route in the guest | `ip addr add` → "address already assigned"; `ip route add default` → `RTNETLINK: File exists`. Both were already correct. |
| `sshd` not running | Would produce connection-*refused*, not timeout. Also ICMP was dead, which `sshd` cannot affect. |
| Transient boot problem | Survived `poweroff`/`poweron`, `powercycle`, and a further `poweron` — three full power cycles. |
| Wrong IP address | The elastic IP `144.31.146.156` was equally dead. |

## The decisive evidence

**1. `bandwidth_used: 0`**

`GET /v2/cloud/1670785` reported `bandwidth_used: 0` across the instance's entire ~2 hour
life and three power cycles. A VM that has ever had working networking has moved bytes.
Zero is only possible if the NIC was never attached.

**This is the single cheapest diagnostic and should be checked first.** One API call would
have settled in seconds what was instead chased through SSH flags, guest network config,
and the VNC console.

**2. The deploy endpoint stated the reason outright**

No other surface — not the panel, not `GET /v2/cloud/{id}` — revealed this. Attempting a
new deployment did:

```
POST /v2/cloud/deploy   { "dcslug": "inmumbaizone2", ... }

{"status":"error","errorcode":"NONODEFOUND",
 "message":"Sorry, Public Network Resources not available at this zone, ...
            A support ticket has been generated and our engineering team is working on it."}
```

A second zone was also exhausted, and Utho confirmed a pre-existing internal ticket:

```
POST /v2/cloud/deploy   { "dcslug": "innoida", ... }

{"status":"error",
 "message":" - Deploy Failed – Resource Unavailable, a support ticket for this issue
             is already open and our team is working on it."}
```

So Utho was already aware of the outage and surfaced nothing to the customer. The original
VM was created *during* this outage and silently inherited it.

## Resolution

Enumerated zones via the undocumented `GET /v2/cloud/dczones`:

| Slug | City | Status |
|---|---|---|
| `innoida` | Delhi (Noida) | active — but resource-exhausted |
| `inmumbaizone2` | Mumbai | active — but network-exhausted |
| `inmumbai` | Mumbai Zone 1 | inactive |
| `inbangalore` | Bangalore | **active — worked** |
| `defra1` | Frankfurt, Germany | active |
| `uslosangeles` | Los Angeles, US | active |
| `inbangalore3` | Bangalore DC3 | inactive |
| `inindore` | Indore | inactive |

Redeployed into `inbangalore` with the same plan and image. It came up working on the first
attempt — ping, inbound SSH, and outbound egress all functional. See [server.md](server.md).

The failed VM was left **running and untouched** as evidence for a refund claim; see
[support-ticket-refund.md](support-ticket-refund.md).

## Lessons

1. **Check `bandwidth_used` first.** For any "provider says Running but nothing answers"
   case, this one field distinguishes a networking/firewall problem from a VM that was
   never attached to the network at all.

2. **A timeout is not a refusal.** Silently-dropped packets mean a filter or a missing
   path. Connection-refused means something is listening and saying no. They point at
   completely different causes.

3. **Read where `ssh -v` stops.** No `Connection established` line means the failure is at
   TCP, below authentication entirely — so every credential-related theory is void. This
   should have ended the key/username/password speculation immediately.

4. **A working VNC console proves the guest booted, and nothing more.** It reaches the VM
   out-of-band via the hypervisor. It works fine on a VM with zero network attachment,
   which actively misleads.

5. **Provider status fields describe the hypervisor's intent, not reality.**
   `Active`/`Running` meant "we started this VM", not "this VM is functional".

6. **Test the gateway and a neighbour.** Pinging the instance's own gateway and another IP
   in the same subnet cleanly separated "provider network broken" from "this one instance
   broken" — and took one command.

7. **When reads are uninformative, try a write.** The read endpoints all claimed health.
   The deploy endpoint named the actual fault. Error messages on mutating calls often carry
   diagnostic detail that status endpoints omit.
