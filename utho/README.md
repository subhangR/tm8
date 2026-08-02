# Utho Cloud — server documentation

Documentation for the Utho Cloud server provisioned for this project, and the incident
that made the first attempt fail.

**Created:** 2026-08-01

## Documents

| File | Contents |
|---|---|
| [server.md](server.md) | Live server: IP, specs, access, current config state |
| [incident-2026-08-01-mumbai-zone.md](incident-2026-08-01-mumbai-zone.md) | Why the first server was unreachable — full diagnostic trail and root cause |
| [api-notes.md](api-notes.md) | Utho REST API: endpoints, auth, and undocumented behaviour discovered the hard way |
| [support-ticket-refund.md](support-ticket-refund.md) | Ready-to-send refund request for the dead VM |
| `CREDENTIALS.md` | Secrets. **Not committed** — see [.gitignore](.gitignore) |

## TL;DR

```bash
ssh utho
```

Working server is **`150.241.246.170`** (Bangalore), Ubuntu 24.04.3, key-based auth via
`~/.ssh/utho`.

The first server (`157.20.215.176`, Mumbai zone 2) was **never usable** — Utho's
`inmumbaizone2` had exhausted its public network resources, so the VM was created with
public IPs assigned but no NIC attachment. It is still running, deliberately, as evidence
for a refund claim.

## Outstanding actions

- [ ] **Rotate the Utho API token** — it was pasted into a chat transcript. *Account → API Token*
- [ ] **Change both root passwords** — also exposed in the transcript
- [ ] **File the refund claim** for the dead Mumbai VM (draft ready: [support-ticket-refund.md](support-ticket-refund.md))
- [ ] **Destroy the dead VM** once the refund is settled — `cloudid 1670785`
- [ ] Optional hardening: disable SSH password auth now that key auth is proven (see [server.md](server.md#hardening-not-yet-applied))
