-- =============================================================================
-- 263 (262 is claimed by open PRs #866, #915 and #923) — a choice question's write-in ("Other") is ON unless the author says no.
--
-- User ruling (task 01a0df2d): every single_choice / multi_choice question lets
-- the respondent add their own choice as the last option. The contract's
-- `allowOther` default moves from false to true in the same change
-- (packages/contract/src/forms.ts), so this migration moves SQL's with it.
-- Config is stored SPARSE and defaults apply on read (§3.3), so this reaches
-- every existing question with no `allowOther` key; one that says
-- `allowOther: false` still refuses a write-in.
--
-- WHAT LANDS. 209's two choice arms, verbatim except for one predicate each:
--   coalesce((p_config->'allowOther') = 'true'::jsonb, false) is false
-- becomes
--   (p_config->'allowOther') = 'false'::jsonb
-- i.e. absent ⇒ allowed. Parity: packages/server/test/db/forms-parity.pg.test.ts
-- against packages/contract/test/fixtures/form-parity.ts ("allowed by default").
-- =============================================================================

-- single_choice: config {options, allowOther? (default true), display?}; answer {value} | {other}.
create or replace function internal.form_qtype_single_choice(p_op text, p_config jsonb, p_answer jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare issues jsonb;
begin
  if p_op = 'config' then
    issues := internal.form_unknown_keys(p_config, array['options','allowOther','display']);
    if issues <> '[]'::jsonb then return issues; end if;
    issues := internal.form_options_issues(p_config->'options', 1);
    if issues <> '[]'::jsonb then return issues; end if;
    if not internal.form_opt_bool(p_config->'allowOther') then
      return internal.form_issue('invalid_config', 'allowOther must be a boolean');
    end if;
    if p_config ? 'display' and (p_config->>'display') is distinct from 'radio'
       and (p_config->>'display') is distinct from 'dropdown' then
      return internal.form_issue('invalid_config', 'display must be radio or dropdown');
    end if;
    return '[]'::jsonb;
  end if;

  -- answer
  if (select array_agg(k order by k) from jsonb_object_keys(p_answer) k) = array['value'] then
    if jsonb_typeof(p_answer->'value') <> 'string' then
      return internal.form_issue('invalid_shape', 'value must be a string');
    end if;
    if not exists (select 1 from jsonb_array_elements(p_config->'options') o
                    where o->>'value' = p_answer->>'value') then
      return internal.form_issue('not_an_option', format('%L is not one of the options', p_answer->>'value'));
    end if;
    return '[]'::jsonb;
  elsif (select array_agg(k order by k) from jsonb_object_keys(p_answer) k) = array['other'] then
    if jsonb_typeof(p_answer->'other') <> 'string' then
      return internal.form_issue('invalid_shape', 'other must be a string');
    end if;
    if (p_config->'allowOther') = 'false'::jsonb then
      return internal.form_issue('other_not_allowed', 'this question does not accept a write-in');
    end if;
    if internal.form_blank(p_answer->>'other') then
      return internal.form_issue('invalid_shape', 'other must not be blank');
    end if;
    if char_length(p_answer->>'other') > 2000 then
      return internal.form_issue('too_long', 'other must be at most 2000 chars');
    end if;
    return '[]'::jsonb;
  end if;
  return internal.form_issue('invalid_shape', 'answer must be {value} or {other}');
end
$$;

-- multi_choice: config {options, allowOther? (default true), minSelected?, maxSelected?};
-- answer {values[], other?}.
create or replace function internal.form_qtype_multi_choice(p_op text, p_config jsonb, p_answer jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare
  issues jsonb := '[]'::jsonb;
  selected int;
  bad text;
begin
  if p_op = 'config' then
    issues := internal.form_unknown_keys(p_config, array['options','allowOther','minSelected','maxSelected']);
    if issues <> '[]'::jsonb then return issues; end if;
    issues := internal.form_options_issues(p_config->'options', 50);
    if issues <> '[]'::jsonb then return issues; end if;
    if not internal.form_opt_bool(p_config->'allowOther') then
      return internal.form_issue('invalid_config', 'allowOther must be a boolean');
    end if;
    if not internal.form_int_in(p_config->'minSelected', 0, 50) then
      return internal.form_issue('invalid_config', 'minSelected must be an integer 0..50');
    end if;
    if not internal.form_int_in(p_config->'maxSelected', 1, 50) then
      return internal.form_issue('invalid_config', 'maxSelected must be an integer 1..50');
    end if;
    if (p_config->>'minSelected')::numeric > (p_config->>'maxSelected')::numeric then
      return internal.form_issue('invalid_config', 'minSelected must not exceed maxSelected');
    end if;
    return '[]'::jsonb;
  end if;

  -- answer: shape first, and a shape failure is the only issue reported.
  if not (p_answer ? 'values')
     or internal.form_unknown_keys(p_answer, array['values','other']) <> '[]'::jsonb
     or jsonb_typeof(p_answer->'values') <> 'array'
     or exists (select 1 from jsonb_array_elements(p_answer->'values') v where jsonb_typeof(v) <> 'string')
     or (p_answer ? 'other' and jsonb_typeof(p_answer->'other') <> 'string') then
    return internal.form_issue('invalid_shape', 'answer must be {values: string[], other?: string}');
  end if;
  if (select count(*) <> count(distinct v) from jsonb_array_elements_text(p_answer->'values') v) then
    return internal.form_issue('invalid_shape', 'values must not repeat');
  end if;

  select string_agg(format('%L', v), ', ' order by ord) into bad
    from jsonb_array_elements_text(p_answer->'values') with ordinality as t(v, ord)
   where not exists (select 1 from jsonb_array_elements(p_config->'options') o where o->>'value' = v);
  if bad is not null then
    issues := issues || internal.form_issue('not_an_option', bad || ' not among the options');
  end if;
  if p_answer ? 'other' then
    if (p_config->'allowOther') = 'false'::jsonb then
      issues := issues || internal.form_issue('other_not_allowed', 'this question does not accept a write-in');
    elsif internal.form_blank(p_answer->>'other') then
      issues := issues || internal.form_issue('invalid_shape', 'other must not be blank');
    elsif char_length(p_answer->>'other') > 2000 then
      issues := issues || internal.form_issue('too_long', 'other must be at most 2000 chars');
    end if;
  end if;

  selected := jsonb_array_length(p_answer->'values') + (case when p_answer ? 'other' then 1 else 0 end);
  if selected = 0 then
    return internal.form_issue('empty', 'nothing selected');
  end if;
  if selected < coalesce((p_config->>'minSelected')::int, 0) then
    issues := issues || internal.form_issue('too_few',
      format('select at least %s', p_config->>'minSelected'));
  end if;
  if p_config ? 'maxSelected' and selected > (p_config->>'maxSelected')::int then
    issues := issues || internal.form_issue('too_many',
      format('select at most %s', p_config->>'maxSelected'));
  end if;
  return issues;
end
$$;
