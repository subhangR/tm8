/**
 * THE ATTACH PALETTE (task 01a0cfb0; decisions on 01a0008f): one wrapping row
 * of small icon + label chips under the description. It holds the ＋ Attach
 * chip (the strip's existing upload / folder / drawing menu, handed in as
 * `attachChip`) and then one chip per registry row: Memories, Drawings, Docs,
 * Artifacts, Skills, Teammates, Sessions.
 *
 * A chip opens a picker for its one kind. The search runs ON THE SERVER, by
 * kind and title (`filters.titleContains`), so an entity older than the
 * latest page can still be found. A pick adds ONE graph edge, the link the
 * row declares, and nothing else: no tm8:// link is written into the
 * description.
 *
 * VERIFIED BEFORE THE EDGE (task rule). A candidate is linked only if all of
 * these hold, and the server's `validate_edge` checks again after:
 *   · its kind is the row's kind. The server was asked for that kind, but the
 *     answer is still checked;
 *   · it is not the anchor itself;
 *   · it is not already linked.
 *
 * KIND-BLIND like everything in `files/`: kinds, labels and edge types arrive
 * as registry rows (§15.2), and icons come from `KindIcon`.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { KindIcon, getKind, type AttachPaletteRow } from '../domain';
import { titleKey, type PaletteLink } from './palette';

export interface AttachPaletteProps {
  anchorId: string;
  rows: readonly AttachPaletteRow[];
  /** Peers already linked through any row; the picker hides them. */
  linkedIds: ReadonlySet<string>;
  /**
   * The links themselves, for a row that declares `titleCollision`: a
   * candidate titled like one already linked through that row is marked.
   */
  links?: readonly PaletteLink[];
  /** Server search: the row's kind, the typed text ('' ⇒ most recent). */
  search(kind: string, text: string): Promise<EntitySummary[]>;
  /** Writes the row's edge between the anchor and `peer`. */
  link(row: AttachPaletteRow, peer: EntitySummary): Promise<void>;
  /**
   * The "＋ New …" handler for a row, or undefined when this mount cannot
   * create that kind. The row's `create` flag says the kind MAY be created;
   * the host says whether it CAN be here. `title` is the text typed into the
   * search box, if any.
   */
  createFor?(row: AttachPaletteRow): ((title: string) => void | Promise<void>) | undefined;
  /** A link landed; the host refetches the anchor so the tile shows. */
  onLinked?(): void;
  /** Set when linking is refused, so the chips disable WITH the reason (L6/D28). */
  refusal?: string | null;
  /** The ＋ Attach chip, first in the row. */
  attachChip?: ReactNode;
}

const DEBOUNCE_MS = 150;

export function AttachPalette({
  anchorId,
  rows,
  linkedIds,
  links = [],
  search,
  link,
  createFor,
  onLinked,
  refusal,
  attachChip,
}: AttachPaletteProps) {
  const [openKind, setOpenKind] = useState<string | null>(null);
  const openRow = rows.find((row) => row.kind === openKind) ?? null;

  return (
    <div className="fn-palette" data-testid="attach-palette" role="toolbar" aria-label="Attach to this entity">
      {attachChip}
      {rows.map((row) => (
        <span className="fn-palette__slot" key={row.kind}>
          <button
            type="button"
            className="fn-pal-chip"
            data-testid="attach-palette-chip"
            data-kind={row.kind}
            aria-haspopup="dialog"
            aria-expanded={openKind === row.kind}
            aria-disabled={refusal ? true : undefined}
            title={refusal ?? `Link ${row.label.toLowerCase()} to this entity`}
            onClick={(event) => {
              if (refusal) return event.preventDefault();
              setOpenKind((current) => (current === row.kind ? null : row.kind));
            }}
          >
            <span className="fn-pal-chip__icon" aria-hidden><KindIcon kind={row.kind as never} /></span>
            <span className="fn-pal-chip__label">{row.label}</span>
          </button>
          {openRow === row && !refusal ? (
            <PalettePicker
              anchorId={anchorId}
              row={row}
              linkedIds={linkedIds}
              takenTitles={row.titleCollision
                ? new Set(links.filter((l) => l.row.kind === row.kind).map((l) => titleKey(l.peer.title)))
                : undefined}
              search={search}
              link={link}
              create={row.create ? createFor?.(row) : undefined}
              onDone={(linked) => {
                setOpenKind(null);
                if (linked) onLinked?.();
              }}
            />
          ) : null}
        </span>
      ))}
    </div>
  );
}

