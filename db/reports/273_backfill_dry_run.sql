-- session_credential_binding backfill dry run: READ ONLY, counts only, no secret column.
-- Operator report for the one-time legacy backfill in
-- the session_credential_binding migration. The block between the
-- BEGIN/END markers is byte-for-byte the migration's predicate (a test
-- compares the two texts). Run this file with psql -X -f
-- Columns read: session_manifests.work_session_id, session_manifests.manifest
-- (launch.effectiveCredentialSources only), session_space_credentials keys.
begin read only;
-- BEGIN SESSION_CREDENTIAL_BINDING BACKFILL PREDICATE
with manifest_rollup as (
  select sm.work_session_id,
         case
           when jsonb_typeof(sm.manifest #> '{launch,effectiveCredentialSources}') is distinct from 'object'
             or sm.manifest #> '{launch,effectiveCredentialSources}' = '{}'::jsonb
             then 'no_effective_map'
           when exists (select 1 from jsonb_each_text(sm.manifest #> '{launch,effectiveCredentialSources}') src
                         where src.value in ('member', 'node'))
             then 'any_used_provider_on_removed_rung'
           when not exists (select 1 from jsonb_each_text(sm.manifest #> '{launch,effectiveCredentialSources}') src
                             where src.value is distinct from 'space')
             then 'every_used_provider_names_a_credential'
           else 'unrecognized_source'
         end as bucket
    from public.session_manifests sm
)
-- END SESSION_CREDENTIAL_BINDING BACKFILL PREDICATE
select
  count(*) filter (where bucket = 'every_used_provider_names_a_credential') as every_used_provider_names_a_credential,
  count(*) filter (where bucket = 'any_used_provider_on_removed_rung')      as any_used_provider_on_removed_rung,
  count(*) filter (where bucket = 'no_effective_map')                       as no_effective_map,
  count(*) filter (where bucket = 'unrecognized_source')                    as unrecognized_source,
  (select count(*) from public.session_space_credentials)                   as existing_ssc_rows_to_project,
  count(*)                                                                  as total
from manifest_rollup;
rollback;
