-- =============================================================================
-- 209 — Forms W0: the `form` core kind, its data model, and the question-type
-- validator (task 01a0d32e; design docs/features/forms/FORMS-DESIGN.md v3,
-- commit 5d25d0ed; amend-model ruling by the W0 advisor, 2026-09-24).
--
-- WHAT IS HERE
--   1. `form` core kind (icon clipboard-list); `authored_from` and
--      `attached_to` accept a form as a SOURCE.
--   2. Tables: forms, form_sections, form_questions, form_responses,
--      form_deliveries. Constraints live here (T-L4), not in TypeScript.
--   3. The question-type validator: ONE SQL function per type,
--      `internal.form_qtype_<type>(op, config, answer)`, found BY NAME.
--   4. The response revision model (amend), its triggers and its indexes.
--   5. Two internal cores, `internal.form_save_draft` and
--      `internal.form_submit`: §7.1 steps 1-2 plus the revision flip. W1 wraps
--      them in the public SECURITY DEFINER doors (ledger, auth, message,
--      delivery, closeOnSubmit, attention). Nothing here is granted to
--      tm8_app except SELECT under RLS.
--   6. `internal.entity_content` gains a `form` arm.
--
-- NOT HERE (W1/W2): catalog rows, public RPCs, HTTP, CLI, UI, delivery.
--
-- -----------------------------------------------------------------------------
-- ADDING A QUESTION TYPE (the W0 gate: `yes_no` must need nothing else)
--   SQL: one migration that creates
--          internal.form_qtype_<type>(p_op text, p_config jsonb, p_answer jsonb)
--        returning a jsonb array of {code, message}. p_op = 'config' checks a
--        question's config; p_op = 'answer' checks one answer object (config
--        already valid, apply its defaults). Return [{"code":"empty"}] for a
--        well-formed answer that says nothing (blank text): the generic
--        caller turns that into `required` or accepts it. Nothing else in SQL
--        names a type: the dispatcher resolves the function with
--        to_regprocedure, and `form_questions.type` is valid exactly when
--        that function exists.
--   TS:  one entry in FORM_QUESTION_TYPES (packages/contract/src/forms.ts).
--
-- -----------------------------------------------------------------------------
-- THE AMEND MODEL (decision 8: allowAmend defaults to TRUE)
--   Every submission is an immutable row. An edit-and-resubmit is revision
--   N+1 with supersedes_id = N; the submit transaction flips N.is_current to
--   false and then promotes N+1. The chain's identity is `lineage_key`:
--
--     settings.responses | lineage_key          | one current row per
--     -------------------+----------------------+-----------------------
--     per_member         | respondent_id        | member
--     single             | form_id              | form
--     unlimited          | id of revision 1     | chain
--
--   ONE partial unique index, form_responses_one_current (form_id,
--   lineage_key) WHERE is_current, is the response limit for all three modes,
--   lock-free. It counts slots (respondents under per_member), never
--   revisions. A 23505 on it means 409 form_response_limit; the cores below
--   map it, and W1 must never let a raw 23505 reach a client.
--
--   Drafts are never current (is_current defaults to false; CHECK). One
--   in-flight draft per MEMBER per form, any mode:
--   form_responses_one_draft_per_member (form_id, respondent_id) WHERE
--   status = 'draft' (→ 409 conflict). Per member, not per lineage, because
--   under 'single' every lineage is the form, and members must be able to
--   draft in parallel and race to submit (the loser gets form_response_limit).
--   ACCEPTED CONSEQUENCE under 'unlimited': a member holding an amend draft
--   cannot start a new chain until they submit or discard it. W1's
--   responses.save must refuse that mismatch with a 409 naming the existing
--   draft, never silently overwrite it (form_save_draft does exactly that).
--
--   Fork protection: UNIQUE (supersedes_id) — two concurrent amends of
--   revision N cannot both land.
--
--   `lineage_key` is derived from settings.responses, so the responses mode
--   freezes with the questions, at the first SUBMITTED response (decision 7):
--   ONE freeze rule, one error, form_structure_frozen. Drafts do not freeze a
--   form; a mode change before the first submit rewrites the drafts'
--   lineage_key in the same transaction (they are all revision 1).
--
-- -----------------------------------------------------------------------------
-- SUBMIT LOCK SCOPE (§7.1)
--   The forms row, FOR NO KEY UPDATE, and nothing table-wide.
--   * Not FOR SHARE: closeOnSubmit writes the form, so two submitters holding
--     SHARE would both try to upgrade and deadlock.
--   * Not FOR UPDATE: every insert into form_responses/form_questions takes
--     FOR KEY SHARE on forms through the FK, and FOR UPDATE would block draft
--     autosaves for the whole submit. NO KEY UPDATE does not conflict with
--     KEY SHARE.
--   Beyond that: the superseded response row (locked by the flip) and the
--   caller's draft row (FOR UPDATE). The limit is the unique index, not a
--   count. Submits to one form serialise, which costs nothing at human rate.
--   Question edits take the same form-row lock (form_questions trigger), so
--   an edit racing the first submit is decided by that lock, not by luck.
--
-- -----------------------------------------------------------------------------
-- ERRORS. The closed taxonomy is decided by SQLSTATE alone
-- (packages/server/src/http/errors.ts), so each form refusal has its own:
--   TFA01 form_answers_invalid (422)  DETAIL = {"reason":..,"issues":[{key,code,message}]}
--   TFN01 form_not_open (409)         TFS01 form_structure_frozen (409)
--   TFL01 form_response_limit (409)   TFR01 form_respondent_not_allowed (403)
--   TFD01 conflict (409): a draft already in flight for another target
--   40001 version_conflict: the revision you amended is no longer current
--
-- SHARED-OBJECT NOTICE (053/055/.../194): §6 REPLACES internal.entity_content.
-- Body copied VERBATIM from 194 — the latest definition (verified: nothing in
-- 195..208 on any remote ref touches it) — plus one `form` arm.
--
-- NUMBERED 209: the union of db/migrations over every origin ref tops out at
-- 208 (measured 2026-09-24, and confirmed by the W0 advisor).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry and edges. APPEND, never a full-array rewrite (052's lesson).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('form', 'core', null, 'clipboard-list')
on conflict (kind) where space_id is null do nothing;

-- form -> work_session: the requesting session, the delivery target (§3.2).
update public.edge_types
   set src_kinds = array_append(src_kinds, 'form')
 where type = 'authored_from'
   and not ('form' = any(src_kinds));

-- form -> task: the form shows up on the task (§3.2).
update public.edge_types
   set src_kinds = array_append(src_kinds, 'form')
 where type = 'attached_to'
   and not ('form' = any(src_kinds));

-- -----------------------------------------------------------------------------
-- 2. Small pure helpers shared by the arms. None of them names a type.
-- -----------------------------------------------------------------------------
create or replace function internal.form_issue(p_code text, p_message text)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select jsonb_build_array(jsonb_build_object('code', p_code, 'message', p_message))
$$;

-- An integral JSON number. `5.0` counts, as it does for JSON.parse in TS.
create or replace function internal.form_is_int(p_value jsonb)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_value is not null and jsonb_typeof(p_value) = 'number'
     and (p_value::text::numeric % 1) = 0
$$;

-- Integer in [lo, hi], or absent. Absent is the caller's default.
create or replace function internal.form_int_in(p_value jsonb, p_lo int, p_hi int)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_value is null
      or (internal.form_is_int(p_value)
          and p_value::text::numeric between p_lo and p_hi)
$$;

-- Optional string of at most p_max characters (code points, like TS [...s]).
create or replace function internal.form_opt_string(p_value jsonb, p_max int)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_value is null
      or (jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') <= p_max)
$$;

create or replace function internal.form_opt_bool(p_value jsonb)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_value is null or jsonb_typeof(p_value) = 'boolean'
$$;

-- Blank = only ASCII space/tab/CR/LF. Deliberately NOT \s or JS trim(): those
-- disagree across engines (NBSP, locale), and the parity test would catch it.
create or replace function internal.form_blank(p_text text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select btrim(p_text, E' \t\r\n') = ''
$$;

-- Keys of p_obj that are not in p_allowed, as one invalid_config issue.
create or replace function internal.form_unknown_keys(p_obj jsonb, p_allowed text[])
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select internal.form_issue('invalid_config',
              'unknown config key(s): ' || string_agg(k, ', ' order by k))
       from jsonb_object_keys(p_obj) k
      where not (k = any(p_allowed))
     having count(*) > 0),
    '[]'::jsonb)
$$;

-- The options list both choice types share (§4). Shared shape, not a type
-- switch: each choice arm calls it with its own recommended rule.
create or replace function internal.form_options_issues(p_options jsonb, p_max_recommended int)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare
  opt jsonb;
  seen text[] := '{}';
  recommended int := 0;
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    return internal.form_issue('invalid_config', 'options must be an array');
  end if;
  if jsonb_array_length(p_options) not between 2 and 50 then
    return internal.form_issue('invalid_config', 'options must have 2..50 entries');
  end if;
  for opt in select value from jsonb_array_elements(p_options) loop
    if jsonb_typeof(opt) <> 'object' then
      return internal.form_issue('invalid_config', 'each option must be an object');
    end if;
    if internal.form_unknown_keys(opt, array['value','label','help','recommended']) <> '[]'::jsonb then
      return internal.form_issue('invalid_config', 'unknown option key');
    end if;
    if jsonb_typeof(opt->'value') is distinct from 'string'
       or char_length(opt->>'value') not between 1 and 200 then
      return internal.form_issue('invalid_config', 'option value must be a string of 1..200 chars');
    end if;
    if jsonb_typeof(opt->'label') is distinct from 'string'
       or char_length(opt->>'label') not between 1 and 500 then
      return internal.form_issue('invalid_config', 'option label must be a string of 1..500 chars');
    end if;
    if not internal.form_opt_string(opt->'help', 2000) then
      return internal.form_issue('invalid_config', 'option help must be a string of at most 2000 chars');
    end if;
    if not internal.form_opt_bool(opt->'recommended') then
      return internal.form_issue('invalid_config', 'option recommended must be a boolean');
    end if;
    if (opt->>'value') = any(seen) then
      return internal.form_issue('invalid_config', format('duplicate option value %L', opt->>'value'));
    end if;
    seen := seen || (opt->>'value');
    if (opt->'recommended') = 'true'::jsonb then recommended := recommended + 1; end if;
  end loop;
  if recommended > p_max_recommended then
    return internal.form_issue('invalid_config',
      format('at most %s option(s) may be recommended', p_max_recommended));
  end if;
  return '[]'::jsonb;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. THE ARMS. One function per type; the only per-type code in SQL.
--    Each mirrors its FORM_QUESTION_TYPES entry exactly (parity test:
--    packages/server/test/db/forms-parity.pg.test.ts).
-- -----------------------------------------------------------------------------

-- single_choice: config {options, allowOther?, display?}; answer {value} | {other}.
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
    if coalesce((p_config->'allowOther') = 'true'::jsonb, false) is false then
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

-- multi_choice: config {options, allowOther?, minSelected?, maxSelected?};
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
    if coalesce((p_config->'allowOther') = 'true'::jsonb, false) is false then
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

-- short_text: config {placeholder?, maxLength? (1..500, default 500), pattern?};
-- answer {text}. `pattern` must match the WHOLE text.
create or replace function internal.form_qtype_short_text(p_op text, p_config jsonb, p_answer jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare
  issues jsonb := '[]'::jsonb;
  t text;
begin
  if p_op = 'config' then
    issues := internal.form_unknown_keys(p_config, array['placeholder','maxLength','pattern']);
    if issues <> '[]'::jsonb then return issues; end if;
    if not internal.form_opt_string(p_config->'placeholder', 200) then
      return internal.form_issue('invalid_config', 'placeholder must be a string of at most 200 chars');
    end if;
    if not internal.form_int_in(p_config->'maxLength', 1, 500) then
      return internal.form_issue('invalid_config', 'maxLength must be an integer 1..500');
    end if;
    if p_config ? 'pattern' then
      if jsonb_typeof(p_config->'pattern') <> 'string'
         or char_length(p_config->>'pattern') not between 1 and 500 then
        return internal.form_issue('invalid_config', 'pattern must be a string of 1..500 chars');
      end if;
      begin
        perform '' ~ ('^(?:' || (p_config->>'pattern') || ')$');
      exception when invalid_regular_expression then
        return internal.form_issue('invalid_config', 'pattern is not a valid regular expression');
      end;
    end if;
    return '[]'::jsonb;
  end if;

  if (select array_agg(k) from jsonb_object_keys(p_answer) k) is distinct from array['text']
     or jsonb_typeof(p_answer->'text') <> 'string' then
    return internal.form_issue('invalid_shape', 'answer must be {text: string}');
  end if;
  t := p_answer->>'text';
  if internal.form_blank(t) then
    return internal.form_issue('empty', 'blank');
  end if;
  if char_length(t) > coalesce((p_config->>'maxLength')::int, 500) then
    issues := issues || internal.form_issue('too_long',
      format('at most %s chars', coalesce((p_config->>'maxLength')::int, 500)));
  end if;
  if p_config ? 'pattern' and t !~ ('^(?:' || (p_config->>'pattern') || ')$') then
    issues := issues || internal.form_issue('pattern_mismatch', 'does not match the required pattern');
  end if;
  return issues;
end
$$;

-- long_text: config {placeholder?, minLength? (0..20000), maxLength? (1..20000,
-- default 20000)}; answer {text} (markdown).
create or replace function internal.form_qtype_long_text(p_op text, p_config jsonb, p_answer jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare
  issues jsonb := '[]'::jsonb;
  t text;
begin
  if p_op = 'config' then
    issues := internal.form_unknown_keys(p_config, array['placeholder','minLength','maxLength']);
    if issues <> '[]'::jsonb then return issues; end if;
    if not internal.form_opt_string(p_config->'placeholder', 200) then
      return internal.form_issue('invalid_config', 'placeholder must be a string of at most 200 chars');
    end if;
    if not internal.form_int_in(p_config->'minLength', 0, 20000) then
      return internal.form_issue('invalid_config', 'minLength must be an integer 0..20000');
    end if;
    if not internal.form_int_in(p_config->'maxLength', 1, 20000) then
      return internal.form_issue('invalid_config', 'maxLength must be an integer 1..20000');
    end if;
    if coalesce((p_config->>'minLength')::int, 0) > coalesce((p_config->>'maxLength')::int, 20000) then
      return internal.form_issue('invalid_config', 'minLength must not exceed maxLength');
    end if;
    return '[]'::jsonb;
  end if;

  if (select array_agg(k) from jsonb_object_keys(p_answer) k) is distinct from array['text']
     or jsonb_typeof(p_answer->'text') <> 'string' then
    return internal.form_issue('invalid_shape', 'answer must be {text: string}');
  end if;
  t := p_answer->>'text';
  if internal.form_blank(t) then
    return internal.form_issue('empty', 'blank');
  end if;
  if char_length(t) < coalesce((p_config->>'minLength')::int, 0) then
    issues := issues || internal.form_issue('too_short', format('at least %s chars', p_config->>'minLength'));
  end if;
  if char_length(t) > coalesce((p_config->>'maxLength')::int, 20000) then
    issues := issues || internal.form_issue('too_long',
      format('at most %s chars', coalesce((p_config->>'maxLength')::int, 20000)));
  end if;
  return issues;
end
$$;

-- scale: config {min? (0|1, default 1), max? (2..10, default 5), minLabel?,
-- maxLabel?}; answer {number} (integer).
create or replace function internal.form_qtype_scale(p_op text, p_config jsonb, p_answer jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare issues jsonb; lo int; hi int;
begin
  if p_op = 'config' then
    issues := internal.form_unknown_keys(p_config, array['min','max','minLabel','maxLabel']);
    if issues <> '[]'::jsonb then return issues; end if;
    if not internal.form_int_in(p_config->'min', 0, 1) then
      return internal.form_issue('invalid_config', 'min must be 0 or 1');
    end if;
    if not internal.form_int_in(p_config->'max', 2, 10) then
      return internal.form_issue('invalid_config', 'max must be an integer 2..10');
    end if;
    if not internal.form_opt_string(p_config->'minLabel', 100)
       or not internal.form_opt_string(p_config->'maxLabel', 100) then
      return internal.form_issue('invalid_config', 'labels must be strings of at most 100 chars');
    end if;
    return '[]'::jsonb;
  end if;

  if (select array_agg(k) from jsonb_object_keys(p_answer) k) is distinct from array['number']
     or not internal.form_is_int(p_answer->'number') then
    return internal.form_issue('invalid_shape', 'answer must be {number: integer}');
  end if;
  lo := coalesce((p_config->>'min')::int, 1);
  hi := coalesce((p_config->>'max')::int, 5);
  if (p_answer->>'number')::numeric not between lo and hi then
    return internal.form_issue('out_of_range', format('must be between %s and %s', lo, hi));
  end if;
  return '[]'::jsonb;
end
$$;

-- -----------------------------------------------------------------------------
-- 4. The dispatcher. Resolves the arm BY NAME; the type grammar is checked
--    first so the name can never be anything but an identifier.
-- -----------------------------------------------------------------------------
create or replace function internal.form_question_type_fn(p_type text)
returns regprocedure language sql stable set search_path = public, internal, pg_temp as $$
  select case when p_type ~ '^[a-z][a-z0-9_]{0,40}$'
              then to_regprocedure(format('internal.form_qtype_%s(text,jsonb,jsonb)', p_type))
         end
$$;

create or replace function internal.form_question_call(p_type text, p_op text, p_config jsonb, p_answer jsonb)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  fn regprocedure := internal.form_question_type_fn(p_type);
  result jsonb;
begin
  if fn is null then
    return internal.form_issue('unknown_type', format('unknown question type %L', p_type));
  end if;
  execute format('select %s($1, $2, $3)', fn::oid::regproc::text) into result
    using p_op, coalesce(p_config, '{}'::jsonb), p_answer;
  return coalesce(result, '[]'::jsonb);
end
$$;

-- Config check for one question: [] when valid.
create or replace function internal.form_question_config_issues(p_type text, p_config jsonb)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    return internal.form_issue('invalid_config', 'config must be an object');
  end if;
  return internal.form_question_call(p_type, 'config', p_config, null);
end
$$;

-- Validate answers against a question list (jsonb array of {key, type,
-- required?, config?}). Returns [{key, code, message}], [] when valid.
-- final = false is a draft save: shape and bounds, no `required`.
-- The generic rules — unknown keys, null = unanswered, non-object answers,
-- `empty` -> required — live HERE, and are the same for every type.
create or replace function internal.validate_form_answers_against(
  p_questions jsonb, p_answers jsonb, p_final boolean
) returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  q jsonb;
  a jsonb;
  issue jsonb;
  arm jsonb;
  v_out jsonb := '[]'::jsonb;
  required boolean;
  k text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_array(jsonb_build_object('key', '$', 'code', 'invalid_shape',
      'message', 'answers must be an object keyed by question key'));
  end if;
  for q in select value from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) loop
    a := p_answers -> (q->>'key');
    required := coalesce((q->'required') = 'true'::jsonb, not (q ? 'required'));
    if a is null or a = 'null'::jsonb then
      if p_final and required then
        v_out := v_out || jsonb_build_array(jsonb_build_object('key', q->>'key', 'code', 'required',
          'message', 'an answer is required'));
      end if;
      continue;
    end if;
    if jsonb_typeof(a) <> 'object' then
      v_out := v_out || jsonb_build_array(jsonb_build_object('key', q->>'key', 'code', 'invalid_shape',
        'message', 'an answer must be an object'));
      continue;
    end if;
    arm := internal.form_question_call(q->>'type', 'answer', q->'config', a);
    if jsonb_array_length(arm) = 1 and arm->0->>'code' = 'empty' then
      if p_final and required then
        v_out := v_out || jsonb_build_array(jsonb_build_object('key', q->>'key', 'code', 'required',
          'message', 'an answer is required'));
      end if;
      continue;
    end if;
    for issue in select value from jsonb_array_elements(arm) loop
      v_out := v_out || jsonb_build_array(jsonb_build_object('key', q->>'key') || issue);
    end loop;
  end loop;
  for k in select ak from jsonb_object_keys(p_answers) ak
            where not exists (select 1 from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) qq
                               where qq->>'key' = ak)
            order by ak loop
    v_out := v_out || jsonb_build_array(jsonb_build_object('key', k, 'code', 'unknown_question',
      'message', 'no question has this key'));
  end loop;
  return v_out;
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Settings (§3.3). Stored sparse; defaults applied on read, and mirrored
--    by FormSettingsSchema in the contract.
-- -----------------------------------------------------------------------------
create or replace function internal.form_settings_issues(p_settings jsonb)
returns text language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare d jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    return 'settings must be an object';
  end if;
  if internal.form_unknown_keys(p_settings,
       array['responses','respondents','closeOnSubmit','allowAmend','delivery','attentionPoints']) <> '[]'::jsonb then
    return 'unknown settings key';
  end if;
  if p_settings ? 'responses' and not ((p_settings->>'responses') = any(array['per_member','single','unlimited'])
                                       and jsonb_typeof(p_settings->'responses') = 'string') then
    return 'responses must be per_member, single or unlimited';
  end if;
  if p_settings ? 'respondents' and not ((p_settings->>'respondents') = any(array['humans','anyone'])
                                         and jsonb_typeof(p_settings->'respondents') = 'string') then
    return 'respondents must be humans or anyone';
  end if;
  if not internal.form_opt_bool(p_settings->'closeOnSubmit') or not internal.form_opt_bool(p_settings->'allowAmend') then
    return 'closeOnSubmit and allowAmend must be booleans';
  end if;
  if not internal.form_int_in(p_settings->'attentionPoints', 1, 100) then
    return 'attentionPoints must be an integer 1..100';
  end if;
  d := p_settings->'delivery';
  if d is not null then
    if jsonb_typeof(d) <> 'object'
       or internal.form_unknown_keys(d, array['target','onSessionNotLive']) <> '[]'::jsonb then
      return 'delivery must be {target?, onSessionNotLive?}';
    end if;
    if d ? 'target' and not ((d->>'target') = any(array['requesting_session','new_session'])
                             and jsonb_typeof(d->'target') = 'string') then
      return 'delivery.target must be requesting_session or new_session';
    end if;
    if d ? 'onSessionNotLive' and not ((d->>'onSessionNotLive') = any(array['resume','queue','spawn_new'])
                                       and jsonb_typeof(d->'onSessionNotLive') = 'string') then
      return 'delivery.onSessionNotLive must be resume, queue or spawn_new';
    end if;
  end if;
  return null;
end
$$;

create or replace function internal.form_settings_effective(p_settings jsonb)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'responses', coalesce(p_settings->>'responses', 'per_member'),
    'respondents', coalesce(p_settings->>'respondents', 'humans'),
    'closeOnSubmit', coalesce((p_settings->>'closeOnSubmit')::boolean, false),
    'allowAmend', coalesce((p_settings->>'allowAmend')::boolean, true),
    'delivery', jsonb_build_object(
      'target', coalesce(p_settings#>>'{delivery,target}', 'requesting_session'),
      'onSessionNotLive', coalesce(p_settings#>>'{delivery,onSessionNotLive}', 'resume')),
    'attentionPoints', coalesce((p_settings->>'attentionPoints')::int, 60))
$$;

-- The lineage key a NEW chain gets under a responses mode (see header table).
create or replace function internal.form_lineage_key(
  p_mode text, p_form_id uuid, p_respondent_id uuid, p_response_id uuid
) returns uuid language sql immutable set search_path = public, internal, pg_temp as $$
  select case p_mode
           when 'per_member' then p_respondent_id
           when 'single' then p_form_id
           else p_response_id
         end
$$;

-- -----------------------------------------------------------------------------
-- 6. Tables.
-- -----------------------------------------------------------------------------
create table public.forms (
  entity_id         uuid primary key references public.entities(id) on delete cascade,
  title             text not null check (char_length(title) between 1 and 300),
  description       text check (char_length(description) <= 8000),        -- markdown
  status            text not null default 'draft'
                    check (status in ('draft','open','closed','cancelled')),
  settings          jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(settings) = 'object'),            -- §3.3, sparse
  structure_version int not null default 1 check (structure_version >= 1),
  opened_at         timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Optional sections (decision 5). A table, not a jsonb list, so a question's
-- section is a real foreign key.
create table public.form_sections (
  form_id  uuid not null references public.forms(entity_id) on delete cascade,
  key      text not null check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  position int  not null check (position >= 0),
  title    text not null check (char_length(title) between 1 and 300),
  help     text check (char_length(help) <= 4000),
  primary key (form_id, key),
  constraint form_sections_position_unique unique (form_id, position) deferrable initially immediate
);

create table public.form_questions (
  form_id  uuid not null references public.forms(entity_id) on delete cascade,
  key      text not null check (key ~ '^[a-z][a-z0-9_]{0,63}$'),        -- stable, agent-chosen
  position int  not null check (position >= 0),
  section  text,
  type     text not null check (type ~ '^[a-z][a-z0-9_]{0,40}$'),       -- §4; arm must exist (trigger)
  title    text not null check (char_length(title) between 1 and 500),
  help     text check (char_length(help) <= 4000),                        -- markdown
  required boolean not null default true,
  config   jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  primary key (form_id, key),
  -- DEFERRABLE so a move can renumber inside one statement or transaction
  -- (`set constraints form_questions_position_unique deferred`).
  constraint form_questions_position_unique unique (form_id, position) deferrable initially immediate,
  constraint form_questions_section_fk foreign key (form_id, section)
    references public.form_sections(form_id, key) on update cascade on delete set null (section)
);

create table public.form_responses (
  id                 uuid primary key default internal.new_id(),
  form_id            uuid not null references public.forms(entity_id) on delete cascade,
  space_id           uuid not null references public.spaces(id) on delete cascade,
  respondent_id      uuid not null references public.entities(id),       -- member / team_member
  status             text not null default 'draft' check (status in ('draft','submitted')),
  structure_version  int not null check (structure_version >= 1),      -- filled by trigger
  answers            jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  questions_snapshot jsonb,                                              -- frozen at submit
  revision           int not null default 1 check (revision >= 1),
  supersedes_id      uuid,
  lineage_key        uuid not null,                                      -- see header; trigger-derived
  is_current         boolean not null default false,
  message_id         uuid references public.messages(entity_id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  submitted_at       timestamptz,
  version            int not null default 1 check (version >= 1),
  constraint form_responses_current_is_submitted check (not is_current or status = 'submitted'),
  constraint form_responses_submitted_at check ((status = 'submitted') = (submitted_at is not null)),
  constraint form_responses_snapshot check ((status = 'submitted') = (questions_snapshot is not null)),
  constraint form_responses_first_revision check ((revision = 1) = (supersedes_id is null)),
  -- Anchor for the chain FK: a revision supersedes a row of the SAME form and
  -- the SAME lineage, or nothing.
  constraint form_responses_lineage_anchor unique (id, form_id, lineage_key),
  constraint form_responses_supersedes_fk foreign key (supersedes_id, form_id, lineage_key)
    references public.form_responses(id, form_id, lineage_key)
);

-- THE response limit, every mode (header). 23505 -> 409 form_response_limit.
create unique index form_responses_one_current
  on public.form_responses(form_id, lineage_key) where is_current;
-- One in-flight draft per member per form. 23505 -> 409 conflict.
create unique index form_responses_one_draft_per_member
  on public.form_responses(form_id, respondent_id) where status = 'draft';
-- Fork protection: a revision is superseded at most once.
create unique index form_responses_one_successor
  on public.form_responses(supersedes_id) where supersedes_id is not null;
-- forms.responses.list (current only), keyset (submitted_at, id). Also the
-- freeze probe: a form has a submitted response iff it has a current one.
create index form_responses_current_page
  on public.form_responses(form_id, submitted_at, id) where is_current;
-- forms.responses.mine: "what have I submitted", across a space, keyset.
create index form_responses_mine_page
  on public.form_responses(space_id, respondent_id, submitted_at, id) where status = 'submitted';
-- A chain's history in order.
create index form_responses_lineage_history
  on public.form_responses(form_id, lineage_key, revision);
-- FK support for hard-deleting a respondent entity.
create index form_responses_respondent_idx on public.form_responses(respondent_id);

-- Outbox: response -> requesting session (W2 drains it). One row per
-- (revision, session): a resubmission is a new response row, so a new delivery.
create table public.form_deliveries (
  response_id        uuid not null references public.form_responses(id) on delete cascade,
  work_session_id    uuid not null references public.entities(id) on delete cascade,
  status             text not null default 'pending'
                     check (status in ('pending','delivered','spawned','cancelled')),
  attempts           int not null default 0 check (attempts >= 0),
  last_error         text,
  delivery_id        uuid,                                  -- session_message_deliveries row
  spawned_session_id uuid references public.entities(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (response_id, work_session_id),
  constraint form_deliveries_spawned check (status = 'spawned' or spawned_session_id is null)
);
-- W2 drain-on-live: the pending rows of one session, oldest first.
create index form_deliveries_pending_by_session
  on public.form_deliveries(work_session_id, created_at) where status = 'pending';
-- FK support for the work_session cascade (all statuses).
create index form_deliveries_session_idx on public.form_deliveries(work_session_id);

-- -----------------------------------------------------------------------------
-- 7. Structure: JSON projections used by the snapshot, the validator and
--    entity_content. camelCase, matching the contract's FormQuestion.
-- -----------------------------------------------------------------------------
create or replace function internal.form_questions_json(p_form_id uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'key', q.key, 'type', q.type, 'title', q.title, 'help', q.help,
             'required', q.required, 'section', q.section, 'position', q.position))
           || jsonb_build_object('config', q.config)
           order by q.position), '[]'::jsonb)
    from public.form_questions q where q.form_id = p_form_id
$$;

create or replace function internal.form_sections_json(p_form_id uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object('key', s.key, 'title', s.title, 'help', s.help,
                                                'position', s.position))
           order by s.position), '[]'::jsonb)
    from public.form_sections s where s.form_id = p_form_id
$$;

create or replace function internal.form_snapshot(p_form_id uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
           'structureVersion', f.structure_version,
           'sections', internal.form_sections_json(p_form_id),
           'questions', internal.form_questions_json(p_form_id))
    from public.forms f where f.entity_id = p_form_id
$$;

create or replace function internal.validate_form_answers(p_form_id uuid, p_answers jsonb, p_final boolean)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select internal.validate_form_answers_against(internal.form_questions_json(p_form_id), p_answers, p_final)
$$;

-- Frozen = a SUBMITTED response exists (drafts never freeze). Uses
-- form_responses_current_page: every submitted chain has a current row.
create or replace function internal.form_structure_frozen(p_form_id uuid)
returns boolean language sql stable set search_path = public, internal, pg_temp as $$
  select exists (select 1 from public.form_responses r where r.form_id = p_form_id and r.is_current)
$$;

-- -----------------------------------------------------------------------------
-- 8. Triggers: forms.
-- -----------------------------------------------------------------------------
create trigger forms_validate_kind
before insert or update of entity_id on public.forms
for each row execute function internal.validate_detail_envelope('form');

create trigger forms_touch_updated_at before update on public.forms
for each row execute function internal.touch_updated_at();

create trigger forms_w2_snapshot_version after update on public.forms
for each row execute function internal.snapshot_entity_version();

create or replace function internal.forms_guard() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare problem text := internal.form_settings_issues(new.settings);
begin
  if problem is not null then
    raise exception 'form settings: %', problem using errcode = '22023';
  end if;
  -- ONE freeze rule (decision 7): the responses mode freezes with the
  -- questions, at the first submitted response.
  if tg_op = 'UPDATE'
     and internal.form_settings_effective(old.settings)->>'responses'
         is distinct from internal.form_settings_effective(new.settings)->>'responses'
     and internal.form_structure_frozen(new.entity_id) then
    raise exception 'form structure is frozen: settings.responses cannot change after the first submitted response'
      using errcode = 'TFS01';
  end if;
  return new;
end
$$;

create trigger forms_guard before insert or update on public.forms
for each row execute function internal.forms_guard();

-- A mode change before the first submit re-keys the drafts (all revision 1).
create or replace function internal.forms_rekey_drafts() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare mode text := internal.form_settings_effective(new.settings)->>'responses';
begin
  if internal.form_settings_effective(old.settings)->>'responses' is distinct from mode then
    update public.form_responses r
       set lineage_key = internal.form_lineage_key(mode, r.form_id, r.respondent_id, r.id)
     where r.form_id = new.entity_id and r.status = 'draft';
  end if;
  return null;
end
$$;

create trigger forms_rekey_drafts after update of settings on public.forms
for each row execute function internal.forms_rekey_drafts();

alter table public.forms enable row level security;
create policy forms_select on public.forms for select to tm8_app
  using (internal.entity_readable(entity_id));
grant select on public.forms to tm8_app;

-- -----------------------------------------------------------------------------
-- 9. Triggers: questions and sections.
-- -----------------------------------------------------------------------------
-- Lock the form row (the SAME lock submit takes) and refuse once frozen. A
-- cascade from a deleted form finds no row and passes.
create or replace function internal.form_assert_structure_editable(p_form_id uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform 1 from public.forms f where f.entity_id = p_form_id for no key update;
  if found and internal.form_structure_frozen(p_form_id) then
    raise exception 'form structure is frozen: questions cannot change after the first submitted response'
      using errcode = 'TFS01';
  end if;
end
$$;

create or replace function internal.form_questions_guard() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare issues jsonb;
begin
  perform internal.form_assert_structure_editable(case when tg_op = 'DELETE' then old.form_id else new.form_id end);
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and new.form_id <> old.form_id then
    raise exception 'a question cannot move between forms' using errcode = '23514';
  end if;
  issues := internal.form_question_config_issues(new.type, new.config);
  if issues <> '[]'::jsonb then
    raise exception 'question %: %', new.key, issues->0->>'message'
      using errcode = '22023', detail = jsonb_build_object('reason', issues->0->>'code', 'key', new.key,
                                                             'issues', issues)::text;
  end if;
  return new;
end
$$;

create trigger form_questions_guard before insert or update or delete on public.form_questions
for each row execute function internal.form_questions_guard();

alter table public.form_questions enable row level security;
create policy form_questions_select on public.form_questions for select to tm8_app
  using (internal.entity_readable(form_id));
grant select on public.form_questions to tm8_app;

alter table public.form_sections enable row level security;
create policy form_sections_select on public.form_sections for select to tm8_app
  using (internal.entity_readable(form_id));
grant select on public.form_sections to tm8_app;

-- -----------------------------------------------------------------------------
-- 10. Triggers: responses (the revision model).
-- -----------------------------------------------------------------------------
create or replace function internal.form_responses_before_insert() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  f public.forms;
  form_space uuid;
  who public.entities;
  prev public.form_responses;
begin
  select * into f from public.forms where entity_id = new.form_id;
  select space_id into form_space from public.entities where id = new.form_id;
  if new.space_id is null then new.space_id := form_space; end if;
  if new.space_id <> form_space then
    raise exception 'form response space_id must match its form' using errcode = '23514';
  end if;
  select * into who from public.entities where id = new.respondent_id;
  if who.id is null or who.kind not in ('member','team_member') or who.space_id <> form_space
     or who.deleted_at is not null then
    raise exception 'a form respondent must be a live member or teammate of the form''s space'
      using errcode = '23514';
  end if;
  if new.structure_version is null then new.structure_version := f.structure_version; end if;

  if new.supersedes_id is null then
    if new.revision <> 1 then
      raise exception 'a first revision has no supersedes_id and revision 1' using errcode = '23514';
    end if;
    -- Always derived: a caller cannot pick its own slot.
    new.lineage_key := internal.form_lineage_key(
      internal.form_settings_effective(f.settings)->>'responses', new.form_id, new.respondent_id, new.id);
  else
    select * into prev from public.form_responses where id = new.supersedes_id;
    if prev.id is null or prev.form_id <> new.form_id then
      raise exception 'supersedes_id must name a response of the same form' using errcode = '23503';
    end if;
    if prev.status <> 'submitted' then
      raise exception 'only a submitted revision can be amended' using errcode = '23514';
    end if;
    if prev.respondent_id <> new.respondent_id then
      raise exception 'only the respondent of revision % may amend it', prev.revision using errcode = '23514';
    end if;
    new.lineage_key := prev.lineage_key;
    new.revision := prev.revision + 1;
  end if;
  return new;
end
$$;

create trigger form_responses_before_insert before insert on public.form_responses
for each row execute function internal.form_responses_before_insert();

-- Submitted rows are immutable: only is_current true -> false, and message_id
-- (set once the message is posted; nulled if the message is hard-deleted).
-- Drafts are mutable, and every draft save bumps `version`.
create or replace function internal.form_responses_before_update() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  f public.forms;
  fixed constant text[] := array['id','form_id','space_id','respondent_id','supersedes_id','revision','created_at'];
  k text;
begin
  foreach k in array fixed loop
    if (to_jsonb(new)->k) is distinct from (to_jsonb(old)->k) then
      raise exception 'form_responses.% is immutable', k using errcode = '23514';
    end if;
  end loop;

  if new.lineage_key is distinct from old.lineage_key then
    select * into f from public.forms where entity_id = new.form_id;
    if old.status <> 'draft' or old.revision <> 1
       or new.lineage_key is distinct from internal.form_lineage_key(
            internal.form_settings_effective(f.settings)->>'responses', new.form_id, new.respondent_id, new.id) then
      raise exception 'form_responses.lineage_key follows settings.responses and only re-keys a first-revision draft'
        using errcode = '23514';
    end if;
  end if;

  if old.status = 'submitted' then
    if (to_jsonb(new) - array['is_current','message_id','updated_at'])
       is distinct from (to_jsonb(old) - array['is_current','message_id','updated_at'])
       or (new.is_current and not old.is_current)
       or (old.message_id is not null and new.message_id is not null and new.message_id <> old.message_id) then
      raise exception 'a submitted form response is immutable (only is_current true->false and message_id may change)'
        using errcode = '23514';
    end if;
  else
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger form_responses_before_update before update on public.form_responses
for each row execute function internal.form_responses_before_update();

-- History is kept: a submitted row goes only with its form.
create or replace function internal.form_responses_before_delete() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if old.status = 'submitted' and exists (select 1 from public.forms where entity_id = old.form_id) then
    raise exception 'a submitted form response cannot be deleted' using errcode = '23514';
  end if;
  return old;
end
$$;

create trigger form_responses_before_delete before delete on public.form_responses
for each row execute function internal.form_responses_before_delete();

-- Space-visible (decision 10): a member who can read the form reads its
-- responses.
alter table public.form_responses enable row level security;
create policy form_responses_select on public.form_responses for select to tm8_app
  using (internal.entity_readable(form_id));
grant select on public.form_responses to tm8_app;

create trigger form_deliveries_touch_updated_at before update on public.form_deliveries
for each row execute function internal.touch_updated_at();

alter table public.form_deliveries enable row level security;
create policy form_deliveries_select on public.form_deliveries for select to tm8_app
  using (exists (select 1 from public.form_responses r
                  where r.id = response_id and internal.entity_readable(r.form_id)));
grant select on public.form_deliveries to tm8_app;

-- -----------------------------------------------------------------------------
-- 11. The cores W1 wraps. They trust their caller for identity (W1's doors
--     resolve and authorise the actor) and own everything else: status,
--     respondent policy, validation, the revision chain, the limit, and the
--     mapping of every unique violation to its taxonomy code.
-- -----------------------------------------------------------------------------
create or replace function internal.form_assert_respondent(p_form public.forms, p_respondent_id uuid)
returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
declare who public.entities;
begin
  select * into who from public.entities where id = p_respondent_id;
  if who.id is null or who.deleted_at is not null
     or who.space_id <> (select space_id from public.entities where id = p_form.entity_id)
     or who.kind not in ('member','team_member')
     or (who.kind = 'team_member'
         and internal.form_settings_effective(p_form.settings)->>'respondents' <> 'anyone') then
    raise exception 'this form does not accept responses from %', coalesce(who.kind, 'this actor')
      using errcode = 'TFR01';
  end if;
end
$$;

create or replace function internal.form_assert_answers(p_form_id uuid, p_answers jsonb, p_final boolean)
returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
declare issues jsonb := internal.validate_form_answers(p_form_id, p_answers, p_final);
begin
  if issues <> '[]'::jsonb then
    raise exception 'form answers are invalid (% issue(s))', jsonb_array_length(issues)
      using errcode = 'TFA01',
            detail = jsonb_build_object('reason', 'form_answers_invalid', 'issues', issues)::text;
  end if;
end
$$;

-- The revision a caller is amending, or null for a new chain.
--   explicit p_amend_of: must be the caller's current revision on this form;
--   per_member / single: the caller's current revision in their slot;
--   unlimited without p_amend_of: a new chain.
-- Under 'single', a current row owned by someone else is the limit.
create or replace function internal.form_amend_target(
  p_form public.forms, p_respondent_id uuid, p_amend_of uuid
) returns public.form_responses language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  mode text := internal.form_settings_effective(p_form.settings)->>'responses';
  target public.form_responses;
begin
  if p_amend_of is not null then
    select * into target from public.form_responses where id = p_amend_of and form_id = p_form.entity_id;
    if target.id is null then
      raise exception 'form response % not found on this form', p_amend_of using errcode = 'P0002';
    end if;
    if target.respondent_id <> p_respondent_id then
      raise exception 'only the respondent of a response may amend it' using errcode = 'TFR01';
    end if;
    if not target.is_current then
      raise exception 'revision % is no longer current', target.revision using errcode = '40001',
        detail = jsonb_build_object('reason', 'form_revision_superseded', 'responseId', target.id)::text;
    end if;
    return target;
  end if;
  if mode = 'unlimited' then return null; end if;
  select * into target from public.form_responses
   where form_id = p_form.entity_id and is_current
     and lineage_key = internal.form_lineage_key(mode, p_form.entity_id, p_respondent_id, null);
  if target.id is not null and target.respondent_id <> p_respondent_id then
    raise exception 'this form already has its response' using errcode = 'TFL01';
  end if;
  return target;
end
$$;

-- Map a unique violation raised by a form_responses write.
create or replace function internal.form_raise_unique(p_constraint text, p_message text)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  case p_constraint
    when 'form_responses_one_current' then
      raise exception 'the response limit for this form is reached' using errcode = 'TFL01';
    when 'form_responses_one_successor' then
      raise exception 'that revision was amended concurrently' using errcode = '40001',
        detail = jsonb_build_object('reason', 'form_revision_superseded')::text;
    when 'form_responses_one_draft_per_member' then
      raise exception 'a draft response is already in flight for this member' using errcode = 'TFD01';
    else
      raise exception '%', p_message using errcode = '23505';
  end case;
end
$$;

-- Autosave (forms.responses.save). Partial validation. Never overwrites a
-- draft that targets a different revision/chain (409 TFD01 names it).
create or replace function internal.form_save_draft(
  p_form_id uuid, p_respondent_id uuid, p_answers jsonb, p_amend_of uuid default null
) returns public.form_responses language plpgsql set search_path = public, internal, pg_temp as $$
declare
  f public.forms;
  d public.form_responses;
  target public.form_responses;
  c text; m text;
begin
  select * into f from public.forms where entity_id = p_form_id;
  if f.entity_id is null then
    raise exception 'form % not found', p_form_id using errcode = 'P0002';
  end if;
  if f.status <> 'open' then
    raise exception 'form is %, not open', f.status using errcode = 'TFN01';
  end if;
  perform internal.form_assert_respondent(f, p_respondent_id);
  perform internal.form_assert_answers(p_form_id, p_answers, false);

  select * into d from public.form_responses
   where form_id = p_form_id and respondent_id = p_respondent_id and status = 'draft'
   for update;
  -- Always resolve: under 'unlimited' with no p_amend_of the target is null
  -- (a new chain), so an in-flight AMEND draft is a mismatch, as ruled.
  target := internal.form_amend_target(f, p_respondent_id, p_amend_of);
  if d.id is not null then
    if d.supersedes_id is distinct from target.id then
      raise exception 'draft % is already in flight for another target; submit or discard it first', d.id
        using errcode = 'TFD01',
              detail = jsonb_build_object('reason', 'form_draft_in_flight', 'draftId', d.id,
                                          'supersedesId', d.supersedes_id)::text;
    end if;
    update public.form_responses
       set answers = p_answers, structure_version = f.structure_version
     where id = d.id returning * into d;
    return d;
  end if;
  if target.id is not null and not (internal.form_settings_effective(f.settings)->>'allowAmend')::boolean then
    raise exception 'this form does not allow amending a submitted response' using errcode = 'TFL01';
  end if;
  begin
    insert into public.form_responses(form_id, respondent_id, status, answers, supersedes_id, revision)
    values (p_form_id, p_respondent_id, 'draft', p_answers, target.id, coalesce(target.revision + 1, 1))
    returning * into d;
  exception when unique_violation then
    get stacked diagnostics c = constraint_name, m = message_text;
    perform internal.form_raise_unique(c, m);
  end;
  return d;
end
$$;

-- Submit (forms.responses.submit), §7.1 steps 1-2 and the revision flip.
-- Uses the caller's draft when there is one; p_answers, when given, replaces
-- the draft's answers. Returns the submitted row.
create or replace function internal.form_submit(
  p_form_id uuid, p_respondent_id uuid, p_answers jsonb default null, p_amend_of uuid default null
) returns public.form_responses language plpgsql set search_path = public, internal, pg_temp as $$
declare
  f public.forms;
  d public.form_responses;
  target public.form_responses;
  v_answers jsonb;
  flipped uuid;
  result public.form_responses;
  c text; m text;
begin
  -- THE submit lock (header): the form row, FOR NO KEY UPDATE.
  select * into f from public.forms where entity_id = p_form_id for no key update;
  if f.entity_id is null then
    raise exception 'form % not found', p_form_id using errcode = 'P0002';
  end if;
  if f.status <> 'open' then
    raise exception 'form is %, not open', f.status using errcode = 'TFN01';
  end if;
  perform internal.form_assert_respondent(f, p_respondent_id);

  select * into d from public.form_responses
   where form_id = p_form_id and respondent_id = p_respondent_id and status = 'draft'
   for update;
  if d.id is not null then
    if p_amend_of is not null and d.supersedes_id is distinct from p_amend_of then
      raise exception 'draft % is in flight for a different revision', d.id using errcode = 'TFD01',
        detail = jsonb_build_object('reason', 'form_draft_in_flight', 'draftId', d.id,
                                    'supersedesId', d.supersedes_id)::text;
    end if;
    if d.supersedes_id is not null then
      select * into target from public.form_responses where id = d.supersedes_id;
    end if;
  else
    target := internal.form_amend_target(f, p_respondent_id, p_amend_of);
  end if;

  v_answers := coalesce(p_answers, d.answers, '{}'::jsonb);
  perform internal.form_assert_answers(p_form_id, v_answers, true);

  if target.id is not null then
    if not (internal.form_settings_effective(f.settings)->>'allowAmend')::boolean then
      raise exception 'this form does not allow amending a submitted response' using errcode = 'TFL01';
    end if;
    -- Flip FIRST, or form_responses_one_current fires on the promotion.
    update public.form_responses set is_current = false
     where id = target.id and is_current
    returning id into flipped;
    if flipped is null then
      raise exception 'revision % is no longer current', target.revision using errcode = '40001',
        detail = jsonb_build_object('reason', 'form_revision_superseded', 'responseId', target.id)::text;
    end if;
  end if;

  begin
    if d.id is not null then
      update public.form_responses
         set status = 'submitted', is_current = true, submitted_at = now(), answers = v_answers,
             questions_snapshot = internal.form_snapshot(p_form_id), structure_version = f.structure_version
       where id = d.id returning * into result;
    else
      insert into public.form_responses(form_id, respondent_id, status, is_current, answers,
                                        questions_snapshot, submitted_at, supersedes_id, revision)
      values (p_form_id, p_respondent_id, 'submitted', true, v_answers,
              internal.form_snapshot(p_form_id), now(), target.id, coalesce(target.revision + 1, 1))
      returning * into result;
    end if;
  exception when unique_violation then
    get stacked diagnostics c = constraint_name, m = message_text;
    perform internal.form_raise_unique(c, m);
  end;
  return result;
end
$$;

-- -----------------------------------------------------------------------------
-- 12. Content hydration. See the SHARED-OBJECT NOTICE. Body copied from 194
--     verbatim; the `form` arm is the only addition. A form's content carries
--     its sections and questions, in order, so one read renders it.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

reset role;
