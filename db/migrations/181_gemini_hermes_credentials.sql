-- =============================================================================
-- 123 — GEMINI AND HERMES AS DECLARED CREDENTIAL PROVIDERS.
--
-- WHY BOTH CHECKS MOVE TOGETHER. Gemini and Hermes credentials are
-- FILE-shaped: their CLIs write beneath the member's per-identity HOME rather
-- than yielding a token string for a database column. Their metadata therefore
-- belongs in 083's `account_agent_credentials` beside Anthropic and OpenAI.
-- `credential_sessions`, meanwhile, describes every login terminal and must
-- admit all five declared providers, including string-shaped GitHub.
--
-- WHY GITHUB IS STILL ABSENT FROM THE FIRST CHECK. Its credential is a token
-- string stored by 079/093 in `account_git_credentials`; adding it to the
-- FILE-shaped metadata index would create two authorities for one credential.
--
-- WHAT THIS DOES NOT CLAIM. Neither `gemini` nor `hermes` is installed on the
-- node where this provider set was declared, so neither login flow was measured
-- there. Migration 083's admission rule is preserved by the runtime
-- availability result and the start gate: an absent CLI is reported as
-- `unavailable`, and login-session start refuses before minting a work session
-- or launching a PTY. These widened storage constraints do not substitute for
-- that measurement.
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
    check (provider in ('anthropic', 'openai', 'gemini', 'hermes'));

alter table public.credential_sessions
  drop constraint credential_sessions_provider_check;

alter table public.credential_sessions
  add constraint credential_sessions_provider_check
    check (provider in ('anthropic', 'openai', 'github', 'gemini', 'hermes'));

reset role;
