-- =============================================================================
-- 086 — the S15 manifest guard learns where a token STARTS.
--
-- THE OBSERVED DEFECT, both polarities, both measured on utho-prod 2026-08-09:
--
--   * FALSE POSITIVE. 073's pattern begins bare `sk-`, unanchored, so the tail
--     of the word "task" matches it: any manifest, persona, or task prompt
--     mentioning an ordinary slug like `task-0123456789abcdef` (branch names,
--     task ids — 16+ [A-Za-z0-9_-] chars after "…ta[sk-]") raised
--     `manifest appears to contain a credential value` and made the session
--     unspawnable, with a message pointing nowhere near the cause. A live prod
--     document ("…task-bodies…" prose) matches the same way.
--
--   * TRUE POSITIVE, WRONG LAYER. A member pasted a real `sk-ant-oat…` OAuth
--     token into a task DESCRIPTION; every launch of that task then died on
--     this guard. The guard was right to refuse — but the fix for that class
--     is upstream: `composeManifest` (@tm8/execution secret-redaction.ts) now
--     scrubs credential-shaped tokens out of every manifest string before
--     anything is persisted or put on argv, so the guard behind it can only
--     fire on a composer bug. This file makes the guard agree with the
--     redactor about what a token IS.
--
-- THE PATTERN. Postgres regexes have no lookbehind, so the left boundary is an
-- explicit group: `(^|[^A-Za-z0-9_-])` — a token starts at the beginning of
-- the text or after a character that cannot be part of one (in a rendered
-- jsonb manifest a real value is always preceded by `"`, a space, `=` or
-- `:`). The token grammar itself is widened to the GitHub prefixes that exist
-- (gho_/ghu_/ghs_/ghr_ and github_pat_) alongside 073's sk-/ghp_/xox set.
-- ⚠ PATTERN PARITY: this grammar is duplicated in
-- packages/execution/src/spawn/secret-redaction.ts (SECRET_TOKEN_SOURCE).
-- If the redactor is ever narrower than this guard, a string the redactor
-- passes kills the spawn here. Whoever changes one side must change both.
--
-- ⚠ SHARED-OBJECT NOTICE (the 052/…/073 rule, continued). This
-- `create or replace` swaps the ENTIRE function body. The base text is copied
-- verbatim from 073 — still the only later definition in the tree, verified by
-- grep across db/migrations — with ONLY the pattern constant changed.
-- WHOEVER TOUCHES THIS FUNCTION NEXT MUST COPY THIS FILE'S BODY.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.guard_manifest_secrets() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  rendered text := new.manifest::text;
  secret_pattern constant text :=
    '(^|[^A-Za-z0-9_-])'
    '(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})';
begin
  if rendered ~ secret_pattern then
    raise exception 'manifest appears to contain a credential value'
      using errcode = '23514',
            detail = 'session_manifests stores env var NAMES, never values (S15)';
  end if;
  -- 073: the launch prompts are covered by the same rule as the manifest.
  if coalesce(new.system_prompt, '') ~ secret_pattern
     or coalesce(new.task_prompt, '') ~ secret_pattern then
    raise exception 'launch prompt appears to contain a credential value'
      using errcode = '23514',
            detail = 'session_manifests stores env var NAMES, never values (S15)';
  end if;
  if exists (
    select 1 from unnest(new.env_var_names) as n
     where n !~ '^[A-Z][A-Z0-9_]{0,80}$'
  ) then
    raise exception 'env_var_names must be environment variable names, not values'
      using errcode = '22023';
  end if;
  return new;
end
$$;

reset role;
