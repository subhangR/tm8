-- =============================================================================
-- 076 — a blocked agent becomes an answerable question.
--
-- THE OBSERVED GAP. A tm8 session has two surfaces onto one run: the terminal
-- and chat. When an agent asks for permission, that question exists ONLY as
-- pixels in the terminal's byte stream. `packages/pty-protocol` carries exit,
-- size and attached and nothing else; `DurableWorkspaceEvent` has no permission
-- or question variant; the browser composer binds `messages.post` and
-- attachments and no approve/deny operation. So a non-developer living in chat
-- can be silently blocked on a question they cannot see and could not answer if
-- they could. Phase 1 shipped the honest half of this -- a session that has gone
-- quiet is reported as possibly waiting -- but it explicitly refuses to guess
-- WHAT it is waiting on, because a detector that guesses is indistinguishable,
-- at the point of use, from one that knows.
--
-- This table is the missing object: the question itself, durable, addressable,
-- and answerable from anywhere with authority over the session.
--
-- WHY A TABLE AND NOT A MESSAGE. A prompt is not a message: it has a lifecycle
-- (pending -> allowed|denied|expired), exactly one binding answer, and an agent
-- blocked on the other end of it. Modelling it as a message would make "answer"
-- an ordinary post and lose the one invariant that matters -- that a decision is
-- recorded once, by someone, and can never be silently re-run.
--
-- THE SAFETY RULE THIS SCHEMA ENCODES. There is no default. A prompt that is
-- never answered EXPIRES; it never becomes an allow. Every failure in this
-- system -- an unreachable server, a closed browser, an expired window, a torn
-- connection -- must fall toward the terminal, where the agent's own prompt is
-- still sitting and a human can answer it directly. A wrong grant is
-- unrecoverable; a wrong fallback costs a walk to the terminal. `status` has no
-- 'allowed' default and `decided_by` is mandatory for any decided row precisely
-- so that no code path can grant permission without naming who granted it.
-- =============================================================================

create table if not exists public.session_prompts (
  id                 uuid primary key default gen_random_uuid(),
  work_session_id    uuid not null
                       references public.work_sessions(entity_id) on delete cascade,

  -- The agent's OWN identity for this request. `tool_use_id` comes straight
  -- from the provider hook payload and is what makes the loop idempotent: a
  -- hook that fires twice for one tool call (a retry, a reconnect) must resolve
  -- to ONE question and ONE decision, never two prompts racing to answer the
  -- same block.
  tool_use_id        text not null,

  -- What is being asked, in the agent's own words, for rendering in chat.
  -- `tool_input` is provider-shaped JSON and is deliberately NOT parsed here:
  -- the renderer shows what the agent actually said it wanted to do, and a
  -- schema imposed at this layer would silently drop fields for any provider
  -- whose payload we guessed wrong.
  tool_name          text not null,
  tool_input         jsonb not null default '{}'::jsonb,

  -- Which agent asked. A tm8 session may be a COORDINATOR -- a claude-code
  -- session that spawned a codex agent -- in which case the question comes from
  -- a process below the session's own PTY. Attributing it to the session alone
  -- would show the user a question from the wrong agent, and a user who answers
  -- a question they were never asked is worse off than one who sees none.
  agent_tool         text,
  agent_pid          integer,

  status             text not null default 'pending'
                       check (status in ('pending','allowed','denied','expired')),

  -- WHO decided, never nullable once decided (see the trigger below). An
  -- allow with no author is an unattributable grant.
  decided_by         uuid references public.entities(id) on delete set null,
  decided_at         timestamptz,
  -- Free text surfaced back to the agent, so a denial can say why.
  decision_reason    text,

  created_at         timestamptz not null default now(),
  -- 10 minutes: longer than a coffee break, shorter than a forgotten tab. The
  -- window is stored per row rather than assumed by readers so that changing
  -- the policy never retroactively expires or revives a question already asked.
  expires_at         timestamptz not null default now() + interval '10 minutes'
);

-- One live question per tool call. Partial, so a session may ask about the same
-- tool_use_id again only once the previous one is decided -- which is what makes
-- a hook retry after a decision safe rather than a duplicate.
create unique index if not exists session_prompts_live_tool_use_idx
  on public.session_prompts(work_session_id, tool_use_id)
  where status = 'pending';

-- The chat surface's read: this session's questions, newest first.
create index if not exists session_prompts_session_idx
  on public.session_prompts(work_session_id, created_at desc);

-- The expiry sweep's read.
create index if not exists session_prompts_pending_expiry_idx
  on public.session_prompts(expires_at)
  where status = 'pending';

alter table public.session_prompts enable row level security;

comment on table public.session_prompts is
  'A question a blocked agent is waiting on, answerable from chat. No default decision: an unanswered prompt expires, it never becomes an allow.';

