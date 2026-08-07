-- =============================================================================
-- 079 — the core-default draft is a VALID Interaction Profile draft again.
--
-- NUMBERED 079, NOT 076: origin/main already carries a
-- `078_derived_from_props_schema.sql` that this branch does not. Claiming 076
-- here would collide on merge. A gap is the same kind of gap 025/026/028
-- already are, and `w2-migration-order.pg.test.ts:70` requires only that the
-- three-digit prefixes be UNIQUE and sorted — never contiguous.
--
-- WHAT WAS WRONG. 072 (`072_session_io_routes.sql:308`) had ONE intended change
-- to `internal.w2g12_core_draft()`, stated in its own comment: future core pins
-- accept the unified inbound envelope, so `promptPolicy.allowedInjectionKinds`
-- moves from `[]` to `["tm8.session-input"]`. To make that one-key change it
-- RE-TYPED the whole 30-line JSON literal — precisely the transcription risk
-- 051 named at its :29-32 when it declined to do the same thing — and the
-- retyped copy lost two required keys and gained one that does not exist:
--
--     promptPolicy.manifestMaxBytes   4096   DROPPED
--     promptPolicy.kernelMaxBytes     6144   DROPPED
--     description                            ADDED (no such field)
--
-- WHY THIS IS A DEFECT AND NOT A SCHEMA DISAGREEMENT. It is not the TypeScript
-- contract's opinion against the database's — the DATABASE ITSELF refuses this
-- draft. `internal.w2g12_assert_profile_draft_input` (027:455-467) demands
-- `promptPolicy ?& array[... 'manifestMaxBytes','kernelMaxBytes' ...]` and
-- closes the top-level key set to exactly eight names, of which `description`
-- is not one. So from 072 onward the canonical draft the migration chain ships
-- is one the chain's own validator would reject. `ClosedPromptPolicySchema`
-- (`packages/contract/src/schemas.ts:2016`) says the same thing independently.
--
-- WHAT IS AND IS NOT AFFECTED, stated rather than implied.
--   * `interactionProfiles.propose` / `.updateDraft` are NOT broken. They
--     rejected this draft because it is genuinely invalid; a caller sending a
--     conforming draft was always accepted. No public operation regressed.
--   * `internal.w1_core_pin_snapshot()` (051:81) embeds this draft whole, so
--     every core-default pin minted since 072 stores an invalid `draft` and an
--     `agentProjection.promptPolicy` with no manifest/kernel byte budget. No
--     runtime reader dereferences those two caps today (the only references in
--     the tree are the two schemas and their fixtures), and
--     `projectInteractionProfileForBrowser` reads only feedPolicy/composerPolicy
--     — so the loss is a declared budget going silently absent, not a crash.
--   * EXISTING PINS ARE LEFT ALONE, deliberately. A stored pin snapshot is
--     immutable and auditable; 015/051/072 all preserve that, and rewriting
--     history to hide a bad mint would be the worse defect. Pins minted from
--     here on are correct.
--
-- WHAT THIS MIGRATION CHANGES, and nothing else. 072's INTENT is preserved
-- verbatim: `allowedInjectionKinds` stays `["tm8.session-input"]` and the name
-- stays 072's "Core default". Only the three transcription errors are undone.
-- The two restored caps carry 027's original values (4096 / 6144), which are
-- also the schema maxima.
--
-- `create or replace function` makes this re-runnable, and it repairs a database
-- whose chain already reached 072 — including the live staging database, where
-- 072 is applied today.
-- =============================================================================

create or replace function internal.w2g12_core_draft() returns jsonb
language sql immutable parallel safe as $$
  select '{
    "name":"Core default",
    "templateKey":"tm8.chat.core",
    "templateVersion":1,
    "promptPolicy":{
      "kernelTemplate":"tm8.core.v1",
      "manifestMaxBytes":4096,
      "kernelMaxBytes":6144,
      "initialContextMaxBytes":32768,
      "rollingControlMaxBytes":32768,
      "allowedInjectionKinds":["tm8.session-input"],
      "untrustedEncoding":"escaped-xml"
    },
    "toolDiscoveryPolicy":{
      "rootHelpRef":"tm8://help",
      "preloadNouns":["entities","messages"],
      "semanticSearchEnabled":true,
      "semanticMaxMatches":5,
      "nounShardMaxBytes":8192,
      "commandShardMaxBytes":16384,
      "entityContextDefaultBytes":16384,
      "providerToolRegistrationAllowlist":["entities.get","messages.post"]
    },
    "feedPolicy":{"scope":"session_chat_v1","pageSize":50,"bodyExcerptBytes":1024},
    "providerCaptureMode":"explicit-only",
    "composerPolicy":{
      "schemaRef":"tm8.composer.v1",
      "supportsReply":true,
      "supportsAttachments":true,
      "allowedAttachmentKinds":["file"],
      "operationBindings":["messages.post","messages.attachments.add"]
    }
  }'::jsonb
$$;

-- The claim above, enforced rather than asserted in prose: the canonical draft
-- must pass the chain's own draft validator. If a later migration re-types this
-- literal again, the chain fails to apply here instead of shipping a core
-- default that nothing can propose.
do $$
begin
  perform internal.w2g12_assert_profile_draft_input(internal.w2g12_core_draft());
end
$$;

comment on function internal.w2g12_core_draft() is
  'Canonical core-default Interaction Profile draft. MUST satisfy '
  'internal.w2g12_assert_profile_draft_input and @tm8/contract '
  'InteractionProfileDraftSchema; 077 checks the first at apply time after 072 '
  're-typed the literal and dropped manifestMaxBytes/kernelMaxBytes.';
