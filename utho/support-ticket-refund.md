# Refund request — unusable VM, Mumbai zone 2 (draft)

Ready to send. Submit via the Utho dashboard support section, or reply to the auto-generated
ticket their deploy API said it had already opened.

**Before sending:** confirm the dead VM (`cloudid 1670785`) is still running, so their
engineers can inspect it. Do not destroy it until the claim is settled.

---

**Subject:** Refund request — cloud server 1670785 unusable since creation (no network attachment, inmumbaizone2)

Hello,

I am requesting a full refund of all charges for cloud server **`1670785`**
(`157.20.215.176`, hostname `cloudserver-6s4dyk4b.mhc`), deployed 2026-08-01 09:42 UTC in
zone `inmumbaizone2`. The server has been **completely unreachable since the moment it was
created** and has never been usable.

**The cause is on your side.** When I attempted to deploy a replacement into the same zone,
your API returned:

> `{"status":"error","errorcode":"NONODEFOUND","message":"Sorry, Public Network Resources not available at this zone... A support ticket has been generated and our engineering team is working on it."}`

A deployment into `innoida` returned:

> `{"status":"error","message":" - Deploy Failed – Resource Unavailable, a support ticket for this issue is already open and our team is working on it."}`

So `inmumbaizone2` had exhausted its public network resources, and your team already had an
open ticket. Server `1670785` was created during that outage and never received a working
network attachment — while your panel and API reported it `status: Active` /
`powerstatus: Running` throughout.

**Evidence:**

- `GET /v2/cloud/1670785` reports **`bandwidth_used: 0`** across the instance's entire life,
  spanning three power cycles. It has never transmitted a single byte.
- From inside the VM (via your VNC console): `eth0` is UP, `157.20.215.176/23` is bound, and
  `default via 157.20.214.1` is present — `ip addr add` and `ip route add` both return
  "already exists". `ufw` is inactive. **The VM cannot ping its own gateway
  `157.20.214.1`**, and has no outbound connectivity at all.
- From the public internet: the instance answers nothing on ICMP or any TCP port (22, 80,
  443, 2222, 3306, 8080 — all timeout, not refused). Its own gateway `157.20.214.1` and
  other instances in `157.20.214.0/23` respond to ping normally, so your network and my
  connectivity are both fine.
- The attached firewall `23438116` explicitly permits inbound `SSH/TCP/22` from source `0`,
  so filtering is not the cause.
- Both assigned public IPs are dead — the primary `157.20.215.176` and the elastic
  `144.31.146.156`.
- `poweroff`/`poweron`, `powercycle`, and a further `poweron` via your API changed nothing.

The guest OS is healthy and correctly configured. The fault is the missing network
attachment at the hypervisor.

**Requests:**

1. **Full refund** of all charges for `1670785` from creation to termination. The server
   was never usable for any part of its billed life.
2. Please confirm whether the elastic IP `144.31.146.156` also incurred charges, and refund
   those.
3. I have left the instance **running** so your engineers can inspect it. Please tell me
   when I can safely destroy it.
4. Please consider **surfacing zone resource exhaustion in the dashboard at deploy time.**
   Your API knew public network resources were unavailable, but the panel allowed the
   deployment and then reported the resulting broken VM as `Active`/`Running`. That cost me
   roughly two hours of diagnosis against a fault that was never mine and could not be
   fixed from my side.

For reference, I have since deployed successfully into `inbangalore` (`1670787`), which
confirms the problem was zone-specific.

Thank you.

---

## Supporting API calls

For attaching to the ticket if they ask for reproduction steps:

```bash
# bandwidth_used is 0 across the instance's whole life
curl -sS -H "Authorization: Bearer $UTHO_TOKEN" \
  https://api.utho.com/v2/cloud/1670785 \
  | python3 -c "import sys,json;c=json.load(sys.stdin)['cloud'][0]; \
      print('power:',c['powerstatus'],'status:',c['status'],'bw_used:',c['bandwidth_used'])"

# firewall explicitly allows inbound 22
curl -sS -H "Authorization: Bearer $UTHO_TOKEN" \
  https://api.utho.com/v2/firewall/23438116

# the zone is dark from the internet, while its gateway and neighbours answer
ping -c3 157.20.215.176      # 100% loss
ping -c3 157.20.214.1        # gateway replies
ping -c3 157.20.215.175      # neighbour VM replies
```
