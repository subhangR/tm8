/**
 * THE DESIGNS HOME — bare `/craft` (Craft → Designs, change list item 9).
 *
 * `Craft · [Find designs…] [+ New design]` over a grid of design cards. A card
 * shows its pages as kind marks (in page order), the title, `N pages · N
 * chats`, when it was last edited, and a running dot while a session is live
 * on it. A card is a door into `/craft/{id}`. + New design creates the entity
 * and goes straight in — the craft agent adds the first page from there.
 *
 * ONE empty state: a space with no designs says what a design is and offers
 * the one button. A search that matches nothing is not a second empty state;
 * it is one quiet line under the search box.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { KindIcon } from '../domain';
import { relTime } from '../kit/time';
import type { DesignCard, DesignsSource } from './designs-source';
import './designs-home.css';

/** Marks drawn on a card before the rest fold into `+N`. */
export const CARD_PAGE_MARKS = 6;

export interface DesignsHomeProps {
  source: DesignsSource;
  onOpenDesign(id: EntityId): void;
  onNotice?: ((text: string) => void) | undefined;
  /** Injected clock for the edited-ago line (tests). */
  now?: number | undefined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function DesignsHome({ source, onOpenDesign, onNotice, now }: DesignsHomeProps) {
  const [cards, setCards] = useState<readonly DesignCard[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCards(await source.list());
      setState('ready');
    } catch {
      setState('error');
    }
  }, [source]);

  useEffect(() => {
    void refresh();
    return source.subscribe(() => void refresh());
  }, [source, refresh]);

  const create = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      onOpenDesign(await source.create('Untitled design'));
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not create the design.');
    } finally {
      setCreating(false);
    }
  }, [creating, source, onOpenDesign, onNotice]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? cards.filter((card) => card.title.toLowerCase().includes(needle)) : cards),
    [cards, needle],
  );
  const empty = state === 'ready' && cards.length === 0;

  return (
    <div className="dsh-root" data-testid="designs-home">
      <header className="dsh-header">
        <h1 className="dsh-title">Craft</h1>
        {empty ? null : (
          <input
            className="dsh-find"
            type="search"
            placeholder="Find designs…"
            aria-label="Find designs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="dsh-find"
          />
        )}
        <button
          type="button"
          className="dsh-btn dsh-btn--primary"
          onClick={() => void create()}
          disabled={creating}
          data-testid="dsh-new"
        >
          ＋ New design
        </button>
      </header>

      {state === 'error' ? (
        <div className="dsh-note" role="alert" data-testid="dsh-error">
          Could not load designs.{' '}
          <button type="button" className="dsh-link" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : empty ? (
        <div className="dsh-empty" data-testid="dsh-empty">
          <h2 className="dsh-empty__title">Plan the work before it exists</h2>
          <p className="dsh-empty__lead">
            A design is a set of pages you build with the craft agent — a blueprint of the tasks and who owns them,
            and the docs, artifacts and drawings around it. Nothing is created until you press <strong>Run</strong>.
          </p>
          <button
            type="button"
            className="dsh-btn dsh-btn--primary"
            onClick={() => void create()}
            disabled={creating}
            data-testid="dsh-empty-new"
          >
            ＋ New design
          </button>
        </div>
      ) : state === 'ready' && shown.length === 0 ? (
        <p className="dsh-note" data-testid="dsh-no-match">
          No designs match “{query.trim()}”.
        </p>
      ) : (
        <ul className="dsh-grid" aria-busy={state === 'loading'} data-testid="dsh-grid">
          {shown.map((card) => (
            <li key={card.id}>
              <DesignCardTile card={card} now={now} onOpen={() => onOpenDesign(card.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DesignCardTile({ card, now, onOpen }: { card: DesignCard; now?: number | undefined; onOpen(): void }) {
  const marks = card.pageKinds.slice(0, CARD_PAGE_MARKS);
  const more = card.pageKinds.length - marks.length;
  const edited = relTime(card.activityAt, now);
  return (
    <button type="button" className="dsh-card" onClick={onOpen} data-testid="dsh-card" data-design-id={card.id}>
      <span className="dsh-card__pages" aria-hidden data-testid="dsh-card-pages">
        {marks.map((kind, index) => (
          <span key={index} className="dsh-card__page" data-kind={kind}>
            <KindIcon kind={kind} size={16} />
          </span>
        ))}
        {more > 0 ? <span className="dsh-card__more">+{more}</span> : null}
      </span>
      <span className="dsh-card__title">
        {card.running ? <span className="dsh-card__live" title="A session is running" data-testid="dsh-card-live" /> : null}
        <span className="dsh-card__name">{card.title || 'Untitled design'}</span>
      </span>
      <span className="dsh-card__meta" data-testid="dsh-card-meta">
        {plural(card.pageCount, 'page', 'pages')} · {plural(card.chatCount, 'chat', 'chats')}
      </span>
      {edited ? <span className="dsh-card__when">edited {edited}</span> : null}
    </button>
  );
}