function PalettePicker({
  anchorId,
  row,
  linkedIds,
  takenTitles,
  search,
  link,
  create,
  onDone,
}: {
  anchorId: string;
  row: AttachPaletteRow;
  linkedIds: ReadonlySet<string>;
  takenTitles: ReadonlySet<string> | undefined;
  search: AttachPaletteProps['search'];
  link: AttachPaletteProps['link'];
  create: ((title: string) => void | Promise<void>) | undefined;
  onDone(linked: boolean): void;
}) {
  const [text, setText] = useState('');
  const [options, setOptions] = useState<readonly EntitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const kindWord = getKind(row.kind).label.toLowerCase();

  /* The host rebuilds `search` and the linked set on every render; the query
     should rerun on a keystroke, not on a parent render. So both are read
     through refs, and only the text and kind drive the effect. */
  const searchRef = useRef(search);
  searchRef.current = search;
  const linkedRef = useRef(linkedIds);
  linkedRef.current = linkedIds;

  // Debounced server search; a newer keystroke owns the list.
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      searchRef.current(row.kind, text).then(
        (page) => {
          if (mine !== seq.current) return;
          setOptions(
            page.filter((option) =>
              option.kind === row.kind && option.id !== anchorId && !linkedRef.current.has(option.id)),
          );
          setActive(0);
          setError(null);
          setLoading(false);
        },
        () => {
          if (mine !== seq.current) return;
          setOptions([]);
          setError('Search failed. Try again.');
          setLoading(false);
        },
      );
    }, text === '' ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [anchorId, row.kind, text]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Outside press closes, like the strip's ＋ menu.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const wrap = wrapRef.current;
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) onDone(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onDone]);

  const pick = useCallback(
    (option: EntitySummary) => {
      // The verification, restated at the moment of writing (see the header).
      if (busy || option.kind !== row.kind || option.id === anchorId || linkedIds.has(option.id)) return;
      setBusy(true);
      setError(null);
      link(row, option).then(
        () => onDone(true),
        (failure: unknown) => {
          setBusy(false);
          setError(linkFailure(failure));
        },
      );
    },
    [anchorId, busy, link, linkedIds, onDone, row],
  );

  const makeNew = create
    ? () => {
        setBusy(true);
        Promise.resolve(create(text.trim())).then(
          () => onDone(true),
          () => {
            setBusy(false);
            setError(`Could not create the ${kindWord}. Try again.`);
          },
        );
      }
    : null;

  return (
    <div
      className="fn-pal-picker"
      data-testid="attach-palette-picker"
      data-kind={row.kind}
      role="dialog"
      aria-label={`Link ${row.label.toLowerCase()}`}
      ref={wrapRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onDone(false);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((i) => Math.max(i - 1, 0));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const option = options[active];
          if (option) pick(option);
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className="fn-pal-picker__input"
        data-testid="attach-palette-search"
        placeholder={`Search ${row.label.toLowerCase()} by title…`}
        aria-label={`Search ${row.label.toLowerCase()} by title`}
        aria-controls={listId}
        aria-activedescendant={options[active] ? `${listId}-${options[active]!.id}` : undefined}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="fn-pal-picker__list" id={listId} role="listbox" aria-busy={loading || busy}>
        {options.map((option, index) => {
          const collides = Boolean(takenTitles?.has(titleKey(option.title)));
          return (
          <button
            type="button"
            key={option.id}
            id={`${listId}-${option.id}`}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'fn-pal-picker__option fn-pal-picker__option--active' : 'fn-pal-picker__option'}
            data-testid="attach-palette-option"
            data-collides={collides ? 'true' : undefined}
            title={collides ? row.titleCollision : undefined}
            disabled={busy}
            onMouseEnter={() => setActive(index)}
            onClick={() => pick(option)}
          >
            <KindIcon kind={option.kind} />
            <span className="fn-pal-picker__title">{option.title}</span>
            {collides ? (
              <span className="fn-pal-picker__warn" data-testid="attach-palette-collision">
                {row.titleCollision}
              </span>
            ) : null}
          </button>
          );
        })}
        {!loading && options.length === 0 && !error ? (
          <p className="fn-pal-picker__empty" data-testid="attach-palette-empty">
            {text.trim() ? `No ${kindWord} titled “${text.trim()}” to link.` : `No ${kindWord} to link yet.`}
          </p>
        ) : null}
      </div>
      {makeNew ? (
        <button
          type="button"
          className="fn-pal-picker__new"
          data-testid="attach-palette-new"
          disabled={busy}
          onClick={makeNew}
        >
          ＋ New {kindWord}{text.trim() ? ` “${text.trim()}”` : ''}
        </button>
      ) : null}
      {error ? <p className="fn-pal-picker__error" role="alert">{error}</p> : null}
    </div>
  );
}

/** A closed vocabulary for a refused link, as the strip does for detach. */
const SAFE_LINK_ERRORS: Readonly<Record<string, string>> = {
  forbidden: 'You do not have permission to link this here.',
  unauthenticated: 'Sign in again before linking.',
  not_found: 'That item is gone. Search again.',
  conflict: 'That item is already linked. Reload to see it.',
  invalid_input: 'The node does not accept this link for this kind.',
};

function linkFailure(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  return (code ? SAFE_LINK_ERRORS[code] : undefined) ?? 'Could not link this. Try again.';
}
