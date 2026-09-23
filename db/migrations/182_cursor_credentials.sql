-- =============================================================================
-- 124 — CURSOR AS A MEASURED CREDENTIAL PROVIDER.
--
-- WHY BOTH CHECKS MOVE TOGETHER. Cursor credentials are FILE-shaped: Cursor
-- Agent 2026.09.02-c22c1a3 writes `.cursor/cli-config.json` beneath the
-- member's isolated HOME. Its metadata therefore belongs in 083's
-- `account_agent_credentials` beside the other four file-shaped providers.
-- `credential_sessions`, meanwhile, describes every login terminal and must
-- admit all six declared providers, including string-shaped GitHub.
--
-- WHY GITHUB IS STILL ABSENT FROM THE FIRST CHECK. Its credential is a token
-- string stored by 079/093 in `account_git_credentials`; adding it to the
-- FILE-shaped metadata index would create two authorities for one credential.
--
-- WHAT WAS MEASURED. The `cursor-agent` binary is present on this node,
-- `cursor-agent login` is its login verb, `cursor-agent status --format json`
-- reports the boolean `isAuthenticated`, and its credential storage is
-- `$HOME/.cursor/cli-config.json`. This widening records those observations;
-- it is not admission by plausible command name.
--
-- `drop constraint` + `add constraint` follows the existing CHECK-widening
-- idiom: PostgreSQL has no replace form, and 083's inline CHECKs gave these
-- constraints their stable generated names.
-- =============================================================================

set role tm8_graph_owner;

alter table public.account_agent_credentials
  drop constraint account_agent_credentials_provider_check;

alter table public.account_agent_credentials
  add constraint account_agent_credentials_provider_check
    check (provider in ('anthropic', 'openai', 'gemini', 'hermes', 'cursor'));

alter table public.credential_sessions
  drop constraint credential_sessions_provider_check;

alter table public.credential_sessions
  add constraint credential_sessions_provider_check
    check (provider in ('anthropic', 'openai', 'github', 'gemini', 'hermes', 'cursor'));

reset role;
