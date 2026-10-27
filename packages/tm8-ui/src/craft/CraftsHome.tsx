/**
 * THE CRAFTS HOME — bare `/craft` (Craft → Crafts, change list item 9).
 *
 * `Craft · [Find crafts…] [+ New craft]` over a grid of craft cards. A card
 * shows its pages as kind marks (in page order), the title, `N pages · N
 * chats`, when it was last edited, and a running dot while a session is live
 * on it. A card is a door into `/craft/{id}`; its ⋯ menu renames it. + New
 * craft asks for a name first (the field opens on "Untitled craft", selected,
 * so typing replaces it), then creates the entity and goes straight in — the
 * craft agent adds the first page from there.
 *
 * ONE empty state: a space with no crafts says what a craft is and offers
 * the one button. A search that matches nothing is not a second empty state;
 * it is one quiet line under the search box.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { KindIcon } from '../domain';
import { relTime } from '../kit/time';
import { CraftNameField } from './CraftNameField';
import type { CraftCard, CraftsSource } from './crafts-source';
import './crafts-home.css';

/** Marks drawn on a card before the rest fold into `+N`. */
export const CARD_PAGE_MARKS = 6;
/** The name a new craft's field opens on. */
export const NEW_CRAFT_NAME = 'Untitled craft';

export interface CraftsHomeProps {
  source: CraftsSource;
  onOpenCraft(id: EntityId): void;
  onNotice?: ((text: string) => void) | undefined;
  /** Injected clock for the edited-ago line (tests). */
  now?: number | undefined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function CraftsHome({ source, onOpenCraft, onNotice, now }: CraftsHomeProps) {
  const [cards, setCards] = useState<readonly CraftCard[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  /* Where the new craft's name is being typed: the header or the empty state. */
  const [naming, setNaming] = useState<'header' | 'empty' | null>(null);

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

  const create = useCallback(async (name: string) => {
    if (creating) return;
    setCreating(true);
    setNaming(null);
    try {
      onOpenCraft(await source.create(name));
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not create the craft.');
    } finally {
      setCreating(false);
    }
  }, [creating, source, onOpenCraft, onNotice]);

  const rename = useCallback(async (card: CraftCard, name: string) => {
    if (name === card.title) return;
    /* Drawn at once; the node's event re-reads the list either way. */
    setCards((all) => all.map((c) => (c.id === card.id ? { ...c, title: name } : c)));
    try {
      await source.rename(card.id, name, card.version);
    } catch (error) {
      onNotice?.(error instanceof Error ? `Could not rename the craft: ${error.message}` : 'Could not rename the craft.');
      void refresh();
    }
  }, [source, onNotice, refresh]);

  const nameField = (where: 'header' | 'empty') => (
    <CraftNameField
      initial={NEW_CRAFT_NAME}
      label="Name the new craft"
      submitLabel="Create"
      testId="dsh-new-name"
      onCommit={(name) => void create(name)}
      onCancel={() => setNaming((was) => (was === where ? null : was))}
    />
  );

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? cards.filter((card) => card.title.toLowerCase().includes(needle)) : cards),
    [cards, needle],
  );
  const empty = state === 'ready' && cards.length === 0;

  return (
    <div className="dsh-root" data-testid="crafts-home">
      <header className="dsh-header">
        <h1 className="dsh-title">Craft</h1>
        {empty ? null : (
          <input
            className="dsh-find"
            type="search"
            placeholder="Find crafts…"
            aria-label="Find crafts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="dsh-find"
          />
        )}
        {naming === 'header' ? (
          nameField('header')
        ) : (
          <button
            type="button"
            className="dsh-btn dsh-btn--primary"
            onClick={() => setNaming('header')}
            disabled={creating}
            data-testid="dsh-new"
          >
            ＋ New craft
          </button>
        )}
      </header>

      {state === 'error' ? (
        <div className="dsh-note" role="alert" data-testid="dsh-error">
          Could not load crafts.{' '}
          <button type="button" className="dsh-link" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : empty ? (
        <div className="dsh-empty" data-testid="dsh-empty">
          <h2 className="dsh-empty__title">Plan the work before it exists</h2>
          <p className="dsh-empty__lead">
            A craft is a set of pages you build with the craft agent — a blueprint of the tasks and who owns them,
            and the docs, artifacts and drawings around it. Nothing is created until you press <strong>Run</strong>.
          </p>
          {naming === 'empty' ? (
            nameField('empty')
          ) : (
            <button
              type="button"
              className="dsh-btn dsh-btn--primary"
              onClick={() => setNaming('empty')}
              disabled={creating}
              data-testid="dsh-empty-new"
            >
              ＋ New craft
            </button>
          )}
        </div>
      ) : state === 'ready' && shown.length === 0 ? (
        <p className="dsh-note" data-testid="dsh-no-match">
          No crafts match “{query.trim()}”.
        </p>
      ) : (
        <ul className="dsh-grid" aria-busy={state === 'loading'} data-testid="dsh-grid">
          {shown.map((card) => (
            <li key={card.id}>
              <CraftCardTile
                card={card}
                now={now}
                onOpen={() => onOpenCraft(card.id)}
                onRename={(name) => void rename(card, name)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CraftCardTile({
  card,
  now,
  onOpen,
  onRename,
}: {
  card: CraftCard;
  now?: number | undefined;
  onOpen(): void;
  onRename(name: string): void;
}) {
  const [renaming, setRenaming] = useState(false);
  const marks = card.pageKinds.slice(0, CARD_PAGE_MARKS);
  const more = card.pageKinds.length - marks.length;
  const edited = relTime(card.activityAt, now);
  const title = card.title || NEW_CRAFT_NAME;
  const inner = (
    <>
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
        {renaming ? (
          <CraftNameField
            initial={title}
            label={`Rename ${title}`}
            className="dsh-card__rename"
            testId="dsh-card-rename"
            onCommit={(name) => {
              setRenaming(false);
              onRename(name);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="dsh-card__name">{title}</span>
        )}
      </span>
      <span className="dsh-card__meta" data-testid="dsh-card-meta">
        {plural(card.pageCount, 'page', 'pages')} · {plural(card.chatCount, 'chat', 'chats')}
      </span>
      {edited ? <span className="dsh-card__when">edited {edited}</span> : null}
    </>
  );
  return (
    <div className="dsh-card-wrap">
      {/* A field cannot sit inside a button: while renaming the card is a plain box. */}
      {renaming ? (
        <div className="dsh-card" data-testid="dsh-card" data-craft-id={card.id} data-renaming>
          {inner}
        </div>
      ) : (
        <button type="button" className="dsh-card" onClick={onOpen} data-testid="dsh-card" data-craft-id={card.id}>
          {inner}
        </button>
      )}
      {renaming ? null : <CardMenu title={title} onRename={() => setRenaming(true)} />}
    </div>
  );
}

/** The card's ⋯: what a craft can have done to it from the home. */
function CardMenu({ title, onRename }: { title: string; onRename(): void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div className="dsh-card-menu" ref={rootRef} data-open={open || undefined}>
      <button
        type="button"
        className="dsh-card-menu__btn"
        aria-label={`More for ${title}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="dsh-card-more"
        onClick={() => setOpen((was) => !was)}
      >
        ⋯
      </button>
      {open ? (
        <div className="dsh-card-menu__pop" role="menu" aria-label={`${title} actions`}>
          <button
            type="button"
            role="menuitem"
            className="dsh-card-menu__item"
            data-testid="dsh-card-rename-item"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            Rename
          </button>
        </div>
      ) : null}
    </div>
  );
}
