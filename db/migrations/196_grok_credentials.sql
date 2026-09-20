-- =============================================================================
-- 196 — GROK (xAI) JOINS THE ADMITTED PROVIDER SET.
--
-- The third pasted-API-key provider, and the first one that CONTENDS. Kimi
-- backs `claude-code` alone and Groq backed `codex` alone; Grok backs `codex`
-- too, so from this migration onward a member may hold two keys that both claim
-- the same agent tool.
--
-- THE CONTENTION IS NOT RESOLVED HERE, AND DELIBERATELY SO. Which key wins is a
-- property of one ordered list in application code
-- (`API_KEY_CREDENTIAL_PROVIDERS` in `execution/src/credentials/
-- api-key-credentials.ts`), read by the resolver and reported to the member on
-- the card that is losing. Encoding a precedence in the schema — a priority
-- column, a partial unique index admitting one backend per tool — would put a
-- second authority beside that list and let the two disagree silently after a
-- deploy that changed only one of them. The database's job here is admission,
-- and admission is all it does.
--
-- WHY THIS IS NOT MERELY A SPELLING OF 195's GROQ. Grok is xAI's model family,
-- served from api.x.ai; Groq is Groq, Inc., an inference host served from
-- api.groq.com. The names differ by a transposed letter, both surfaces are
-- OpenAI-compatible, and a key for one is worthless at the other. They are two
-- providers, two rows, two credential directories and two cards. Nothing in
-- this chain treats either as an alias for the other, and a future reader
-- tempted to "fix the typo" should stop: both spellings are correct and both
-- are load-bearing.
--
-- THE SHAPE IS 195's, UNCHANGED. Grok is FILE-shaped: a single API key at
-- `<dataDir>/credentials/<identityId>/grok/api-key`, 0600, with an index row in
-- `account_agent_credentials` holding no secret. 183's file predicate is
-- "every session provider EXCEPT github", so widening
-- `internal.is_credential_provider` below widens
-- `is_file_credential_provider` with it and no second edit is needed — the same
-- property 195 relied on, restated because relying on it silently is how it
-- gets broken.
--
-- WHAT THIS TOUCHES. The same three lists 195 widened, for the same reasons:
--
--   1. `internal.is_credential_provider` — 183's single SESSION authority,
--      guarding `start_credential_session`. Widened by `create or replace`.
--   2. `account_agent_credentials_provider_check` — the file-shaped table.
--   3. `credential_sessions_provider_check` — every provider that may hold an
--      open login terminal, github included.
--
-- The two CHECKs still cannot be expressed in terms of the predicate: a CHECK
-- must be IMMUTABLE and may not call a function that reads another object, so
-- the lists stay inline and `drop constraint` + `add constraint` remains the
-- idiom, PostgreSQL having no replace form for a CHECK.
--
-- NO BACKFILL AND NO DATA CHANGE. Widening an admitted set cannot invalidate an
-- existing row, and no member can have connected a provider the server did not
-- accept. Every existing credential — Groq's included — is untouched, and a
-- member already routed to Groq stays routed to Groq: see the ordering note in
-- `api-key-credentials.ts` for why the new backend is appended rather than
-- inserted.
-- =============================================================================

set role tm8_graph_owner;

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
      'groq',
      'grok'
    ]::text[]),
    false
  )
$$;

-- `internal.is_file_credential_provider` is DELIBERATELY NOT REDEFINED, for the
-- reason 195 records: it derives from the function above.

alter table public.account_agent_credentials
  drop constraint account_agent_credentials_provider_check;

alter table public.account_agent_credentials
  add constraint account_agent_credentials_provider_check
    check (provider in ('anthropic', 'openai', 'gemini', 'hermes', 'cursor', 'kimi', 'groq', 'grok'));

alter table public.credential_sessions
  drop constraint credential_sessions_provider_check;

alter table public.credential_sessions
  add constraint credential_sessions_provider_check
    check (provider in ('anthropic', 'openai', 'github', 'gemini', 'hermes', 'cursor', 'kimi', 'groq', 'grok'));

reset role;
