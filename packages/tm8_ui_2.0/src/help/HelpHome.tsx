/**
 * HELP HOME — the guide's master page, and the first thing Help shows.
 *
 * WHY IT EXISTS. The guide used to open on plate 01, which teaches HOW tm8
 * works before a new reader has been told WHAT tm8 is. This page is the missing
 * title spread: one hero that answers "what is tm8" in a sentence, and one map
 * that shows the whole guide before any page of it is open. A reader who leaves
 * after the hero still leaves knowing what the product is.
 *
 * IT IS NATIVE, NOT A PLATE, on purpose. Plates are vendored artifact bundles
 * with provenance, hash-pinned and rendered in a sandboxed frame; this page is
 * the shell's own front matter — it enumerates the registry (`HELP_SET`), so it
 * must move when the registry moves. Vendoring it would pin yesterday's page
 * count into today's build. Counts and destinations are resolved from
 * `HelpSet`; the shell authors the framing, pillars and newcomer starting
 * points around them.
 *
 * ONE COMPONENT, TWO DOORS. On a wide screen it fills the reader pane and a
 * chapter card OPENS that chapter's first plate — the contents shelf is already
 * beside it. Stacked, it is the head of the one scrolling surface and a card
 * SCROLLS to that chapter's shelf section below. The difference is the caller's
 * (`onChapter`), not this file's.
 */
import { type HelpChapter, type HelpSet } from './help-set';

const STARTING_POINTS = [
  {
    eyebrow: 'New to tm8',
    title: 'See one request become real work',
    summary: 'Follow a conversation as it creates a task, a live session, and a durable graph record.',
    slug: 'one-conversation-one-graph',
  },
  {
    eyebrow: 'Set up the workspace',
    title: 'Learn how the graph fits together',
    summary: 'Build a useful working context from ordinary entities and truthful connections.',
    slug: 'the-graph-assembling',
  },
  {
    eyebrow: 'Work with AI',
    title: 'Meet teammates and sessions',
    summary: 'Understand the durable identity, memory, model, and live process behind an AI teammate.',
    slug: 'anatomy-of-a-teammate',
  },
  {
    eyebrow: 'Deliver as a team',
    title: 'Watch many hands share one task',
    summary: 'See people and agents work through different surfaces without making private copies.',
    slug: 'one-task-many-hands',
  },
] as const;

export interface HelpHomeProps {
  set: HelpSet;
  /** Open a plate by slug — the hero's "begin" verb. */
  onOpen(slug: string): void;
  /** What a chapter card does: open its first plate, or scroll to its shelf. */
  onChapter(chapter: HelpChapter): void;
}

export function HelpHome({ set, onOpen, onChapter }: HelpHomeProps) {
  const first = set.pages[0];
  const openChapters = set.chapters.filter((chapter) => chapter.pages.length > 0);

  return (
    <article className="hlp-home" data-testid="help-home" aria-labelledby="hlp-home-title">
      <header className="hlp-home__hero">
        <p className="hlp-home__kicker">
          <span>tm8</span>
          <span aria-hidden>◆</span>
          <span>Field guide</span>
          <span aria-hidden>◆</span>
          <span>Start here</span>
        </p>
        <h1 id="hlp-home-title" className="hlp-home__title">What is tm8?</h1>
        <p className="hlp-home__answer">
          A shared workspace where people and AI teammates work side by side —
          one team, one graph, one durable record.
        </p>
        <p className="hlp-home__detail">
          Tasks, plans, messages, documents and memory all live as entities in a
          single connected graph. Agents run as real sessions with identity and
          memory of their own — assigned, addressed and answerable like any
          teammate — and everything that happens is on the record, while it
          happens and after.
        </p>
      </header>

      <ul className="hlp-home__pillars" aria-label="What tm8 is made of">
        <li className="hlp-home__pillar">
          <h2>One graph</h2>
          <p>Every piece of work is an entity you can link, open and build on. Nothing lives in a silo; nothing drifts apart.</p>
        </li>
        <li className="hlp-home__pillar">
          <h2>Real teammates</h2>
          <p>Agents hold identity, memory and running sessions. Assign them work, message them mid-task, read their receipts.</p>
        </li>
        <li className="hlp-home__pillar">
          <h2>On the record</h2>
          <p>Every action lands as a durable event. Watch work while it happens; replay it any time after.</p>
        </li>
      </ul>

      {first ? (
        <div className="hlp-home__begin">
          <button type="button" className="hlp-home__cta" data-testid="help-home-begin" onClick={() => onOpen(first.slug)}>
            <span className="hlp-home__cta-verb">Begin the guide</span>
            <span className="hlp-home__cta-where">
              Plate {String(first.number).padStart(2, '0')} · {first.title}
            </span>
            <span className="hlp-home__cta-arrow" aria-hidden>→</span>
          </button>
        </div>
      ) : null}

      <section className="hlp-home__starts" aria-labelledby="hlp-home-starts-title">
        <div className="hlp-rule"><span id="hlp-home-starts-title">Choose your starting point</span></div>
        <p className="hlp-home__map-lede">
          You do not have to read all {set.pages.length} plates in order. Pick the
          outcome closest to what brought you here.
        </p>
        <ul className="hlp-home__start-grid">
          {STARTING_POINTS.map((point) => {
            const page = set.pages.find((candidate) => candidate.slug === point.slug);
            if (!page) return null;
            return (
              <li key={point.slug}>
                <button
                  type="button"
                  className="hlp-start"
                  data-testid="help-starting-point"
                  onClick={() => onOpen(page.slug)}
                >
                  <span className="hlp-start__eyebrow">{point.eyebrow}</span>
                  <span className="hlp-start__title">{point.title}</span>
                  <span className="hlp-start__summary">{point.summary}</span>
                  <span className="hlp-start__foot">
                    <span>Plate {String(page.number).padStart(2, '0')}</span>
                    <span aria-hidden>→</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="hlp-home__map" aria-labelledby="hlp-home-map-title">
        <div className="hlp-rule"><span id="hlp-home-map-title">The map</span></div>
        <p className="hlp-home__map-lede">
          The guide reads front to back — {set.pages.length} plates across{' '}
          {openChapters.length} chapters. Start at the beginning, or enter at the
          chapter you need.
        </p>
        <ol className="hlp-home__chapters">
          {set.chapters.map((chapter) => (
            <li key={chapter.id}>
              <button
                type="button"
                className="hlp-card"
                data-testid="help-home-chapter"
                data-section={chapter.id}
                disabled={chapter.pages.length === 0}
                onClick={() => onChapter(chapter)}
              >
                <span className="hlp-card__number" aria-hidden>{chapter.number}</span>
                <span className="hlp-card__eyebrow">{chapter.eyebrow}</span>
                <span className="hlp-card__title">{chapter.title}</span>
                <span className="hlp-card__summary">{chapter.summary}</span>
                <span className="hlp-card__foot">
                  <span className="hlp-card__count">
                    {chapter.pages.length === 0
                      ? 'In preparation'
                      : `${chapter.pages.length} ${chapter.pages.length === 1 ? 'plate' : 'plates'}`}
                  </span>
                  {chapter.pages.length > 0 ? <span className="hlp-card__arrow" aria-hidden>→</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