-- A decided row must name its decider and its moment. Enforced in the database
-- rather than in the handler because "who allowed this?" is an audit question,
-- and an audit trail that depends on every future call site remembering to fill
-- two columns is not one.
create or replace function public.session_prompts_decision_guard()
returns trigger language plpgsql as $$
begin
  if new.status in ('allowed','denied') then
    if new.decided_at is null then new.decided_at := now(); end if;
    if new.decided_by is null then
      raise exception 'session_prompts: % requires decided_by', new.status
        using errcode = 'check_violation';
    end if;
  end if;
  -- Expiry is a decision made by nobody, and that is exactly why it is not an
  -- allow. It is allowed to have no decider, and it must have no decider.
  if new.status = 'expired' and new.decided_by is not null then
    raise exception 'session_prompts: expired prompts have no decider'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists session_prompts_decision_guard on public.session_prompts;
create trigger session_prompts_decision_guard
  before insert or update on public.session_prompts
  for each row execute function public.session_prompts_decision_guard();

-- =============================================================================
-- The guarded transition. Answering is the one write that matters, so it goes
-- through a single function for the same reason session status does: one place
-- that can refuse, rather than N call sites that each remember to.
--
-- Refuses to re-decide an already-decided prompt. That is not a courtesy --
-- it is what stops a late click, a duplicated request or a replayed event from
-- overturning a denial that the agent has already acted on.
-- =============================================================================
create or replace function public.session_prompt_answer(
  p_prompt_id  uuid,
  p_status     text,
  p_decided_by uuid,
  p_reason     text default null
) returns public.session_prompts
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.session_prompts;
begin
  if p_status not in ('allowed','denied') then
    raise exception 'session_prompt_answer: status must be allowed or denied, got %', p_status
      using errcode = 'invalid_parameter_value';
  end if;

  update public.session_prompts
     set status = p_status,
         decided_by = p_decided_by,
         decided_at = now(),
         decision_reason = p_reason
   where id = p_prompt_id
     and status = 'pending'
   returning * into v_row;

  if not found then
    -- Distinguish "no such prompt" from "already decided": the caller renders
    -- very different things, and a UI that says "not found" for a question the
    -- user can plainly see is worse than one that says "already answered".
    if exists (select 1 from public.session_prompts where id = p_prompt_id) then
      raise exception 'session_prompt_answer: prompt % is already decided', p_prompt_id
        using errcode = 'unique_violation';
    end if;
    raise exception 'session_prompt_answer: no prompt %', p_prompt_id
      using errcode = 'no_data_found';
  end if;

  return v_row;
end $$;

-- Sweep: pending prompts past their window become 'expired'. Idempotent, so it
-- is safe to call from any read path rather than needing a scheduler -- a
-- question whose window has closed must never be answerable, and the cheapest
-- way to guarantee that is to close it on the way past.
create or replace function public.session_prompts_expire_due()
returns integer language sql security definer set search_path = public, pg_temp as $$
  with expired as (
    update public.session_prompts
       set status = 'expired'
     where status = 'pending' and expires_at <= now()
     returning 1
  ) select count(*)::integer from expired;
$$;

-- =============================================================================
-- Reaching the browser live.
--
-- Chat cannot poll for this. A person watching the chat surface must see the
-- question appear while the agent is still blocked on it -- a prompt that shows
-- up after a poll interval is a prompt the agent waited out for no reason.
--
-- A DEDICATED capture function rather than a branch inside
-- `internal.capture_workspace_event`: that function is shared by entities,
-- edges, messages, counters, activity and notifications, and several later
-- migrations have already replaced it wholesale. Adding a branch there means
-- every future replacement must remember to carry this one, and the failure
-- mode of forgetting is silent -- prompts simply stop reaching chat. A separate
-- trigger cannot be dropped by accident.
-- =============================================================================
create or replace function internal.capture_session_prompt_event() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  v_space uuid;
  v_event text;
begin
  -- The space comes from the session's own entity row; a prompt is never
  -- addressable outside the space that owns the session that raised it.
  select space_id into v_space from public.entities where id = new.work_session_id;
  if v_space is null then return new; end if;

  if tg_op = 'INSERT' then
    v_event := 'session.prompt.opened';
  elsif new.status is distinct from old.status then
    v_event := case new.status
      when 'expired' then 'session.prompt.expired'
      else 'session.prompt.answered'
    end;
  else
    -- Nothing a client can act on changed. A prompt row is touched for
    -- bookkeeping more often than it is decided, and re-emitting on every touch
    -- would put noise on a socket whose whole value is that it carries only
    -- things a person must respond to.
    return new;
  end if;

  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (v_space, internal.next_event_seq(v_space), v_event, to_jsonb(new), internal.claim_cmid());
  return new;
end $$;

drop trigger if exists session_prompts_capture_event on public.session_prompts;
create trigger session_prompts_capture_event
  after insert or update on public.session_prompts
  for each row execute function internal.capture_session_prompt_event();
