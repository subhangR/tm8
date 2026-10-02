/**
 * LIVE FEED — every message on every anchor in the story, oldest at the top and
 * the newest landing at the bottom (the view's `feed` is newest first; this
 * block only reverses it for reading). Each row names the anchor it was said
 * on; the scope switch narrows to messages on the story itself.
 *
 * Pause rides `live.setPaused` and only draws with a live feed. The composer
 * rides `actions.sendMessage` on the anchor picked beside it ("reply" on a row
 * picks that row's anchor); without `sendMessage` there is no composer.
 *
 * Pressing a row (or its anchor chip) opens the ANCHOR's details beside the
 * story (`onPick`); its "…" or a right-click opens the anchor's action popover
 * (`onMenu`); rows on the selected anchor are highlighted.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { KindIcon } from '../../domain';
import { nodesById, since, STORY_KIND, type StoryFeedRow, type StoryView } from '../model';
import type { StoryBlockProps } from '../props';
import { CardHead, Empty, flashOf, MenuDot, PersonAvatar, PressTitle, pressOf, rowPress, type Press } from './shared';

type Scope = 'all' | 'story';

interface Anchor {
  id: string;
  kind: string;
  title: string;
}

/** Every anchor the composer can post on: the story first, then everything in it. */
function anchorsOf(view: StoryView): Anchor[] {
  const byId = nodesById(view);
  const out: Anchor[] = [{ id: view.id, kind: STORY_KIND, title: 'The story' }];
  for (const id of view.page.feedAnchorIds) {
    if (id === view.id) continue;
    const n = byId.get(id);
    if (!n) continue;
    out.push({ id, kind: n.kind, title: n.callSign ? `${n.callSign} · ${n.title}` : n.title });
  }
  return out;
}

export function LiveFeed(props: StoryBlockProps) {
  const { view, actions, live } = props;
  const press = pressOf(props);
  const [scope, setScope] = useState<Scope>('all');
  const rows = useMemo(
    () => [...view.feed].reverse().filter((m) => scope === 'all' || m.anchorId === view.id),
    [view.feed, view.id, scope],
  );
  const anchors = useMemo(() => anchorsOf(view), [view]);
  const [on, setOn] = useState(view.id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const send = actions.sendMessage;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const replyOn = (anchorId: string) => {
    setOn(anchorId);
    inputRef.current?.focus();
  };
  const submit = () => {
    const body = text.trim();
    if (!send || !body || busy) return;
    setBusy(true);
    setError(null);
    send(on, body).then(
      () => {
        setBusy(false);
        setText('');
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  const picked = anchors.find((a) => a.id === on) ?? anchors[0]!;

  return (
    <section className="stc-card">
      <CardHead title="Live feed" count="every message on every anchor in the story · as they happen">
        <span className="stc-seg" role="tablist">
          {(
            [
              ['all', 'All anchors'],
              ['story', 'Story only'],
            ] as const
          ).map(([s, label]) => (
            <button key={s} type="button" role="tab" aria-selected={scope === s} className={scope === s ? 'stc-seg__on' : undefined} onClick={() => setScope(s)}>
              {label}
            </button>
          ))}
        </span>
        {live ? (
          <button type="button" className="stc-btn stc-btn--ghost stc-btn--sm" onClick={() => live.setPaused(!live.paused)}>
            {live.paused ? `▶ Resume${live.queued ? ` · ${live.queued} waiting` : ''}` : '⏸ Pause'}
          </button>
        ) : null}
      </CardHead>
      <div className="stc-feed" ref={listRef}>
        {rows.length === 0 ? (
          <Empty>{scope === 'story' && view.feed.length ? 'Nothing said on the story itself yet — switch to all anchors.' : 'No messages yet. Anything said on the story, or on anything in it, lands here as it happens.'}</Empty>
        ) : (
          rows.map((m) => <FeedRow key={m.id} m={m} view={view} press={press} onReply={send ? replyOn : undefined} flash={flashOf(live?.landed, m.id)} />)
        )}
      </div>
      {send ? (
        <div className="stc-feedfoot">
          <label className="stc-anchorpick" title="the anchor your message lands on">
            <KindIcon kind={picked.kind} size={13} />
            <span>on:</span>
            <select value={picked.id} onChange={(e) => setOn(e.target.value)}>
              {anchors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </label>
          <span className="stc-composer">
            <input
              ref={inputRef}
              value={text}
              disabled={busy}
              placeholder="Say something here… it lands on the anchor you picked"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
            <kbd>↵</kbd>
          </span>
          {error ? <span className="stc-entry__error">{error}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function FeedRow({
  m,
  view,
  press,
  onReply,
  flash,
}: {
  m: StoryFeedRow;
  view: StoryView;
  press: Press;
  onReply?: (anchorId: string) => void;
  flash: string;
}) {
  const person = m.authorId ? view.people[m.authorId] ?? null : null;
  const name = person?.name ?? m.author?.displayName ?? 'someone';
  const sign = m.authorId ? view.page.sessions.find((s) => s.live && s.teamMemberId === m.authorId)?.callSign : undefined;
  const onStory = m.anchorId === view.id;
  const anchorBody = (
    <>
      <KindIcon kind={onStory ? STORY_KIND : m.anchorKind} size={12} />
      on {onStory ? 'the story' : m.anchorTitle}
    </>
  );
  const anchorCls = onStory ? 'stc-fm__anchor stc-fm__anchor--story' : 'stc-fm__anchor';
  return (
    <div
      className={`stc-fm${m.incoming ? ' stc-fm--in' : ''}${press.sel(m.anchorId)}${flash}`}
      onClick={rowPress(press, m.anchorId)}
      onContextMenu={press.menu?.(m.anchorId)}
    >
      <PersonAvatar id={m.authorId} person={person} fallbackName={name} agent={m.author?.isAgent} size={22} live={!!sign} />
      <div>
        <div className="stc-fm__h">
          <b>{name}</b>
          {sign ? <span className="stc-fm__sign">{sign}</span> : null}
          <span className="stc-hit" data-entity={m.anchorId}>
            <PressTitle id={m.anchorId} title={anchorBody} press={press} className={anchorCls} />
            <MenuDot id={m.anchorId} label={onStory ? 'the story' : m.anchorTitle} press={press} />
          </span>
          <span className="stc-fm__when">{since(m.at)}</span>
        </div>
        <div className="stc-fm__b">{m.excerpt}</div>
        {onReply ? (
          <div className="stc-fm__acts">
            <button type="button" onClick={() => onReply(m.anchorId)}>
              reply
            </button>
            {onStory ? null : (
              <button type="button" onClick={() => onReply(view.id)}>
                reply on the story
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
