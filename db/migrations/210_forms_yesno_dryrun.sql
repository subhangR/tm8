-- =============================================================================
-- 210 — Forms W0 DRY RUN (DO NOT MERGE): the `yes_no` question type.
-- Proves 209's additivity claim: one arm, found by name by
-- internal.form_question_type_fn. Mirrors FORM_QUESTION_TYPES.yes_no.
-- =============================================================================

set role tm8_graph_owner;

-- yes_no: config {yesLabel?, noLabel?} (1..100 chars each); answer {bool}.
-- A boolean always says something: never `empty`.
create or replace function internal.form_qtype_yes_no(p_op text, p_config jsonb, p_answer jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare issues jsonb;
begin
  if p_op = 'config' then
    issues := internal.form_unknown_keys(p_config, array['yesLabel','noLabel']);
    if issues <> '[]'::jsonb then return issues; end if;
    if (p_config ? 'yesLabel' and (not internal.form_opt_string(p_config->'yesLabel', 100)
                                   or char_length(p_config->>'yesLabel') < 1))
       or (p_config ? 'noLabel' and (not internal.form_opt_string(p_config->'noLabel', 100)
                                     or char_length(p_config->>'noLabel') < 1)) then
      return internal.form_issue('invalid_config', 'labels must be strings of 1..100 chars');
    end if;
    return '[]'::jsonb;
  end if;

  if (select array_agg(k) from jsonb_object_keys(p_answer) k) is distinct from array['bool']
     or jsonb_typeof(p_answer->'bool') <> 'boolean' then
    return internal.form_issue('invalid_shape', 'answer must be {bool: boolean}');
  end if;
  return '[]'::jsonb;
end
$$;

reset role;
