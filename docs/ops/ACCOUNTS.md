# Disabling an account, removing a member

Use the commands. Do not use raw SQL.

| To | Run | Operation |
|---|---|---|
| Disable an account on this Server | `tm8 node account disable <account-id>` | `accounts.disable` |
| Remove someone from a Space | `tm8 space member remove ...` | `spaces.members.remove` |
| Leave a Space yourself | `tm8 space leave ...` | `spaces.leave` |

Each of these does two steps, in this order:

1. **SQL** (`disable_account`, `remove_space_member`, `leave_space`) revokes
   the tokens and records the ending, in one transaction. It revokes the
   credentials the account or member owns, and lists every session that has to
   end: the ones the account launched, including those on space credentials,
   and the ones others launched on the revoked credentials.
2. **Containment** (`packages/server/src/membership/handlers.ts`) runs after
   the commit. It kills the PTYs of the sessions the account launched,
   including sessions on space credentials. It contains the sessions other
   members launched on the revoked credentials, removes their login homes, and
   closes the identity's event sockets.

## The raw route bypasses containment

`select public.set_account_disabled(...)` in `psql`, or
`PgIdentityRepository.setAccountDisabled`, which nothing in production
composes, flips the flag and revokes the account's auth sessions. The
`accounts_disable_revokes_owned_credentials` trigger still revokes the
credentials the account owns. **Nothing is killed, though.** Agents the
account launched on space credentials keep running until they exit. So do
sessions other members launched on its now-revoked credentials.

If you used it anyway, run `tm8 node account disable <account-id>` on the same
account straight away. On an already-disabled account it still lists and
contains every live session that ran on a space credential the account
launched, because it matches on `session_space_credentials.launcher_account_id`.
It does **not** find sessions bound only by an auth token: the raw call already
revoked those tokens, so they no longer match. List what is left, and stop it
by hand with `tm8 session terminate <id>`:

```sql
select ws.entity_id from public.work_sessions ws
  join public.auth_sessions s on s.work_session_id = ws.entity_id
 where s.account_id = '<account-id>' and ws.status in ('spawning','running','idle');
```
