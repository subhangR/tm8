/**
 * Live-chat counts for `execution.liveness` (the status strip).
 *
 * A chat is LIVE when its durable `runtime_state` says the headless child is
 * up; it is WORKING when it is live AND a turn on it is `running` or
 * `queued`. `working` is a subset of `live` by construction: a queued turn on
 * a STOPPED chat is the node-restart case ("your message is still coming"),
 * not a chat that is doing anything right now.
 *
 * Exported as SQL so the pg suite runs the exact statement the handler runs.
 * `$1` is the space id; run it under the caller's claims (RLS scopes it).
 */
export const LIVE_CHAT_COUNTS_SQL = `select count(*) as live,
       count(*) filter (where exists (
         select 1 from public.chat_turns t
          where t.chat_id = c.entity_id and t.state in ('running', 'queued')
       )) as working
  from public.chats c
  join public.entities e on e.id = c.entity_id
 where c.space_id = $1 and e.deleted_at is null and c.runtime_state = 'live'`;

export interface LiveChatCountRow {
  live: number | string;
  working: number | string;
}
