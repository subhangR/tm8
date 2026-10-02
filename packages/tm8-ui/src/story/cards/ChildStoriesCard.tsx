/**
 * CHILD STORIES — a story is an entity, so it has children of its own kind.
 * Each tile is a whole story: status, how much is in it, what is live, and its
 * own task progress, which the server rolls up into this story's `rollup`.
 *
 * A tile opens the child through `actions.open`; "＋ Child story" rides
 * `actions.add` with the `child-story` intent. Absent members, no affordance.
 */
import { useState } from 'react';

import { KindIcon } from '../../domain';
import { Pill } from '../../kit';
import { childStoryProgress, pct, since, STORY_KIND, toneOf, type StoryChild } from '../model';
import type { StoryBlockProps, StoryNodePick } from '../props';
import { CardHead, Empty, flashOf, InlineEntry, Meter, TonePill } from './shared';

export function ChildStoriesCard({ view, actions, live }: StoryBlockProps & { onPick?: (pick: StoryNodePick) => void }) {
  const kids = view.page.childStories;
  const [adding, setAdding] = useState(false);
  const add = actions.add;
  return (
    <section className="stc-card">
      <CardHead title="Child stories" count={kids.length ? `${kids.length} · stories of their own under this one` : undefined}>
        <span className="stc-count">a story is an entity · it has children of its own kind · each rolls up here</span>
        {add ? (
          <button type="button" className="stc-btn stc-btn--sm" onClick={() => setAdding(true)}>
            ＋ Child story
          </button>
        ) : null}
      </CardHead>
      {adding && add ? (
        <div className="stc-team__adding">
          <InlineEntry
            placeholder="The child story’s title"
            submitLabel="Create"
            onSubmit={(text) => add({ intent: 'child-story', text, onId: view.id, tellIds: [] })}
            onClose={() => setAdding(false)}
          />
        </div>
      ) : null}
      {kids.length === 0 ? (
        <Empty>No child stories. A story under this one gets its own roots, team and graph, and its progress rolls up here.</Empty>
      ) : (
        <div className="stc-kids">
          {kids.map((c) => (
            <Kid key={c.id} c={c} open={actions.open} flash={flashOf(live?.landed, c.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function Kid({ c, open, flash }: { c: StoryChild; open?: (id: string) => void; flash: string }) {
  const p = childStoryProgress(c);
  const inner = (
    <>
      <span className="stc-kid__bar" style={{ ['--p' as string]: `${pct(p)}%` }} aria-hidden />
      <span className="stc-kid__glyph">
        <KindIcon kind={STORY_KIND} size={18} />
      </span>
      <span className="stc-kid__main">
        <span className="stc-kid__t">{c.title}</span>
        <span className="stc-kid__meta">
          <TonePill tone={toneOf(c)} label={c.status ?? undefined} />
          <span>
            {c.itemCount} {c.itemCount === 1 ? 'thing' : 'things'}
          </span>
          {c.liveSessionCount ? (
            <Pill tone="run" dot="pulse">
              {c.liveSessionCount} live
            </Pill>
          ) : (
            <span>nothing live</span>
          )}
          <span>last activity {since(c.lastActivityAt)}</span>
        </span>
        <Meter progress={p} />
        <span className="stc-kid__pct">
          <span>
            {p.done} of {p.work} tasks done
          </span>
          <span>rolls up here</span>
        </span>
      </span>
    </>
  );
  return open ? (
    <button type="button" className={`stc-kid${flash}`} title="open this story" onClick={() => open(c.id)}>
      {inner}
    </button>
  ) : (
    <div className={`stc-kid${flash}`}>{inner}</div>
  );
}
