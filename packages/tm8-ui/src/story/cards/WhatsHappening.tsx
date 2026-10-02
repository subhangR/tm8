/**
 * WHAT'S HAPPENING — the story's activity, newest first, in plain words:
 * "<who> <did> <what>", read straight off each row's verb, entity title and
 * actor. The live sessions head the list ("Forge · Cedar is running …"), then
 * the activity groups by day. Pressing a row opens its entity's details beside
 * the story (`onPick`, or `actions.open` without a side panel; with neither it
 * is inert text); its "…" or a right-click opens the action popover
 * (`onMenu`); rows on the selected entity are highlighted.
 */
import { useState, type ReactNode } from 'react';

import { KindIcon } from '../../domain';
import { shortDate } from '../../kit';
import { nameOf, nodesById, rootNumber, SESSION_KIND, since, type StoryActivityItem, type StoryView } from '../model';
import type { StoryBlockProps } from '../props';
import { CardHead, Empty, flashOf, MenuDot, PressTitle, pressOf, rowPress, type Press } from './shared';

/**
 * The stored verb → the words a person would say. `activity.verb` is a CLOSED
 * set (activity_verb_check, last widened by migration 123); every member is
 * here. Anything else falls back to `humanVerb`, never the dotted key.
 */
const VERB_WORDS: Readonly<Record<string, string>> = {
  created: 'made',
  updated: 'updated',
  moved: 'moved',
  deleted: 'removed',
  restored: 'restored',
  linked: 'linked',
  unlinked: 'unlinked',
  reacted: 'reacted to',
  awarded: 'awarded',
  completed: 'completed',
  joined: 'joined',
  pulled: 'pulled',
  'work.changed': 'moved',
  'pr.linked': 'linked a pull request to',
  unblocked: 'unblocked',
  'chat.tool_called': 'ran a tool on',
};

function humanVerb(verb: string): string {
  return VERB_WORDS[verb] ?? verb.replace(/[._]+/g, ' ').trim();
}

/** How many activity rows show before "Show N more". */
const FIRST_PAGE = 12;

function dayLabelOf(at: string, now: Date): string {
  const d = new Date(at);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return shortDate(d, now.getTime());
}

/** "root 3", "story", or nothing for a row outside every root. */
function whereOf(view: StoryView, entityId: string): string | null {
  if (entityId === view.id) return 'story';
  const n = nodesById(view).get(entityId);
  const root = n?.rootIds[0];
  if (!root) return null;
  const k = rootNumber(view, root);
  return k > 0 ? `root ${k}` : null;
}

export function WhatsHappening(props: StoryBlockProps) {
  const { view, live } = props;
  const press = pressOf(props);
  const [showAll, setShowAll] = useState(false);
  const byId = nodesById(view);
  const running = view.page.sessions.filter((s) => s.live);
  const activity = showAll ? view.page.activity : view.page.activity.slice(0, FIRST_PAGE);
  const hidden = view.page.activity.length - activity.length;
  const now = new Date();

  const obj = (id: string, title: string) => (
    <span className={`stc-hit${press.sel(id)}`} data-entity={id}>
      <PressTitle id={id} title={title} press={press} className="stc-obj" />
    </span>
  );

  if (!running.length && !view.page.activity.length) {
    return (
      <section className="stc-card">
        <CardHead title="What’s happening" />
        <Empty>Nothing has happened here yet. Put something in, or spawn on the story, and it shows up here as it happens.</Empty>
      </section>
    );
  }

  let lastDay = '';
  return (
    <section className="stc-card">
      <CardHead title="What’s happening" count="newest first · across everything in the story" />
      <div className="stc-tl">
        {running.length ? <div className="stc-tl__sec stc-tl__sec--live">● live</div> : null}
        {running.map((s) => {
          const who = nameOf(view, s.teamMemberId);
          const tasks = s.taskIds.filter((id) => byId.has(id));
          const where = s.rootIds.length ? s.rootIds.map((r) => `root ${rootNumber(view, r)}`).join(' · ') : 'story';
          return (
            <div
              key={s.id}
              className={`stc-tl__item${press.sel(s.id)}${flashOf(live?.landed, s.id)}`}
              data-entity={s.id}
              onClick={rowPress(press, s.id)}
              onContextMenu={press.menu?.(s.id)}
            >
              <span className="stc-tl__o stc-tl__o--live">
                <KindIcon kind={SESSION_KIND} size={14} />
              </span>
              <div>
                <div className="stc-tl__what">
                  <PressTitle id={s.id} title={<b>{`${who} · ${s.callSign}`}</b>} press={press} className="stc-link" />{' '}
                  {tasks.length ? (
                    <>
                      is running{' '}
                      {tasks.map((id, i) => (
                        <span key={id}>
                          {i ? (i === tasks.length - 1 ? ' and ' : ', ') : ''}
                          {obj(id, byId.get(id)!.title)}
                        </span>
                      ))}
                    </>
                  ) : (
                    <>is live on the story</>
                  )}
                </div>
                <div className="stc-tl__via">
                  <em>{where}</em> · <span className="stc-fam-text--runs">runs</span>
                </div>
              </div>
              <span className="stc-tl__end">
                <MenuDot id={s.id} label={`${who} · ${s.callSign}`} press={press} />
                <span className="stc-tl__when">{since(s.createdAt)}</span>
              </span>
            </div>
          );
        })}
        {activity.map((a) => {
          const day = dayLabelOf(a.at, now);
          const sec = day !== lastDay ? <div className="stc-tl__sec">{day}</div> : null;
          lastDay = day;
          return (
            <div key={a.id}>
              {sec}
              <ActivityRow a={a} view={view} obj={obj} press={press} flash={flashOf(live?.landed, a.entityId)} />
            </div>
          );
        })}
        {hidden > 0 ? (
          <button type="button" className="stc-more" onClick={() => setShowAll(true)}>
            Show {hidden} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ActivityRow({
  a,
  view,
  obj,
  press,
  flash,
}: {
  a: StoryActivityItem;
  view: StoryView;
  obj: (id: string, title: string) => ReactNode;
  press: Press;
  flash: string;
}) {
  const where = whereOf(view, a.entityId);
  return (
    <div
      className={`stc-tl__item${press.sel(a.entityId)}${flash}`}
      data-entity={a.entityId}
      onClick={rowPress(press, a.entityId)}
      onContextMenu={press.menu?.(a.entityId)}
    >
      <span className="stc-tl__o">
        <KindIcon kind={a.entityKind} size={14} />
      </span>
      <div>
        <div className="stc-tl__what">
          <b>{nameOf(view, a.actorId, a.actor)}</b> {humanVerb(a.verb)}{' '}
          {a.entityId === view.id ? 'the story' : obj(a.entityId, a.entityTitle)}
        </div>
        {where ? (
          <div className="stc-tl__via">
            <em>{where}</em>
          </div>
        ) : null}
      </div>
      <span className="stc-tl__end">
        <MenuDot id={a.entityId} label={a.entityId === view.id ? 'the story' : a.entityTitle} press={press} />
        <span className="stc-tl__when">{since(a.at)}</span>
      </span>
    </div>
  );
}
