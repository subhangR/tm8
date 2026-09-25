-- =============================================================================
-- 224 — an Interaction Profile draft can carry the keys the contract declares.
--
-- WHAT WAS WRONG. internal.w2g12_assert_profile_draft_input (027, its only
-- definition) admits EXACTLY 8 top-level draft keys and raises 22023 "invalid
-- Interaction Profile draft shape" for any other. The contract's
-- InteractionProfileDraftSchema has since gained four OPTIONAL keys, and none
-- could ever be saved through interactionProfiles.propose / updateDraft:
--   - initialContentSurface ('terminal' | 'chat')  — 051's pre-existing gap:
--     051 projects it into browserProjection, but no draft could carry it;
--   - contextIndex (boolean)                       — I5a #759: the profile half
--     of the <context_index> switch was unreachable;
--   - contextBudgets {memories, skills, references, teammates} (ints 0–32768)
--   - contextFloors  {memories, skills, references, teammates} (0–3)
--                                                  — I5b #761.
-- The zod tests passed because they never reach this SQL validator.
--
-- WHAT CHANGES. The whitelist admits those four, each typed exactly as the zod
-- schema types it (absent stays valid; present must be well-formed). Nothing
-- else is widened: an unknown top-level key is still refused. The pinned
-- snapshot already carries `draft` whole (051's w2g12_profile_snapshot), so a
-- saved key reaches spawn's contextIndexSwitch / contextBudgetsFrom unchanged.
--
-- 027 is applied everywhere and is never edited. This file carries the FULL
-- new body: migrate.mjs applies by filename, so the higher-numbered file is the
-- one Postgres keeps. `create or replace` keeps the function's ACL (it has no
-- grants of its own; it is called from 027's security-definer doors and 079).
-- Test: packages/server/test/db/profile-draft-context-keys.pg.test.ts.
-- =============================================================================

create or replace function internal.w2g12_assert_profile_draft_input(p_draft jsonb)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare policy jsonb; discovery jsonb; feed jsonb; composer jsonb;
begin
  if jsonb_typeof(p_draft) <> 'object'
     or not (p_draft ?& array[
       'name','templateKey','templateVersion','promptPolicy','toolDiscoveryPolicy',
       'feedPolicy','providerCaptureMode','composerPolicy'
     ])
     or exists (
       select 1 from jsonb_object_keys(p_draft) draft_key where draft_key not in (
         'name','templateKey','templateVersion','promptPolicy','toolDiscoveryPolicy',
         'feedPolicy','providerCaptureMode','composerPolicy',
         -- 224: the optional keys the contract already declares.
         'initialContentSurface','contextIndex','contextBudgets','contextFloors'
       )
     )
     or jsonb_typeof(p_draft -> 'name') <> 'string'
     or char_length(p_draft ->> 'name') not between 1 and 80
     or jsonb_typeof(p_draft -> 'templateKey') <> 'string'
     or btrim(p_draft ->> 'templateKey') = ''
     or jsonb_typeof(p_draft -> 'templateVersion') <> 'number'
     or (p_draft ->> 'templateVersion')::numeric <> trunc((p_draft ->> 'templateVersion')::numeric)
     or (p_draft ->> 'templateVersion')::integer < 1 then
    raise exception 'invalid Interaction Profile draft shape' using errcode = '22023';
  end if;
  -- 224: the four OPTIONAL keys, typed as InteractionProfileDraftSchema types
  -- them. Absent stays valid (every earlier draft); present must be well-formed.
  if (p_draft ? 'initialContentSurface'
        and (jsonb_typeof(p_draft -> 'initialContentSurface') <> 'string'
             or p_draft ->> 'initialContentSurface' not in ('terminal','chat')))
     or (p_draft ? 'contextIndex' and jsonb_typeof(p_draft -> 'contextIndex') <> 'boolean') then
    raise exception 'invalid Interaction Profile draft shape' using errcode = '22023';
  end if;
  if p_draft ? 'contextBudgets' and (
       jsonb_typeof(p_draft -> 'contextBudgets') <> 'object'
       or exists (
         select 1 from jsonb_each(p_draft -> 'contextBudgets') budget
          where budget.key not in ('memories','skills','references','teammates')
             or jsonb_typeof(budget.value) <> 'number'
             or (budget.value #>> '{}')::numeric <> trunc((budget.value #>> '{}')::numeric)
             or (budget.value #>> '{}')::numeric not between 0 and 32768
       )) then
    raise exception 'invalid Interaction Profile context budgets' using errcode = '22023';
  end if;
  if p_draft ? 'contextFloors' and (
       jsonb_typeof(p_draft -> 'contextFloors') <> 'object'
       or exists (
         select 1 from jsonb_each(p_draft -> 'contextFloors') floor_value
          where floor_value.key not in ('memories','skills','references','teammates')
             or jsonb_typeof(floor_value.value) <> 'number'
             or (floor_value.value #>> '{}')::numeric not between 0 and 3
       )) then
    raise exception 'invalid Interaction Profile context floors' using errcode = '22023';
  end if;
  if p_draft ->> 'providerCaptureMode' <> 'explicit-only' then
    raise exception 'provider capture mode is reserved in Phase 1'
      using errcode = '22023', detail = 'profile_capture_mode_reserved';
  end if;
  policy := p_draft -> 'promptPolicy';
  discovery := p_draft -> 'toolDiscoveryPolicy';
  feed := p_draft -> 'feedPolicy';
  composer := p_draft -> 'composerPolicy';
  if jsonb_typeof(policy) <> 'object'
     or not (policy ?& array['kernelTemplate','manifestMaxBytes','kernelMaxBytes',
       'initialContextMaxBytes','rollingControlMaxBytes','allowedInjectionKinds','untrustedEncoding'])
     or exists (select 1 from jsonb_object_keys(policy) k where k not in (
       'kernelTemplate','manifestMaxBytes','kernelMaxBytes','initialContextMaxBytes',
       'rollingControlMaxBytes','allowedInjectionKinds','untrustedEncoding'))
     or policy ->> 'untrustedEncoding' <> 'escaped-xml'
     or jsonb_typeof(policy -> 'allowedInjectionKinds') <> 'array'
     or (policy ->> 'manifestMaxBytes')::integer not between 1 and 4096
     or (policy ->> 'kernelMaxBytes')::integer not between 1 and 6144
     or (policy ->> 'initialContextMaxBytes')::integer not between 1 and 32768
     or (policy ->> 'rollingControlMaxBytes')::integer not between 1 and 32768 then
    raise exception 'invalid closed prompt policy' using errcode = '22023';
  end if;
  if jsonb_typeof(discovery) <> 'object'
     or not (discovery ?& array['rootHelpRef','preloadNouns','semanticSearchEnabled',
       'semanticMaxMatches','nounShardMaxBytes','commandShardMaxBytes','entityContextDefaultBytes'])
     or exists (select 1 from jsonb_object_keys(discovery) k where k not in (
       'rootHelpRef','preloadNouns','semanticSearchEnabled','semanticMaxMatches','nounShardMaxBytes',
       'commandShardMaxBytes','entityContextDefaultBytes','providerToolRegistrationAllowlist'))
     or discovery ->> 'rootHelpRef' <> 'tm8://help'
     or jsonb_typeof(discovery -> 'preloadNouns') <> 'array'
     or jsonb_typeof(discovery -> 'semanticSearchEnabled') <> 'boolean'
     or (discovery ->> 'semanticMaxMatches')::integer not between 0 and 5
     or (discovery ->> 'nounShardMaxBytes')::integer not between 1 and 32768
     or (discovery ->> 'commandShardMaxBytes')::integer not between 1 and 32768
     or (discovery ->> 'entityContextDefaultBytes')::integer not between 1024 and 32768
     or (discovery ? 'providerToolRegistrationAllowlist'
       and jsonb_typeof(discovery -> 'providerToolRegistrationAllowlist') <> 'array') then
    raise exception 'invalid tool discovery policy' using errcode = '22023';
  end if;
  if jsonb_typeof(feed) <> 'object'
     or not (feed ?& array['scope','pageSize','bodyExcerptBytes'])
     or exists (select 1 from jsonb_object_keys(feed) k where k not in ('scope','pageSize','bodyExcerptBytes'))
     or feed ->> 'scope' not in ('direct_v1','session_chat_v1')
     or (feed ->> 'pageSize')::integer not between 1 and 100
     or (feed ->> 'bodyExcerptBytes')::integer not between 0 and 4096 then
    raise exception 'invalid feed policy' using errcode = '22023';
  end if;
  if jsonb_typeof(composer) <> 'object'
     or not (composer ?& array['schemaRef','supportsReply','supportsAttachments',
       'allowedAttachmentKinds','operationBindings'])
     or exists (select 1 from jsonb_object_keys(composer) k where k not in (
       'schemaRef','supportsReply','supportsAttachments','allowedAttachmentKinds','operationBindings'))
     or jsonb_typeof(composer -> 'schemaRef') <> 'string'
     or jsonb_typeof(composer -> 'supportsReply') <> 'boolean'
     or jsonb_typeof(composer -> 'supportsAttachments') <> 'boolean'
     or jsonb_typeof(composer -> 'allowedAttachmentKinds') <> 'array'
     or jsonb_typeof(composer -> 'operationBindings') <> 'array' then
    raise exception 'invalid composer interaction policy' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_array_elements(policy -> 'allowedInjectionKinds') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(policy -> 'allowedInjectionKinds') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(policy -> 'allowedInjectionKinds') item
     )
     or exists (
       select 1 from jsonb_array_elements(discovery -> 'preloadNouns') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(discovery -> 'preloadNouns') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(discovery -> 'preloadNouns') item
     )
     or exists (
       select 1 from jsonb_array_elements(composer -> 'allowedAttachmentKinds') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(composer -> 'allowedAttachmentKinds') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(composer -> 'allowedAttachmentKinds') item
     )
     or exists (
       select 1 from jsonb_array_elements(composer -> 'operationBindings') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(composer -> 'operationBindings') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(composer -> 'operationBindings') item
     )
     or (discovery ? 'providerToolRegistrationAllowlist' and (
       exists (
         select 1 from jsonb_array_elements(discovery -> 'providerToolRegistrationAllowlist') item
          where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
       )
       or jsonb_array_length(discovery -> 'providerToolRegistrationAllowlist') <> (
         select count(distinct item #>> '{}')
           from jsonb_array_elements(discovery -> 'providerToolRegistrationAllowlist') item
       )
     )) then
    raise exception 'profile policy string arrays must contain unique non-empty strings'
      using errcode = '22023';
  end if;
end
$$;
