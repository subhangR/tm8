-- =============================================================================
-- 195 — KIMI AND GROQ JOIN THE ADMITTED PROVIDER SET.
--
-- Two more providers a member can connect, reached by the same Connect button,
-- the same login terminal, the same probe and the same close path as the six
-- before them. What is new is the SHAPE of the credential, and this migration
-- makes a deliberate decision about that shape rather than inheriting one.
--
-- THE SHAPE DECISION, STATED EXPLICITLY.
--
-- 183 defines the file predicate as "every session provider EXCEPT github". A
-- provider added to `is_credential_provider` therefore becomes FILE-shaped by
-- default, silently, without anyone choosing it. That default happens to be
-- right here, and it is written down so that it is a decision rather than an
-- accident:
--
--   Kimi and Groq store a single API key in a file, at
--   `<dataDir>/credentials/<identityId>/<provider>/api-key`, inside the same
--   per-identity credential home every other file-shaped provider uses. The
--   index row in `account_agent_credentials` holds no secret — it records that
--   a credential exists and when it was last verified — which is exactly the
--   contract that table was built for.
--
--   They are NOT string-shaped like GitHub. `account_git_credentials` exists
--   because a GitHub token must be handed to `git` and `gh` as an environment
--   variable AND survive being read back out for a credential helper, so it is
--   stored encrypted in a column. Nothing here needs that: tm8 reads the key at
--   spawn time and puts it in one variable. Putting these two in the git table
--   would have meant a second encrypted-column consumer, a second revocation
--   path, and a credential that no longer lives beside its own login session.
--
-- WHY THE KEY BEING PASTED CHANGES NOTHING AT THIS LAYER. For every other
-- file-shaped provider a vendor CLI writes the credential file; for these two
-- tm8's own paste harness does. That is a difference in who holds the pen, not
-- in where the ink goes, and the database has never known or cared which
-- program wrote the file — only that the index row is written after a probe
-- succeeded. `set_account_agent_credential` is unchanged here for that reason.
--
-- WHAT THIS MIGRATION TOUCHES, AND WHAT IT DOES NOT.
--
-- Three provider lists exist and all three are widened together:
--
--   1. `internal.is_credential_provider` — 183's single SESSION authority,
--      guarding `start_credential_session`. Widened by `create or replace`.
--      `is_file_credential_provider` derives from it and needs no edit, which
--      is the property 183 built it for.
--   2. `account_agent_credentials_provider_check` — the file-shaped table.
--   3. `credential_sessions_provider_check` — every provider that may hold an
--      open login terminal, github included.
--
-- The two CHECKs still cannot be expressed in terms of the predicates above: a
-- CHECK constraint must be IMMUTABLE and may not call a function that reads
-- another object, so the lists stay inline. That is why this file exists at all
-- rather than being a one-line change to 183's function, and it is the same
-- reason 181 and 182 each had to touch both.
--
-- `drop constraint` + `add constraint` follows the established idiom: PostgreSQL
-- has no replace form for a CHECK, and 083's inline CHECKs gave these
-- constraints their stable generated names.
--
-- NO BACKFILL AND NO DATA CHANGE. Widening an admitted set cannot invalidate an
-- existing row, and no member can have connected a provider the server did not
-- accept. Every existing credential is untouched.
-- =============================================================================

set role tm8_graph_owner;

-- Every provider for which a credential login terminal may be opened.
-- Kimi and Groq are terminals like any other; only the program that runs inside
-- them is tm8's rather than a vendor's.
create or replace function internal.is_credential_provider(p_provider text)
returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    p_provider = any (array[
      'anthropic',
      'openai',
      'github',
      'gemini',
      'hermes',
      'cursor',
      'kimi',
      'groq'
    ]::text[]),
    false
  )
$$;

-- `internal.is_file_credential_provider` is DELIBERATELY NOT REDEFINED. It is
-- `is_credential_provider(p) and p <> 'github'`, so replacing the function above
-- has already widened it. Restating it here would create the second authority
-- 183 removed.

alter table public.account_agent_credentials
  drop constraint account_agent_credentials_provider_check;

alter table public.account_agent_credentials
  add constraint account_agent_credentials_provider_check
    check (provider in ('anthropic', 'openai', 'gemini', 'hermes', 'cursor', 'kimi', 'groq'));

alter table public.credential_sessions
  drop constraint credential_sessions_provider_check;

alter table public.credential_sessions
  add constraint credential_sessions_provider_check
    check (provider in ('anthropic', 'openai', 'github', 'gemini', 'hermes', 'cursor', 'kimi', 'groq'));

reset role;
