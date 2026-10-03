# Sharing a private space credential with one member (task 01a10201)

A credential OWNER may share their **private** credential in space S with a specific
active member of S. The grantee may LAUNCH on it (pinned `space:<id>`, or as their
`my_default`); the secret, key hint and vendor login stay masked for the grantee.
Public / space-owned credentials need no share (every member may already use them).

## SQL (migration `290_space_credential_shares.sql`, placeholder number)

Table `public.space_credential_shares`
`(credential_id, space_id, grantee_account_id, granted_by_account_id, created_at)`,
PK `(credential_id, grantee_account_id)`, FK `(credential_id, space_id)` -> space_credentials.

"Usable by launcher L" everywhere becomes:
`visibility = 'public' or owner_account_id is null or owner_account_id = L
 or exists(share row for (credential, L))` — helper `internal.space_credential_shared_with(cred_id, account_id)`.
Applied to: read_space_credential_for_spawn, usable_space_credential_ids,
record_session_space_credential, repoint, sweep_unusable_space_credential_sessions,
set_space_credential_visibility killSessions, guard_member_default / set_my_space_credential_default.
The stream ATTACH gate (257) stays owner-only: a grantee's agent runs on the
credential but the grantee cannot attach a terminal to read its env (secret never exposed).

RPCs (all human-only, tm8_app execute):
- `share_space_credential(p_credential_id uuid, p_grantee_account_id uuid) -> jsonb`
  `{credentialId, spaceId, granteeAccountId, grantedByAccountId, createdAt, shared: boolean}`
  (`shared` false = already shared, idempotent). Caller must be the OWNER. Refused
  (42501) for non-owner, (23514) for space-owned/public/revoked credential, grantee
  == owner, and (42501, reason `not_member`) when grantee is not an ACTIVE member of S.
- `unshare_space_credential(p_credential_id uuid, p_grantee_account_id uuid) -> jsonb`
  `{credentialId, granteeAccountId, unshared: boolean, killSessions: SpaceCredentialKillSession[]}`
  Owner, or any space admin. Deletes the share, clears the grantee's member_default
  for it, returns the grantee's live sessions (spawning|running|idle) on it — the
  caller kills them exactly as setVisibility's killSessions (R8 sweep is the backstop).
- `list_space_credential_shares(p_credential_id uuid) -> jsonb` array of
  `{granteeAccountId, grantedByAccountId, createdAt}`. Owner or space admin see all;
  any other member sees only their own row.
- Card json (`space_credential_json`) gains `sharedWithMe: boolean`.
- Going private->public keeps share rows (harmless); revoke (delete) keeps them as tombstone.

## Agent Credentials: Share to

Connected provider rows offer **Share to** in Settings. The picker defaults to
the current space and optionally selects active members of that space. It
creates a separate private credential owned by the caller, then grants the
selected members; an empty selection keeps it private to the caller. No default
is changed. Member entity ids are resolved to accounts by the share RPC.

- GitHub uses `credentials.space.addMine`: read the caller's sealed token,
  probe it, and reseal it under the new space credential's AAD. The personal
  source is unchanged.
- Anthropic and OpenAI use a **fresh space sign-in**. Personal OAuth homes
  cannot be copied: refresh-token rotation could invalidate the original.
  The new pending credential is claimed and made private before its terminal
  is shown. Grants wait until the space credential is active. A failed privacy
  setup removes only that new pending credential.
- `addMine` remains GitHub-only. There is no defined personal API-key source
  for the native Anthropic/OpenAI connections; this flow does not guess vendor
  file formats. Pasting their API keys remains available in Space credentials.
  Other provider rows explain that sharing is not supported yet.
- Partial grant failures keep the saved credential and successful grants.
  Retry applies only the failed grants to that same credential.

Regression coverage: `settings-credentials/share-to.test.tsx`,
`test/db/credential-add-mine.pg.test.ts`, and the fresh-login cases in
`test/credentials/space-credential-home.test.ts`. The sharing pg suite also
covers the revoke-versus-resume lock race: usability must be checked in a new
statement after acquiring the credential lock, because unshare deletes a grant
without rewriting the credential tuple.
