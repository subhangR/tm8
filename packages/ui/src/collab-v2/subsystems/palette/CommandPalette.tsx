/**
 * CommandPalette (⌘K) — the graph's front door.
 *
 * THE PARITY LAW: every operation the mouse can do is reachable here with the
 * keyboard alone. Rows are `PaletteItem`s with one `run()`, so Enter and click
 * take the identical path; multi-step operations (create in…, link A→B with an
 * edge-type picker, set status…) are steps of the same list, entered with
 * Enter and exited with Backspace/Escape.
 *
 * Search is deferred for v1: the entity rows are recent/known entities from
 * the session's graph (see `usePaletteData`), and the input's result area
 * renders the designed "search coming later" slot so v2 drops straight in.
 *
 * The shell owns the ⌘K binding and renders this component through
 * `ShellLayout.palette` when `nav.paletteOpen` is set; `openPaletteWith(id)`
 * is the imperative entry point for context-scoped opens.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import './palette.css';
import { useFacade } from '../../entity/context';
import { EntityChip } from '../../entity/EntityChip';
import { Kbd } from '../../kit';
import { KIND_ORDER, registryFor } from '../../registry';
import { createListKeyNav } from '../../shell/keyboard';
import { useNavStore } from '../../stores/nav';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { EntityKind, EntitySummary, SpaceId } from '../../types/contract';
import {
  buildCreateItems, buildEntityItems, buildGotoItems, buildLinkTypeItems,
  buildRootItems, buildStatusItems, matchesQuery, parseQuery,
} from './actions';
import { dismissPalette, startRecentsTracker } from './recents';
import type {
  PaletteDeps, PaletteExecution, PaletteItem, PaletteMode, PaletteNotice,
} from './types';
import { useContextEntity, useFacadeActions, useKnownEntities } from './usePaletteData';

export interface CommandPaletteProps {
  /** Defaults to the provider's facade. */
  facade?: CollabFacade;
  /** Defaults to the nav store's space. */
  spaceId?: SpaceId;
  /** Extra entities to offer (a screen can hand the palette its collection). */
  entities?: EntitySummary[];
  onExecuted?: (execution: PaletteExecution) => void;
  onNotice?: (notice: PaletteNotice) => void;
  /** Render regardless of `nav.paletteOpen` (gallery / visual QA). */
  forceOpen?: boolean;
}

const OPTION_ID = (index: number): string => `cv2-palette-option-${index}`;

function modeTitle(mode: PaletteMode, ctxTitle?: string): string | null {
  switch (mode.kind) {
    case 'root': return null;
    case 'goto': return 'Go to…';
    case 'create': return `New ${mode.entityKind}${ctxTitle ? ` in ${ctxTitle}` : ''} — type a title, then ⏎`;
    case 'link-target': return 'Link to which entity?';
    case 'link-type': return 'Which kind of edge?';
    case 'status': return 'Set status to…';
  }
}

export function CommandPalette({
  facade: facadeProp, spaceId: spaceIdProp, entities, onExecuted, onNotice, forceOpen = false,
}: CommandPaletteProps) {
  const contextFacade = useFacade();
  const facade = facadeProp ?? contextFacade;

  const paletteOpen = useNavStore((s) => s.paletteOpen);
  const navSpaceId = useNavStore((s) => s.spaceId);
  const spaceId = spaceIdProp ?? navSpaceId;
  const open = forceOpen || paletteOpen;

  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<EntityKind[]>([]);
  const [history, setHistory] = useState<PaletteMode[]>([{ kind: 'root' }]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PaletteNotice | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mode = history[history.length - 1];

  const contextEntity = useContextEntity(facade);
  const known = useKnownEntities(facade, entities);
  const facadeActions = useFacadeActions(facade, open ? contextEntity?.id : undefined);

  // Track what the viewer visits while this is mounted. Hosts that want
  // full-session recents call `startRecentsTracker()` once at boot instead —
  // it is idempotent, so both together are fine.
  useEffect(() => startRecentsTracker(), []);

  // Fresh state every time the palette opens — a palette that remembers the
  // last half-typed step is a palette you can't trust.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setKinds([]);
    setHistory([{ kind: 'root' }]);
    setIndex(0);
    setNotice(null);
    inputRef.current?.focus();
  }, [open]);

  const pushMode = useCallback((next: PaletteMode) => {
    setHistory((h) => [...h, next]);
    setIndex(0);
  }, []);

  const popMode = useCallback(() => {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
    setIndex(0);
  }, []);

  const close = useCallback(() => { dismissPalette(); }, []);

  const notify = useCallback((n: PaletteNotice) => {
    setNotice(n);
    onNotice?.(n);
  }, [onNotice]);

  const deps = useMemo<PaletteDeps>(() => {
    const nav = useNavStore.getState();
    return {
      facade,
      spaceId,
      nav: {
        setView: nav.setView,
        pushPanel: nav.pushPanel,
        pinPanel: nav.pinPanel,
        promotePanel: nav.promotePanel,
        closePalette: nav.closePalette,
      },
      contextEntity,
      known,
      setMode: pushMode,
      resetQuery: () => setQuery(''),
      close,
      notify,
      onExecuted,
      query,
    };
  }, [facade, spaceId, contextEntity, known, pushMode, close, notify, onExecuted, query]);

  const { text, kinds: queryKinds } = parseQuery(query);
  const activeKinds = useMemo(
    () => [...new Set([...kinds, ...queryKinds])],
    [kinds, queryKinds],
  );

  const entityPool = useMemo(
    () => (activeKinds.length === 0 ? known : known.filter((e) => activeKinds.includes(e.kind))),
    [known, activeKinds],
  );

  /** Rows for the current step, before query filtering. */
  const rawItems = useMemo<PaletteItem[]>(() => {
    switch (mode.kind) {
      case 'root':
        return [
          ...buildRootItems(deps, facadeActions),
          ...buildEntityItems(deps, entityPool),
        ];
      case 'goto':
        return buildGotoItems(deps);
      case 'create':
        return buildCreateItems(deps, mode.entityKind, mode.parentId);
      case 'link-target':
        return buildEntityItems(deps, entityPool, {
          section: 'Link to',
          onPick: (entity) => pushMode({ kind: 'link-type', sourceId: mode.sourceId, targetId: entity.id }),
        });
      case 'link-type':
        return buildLinkTypeItems(deps, mode.sourceId, mode.targetId);
      case 'status':
        return buildStatusItems(deps, mode.targetId);
    }
  }, [mode, deps, facadeActions, entityPool, pushMode]);

  // The create step uses the input as a title field, so it must not self-filter.
  const filtered = useMemo(
    () => (mode.kind === 'create' ? rawItems : rawItems.filter((i) => matchesQuery(i, text))),
    [rawItems, text, mode.kind],
  );

  /** Group by section (first-appearance order) and flatten — display order IS index order. */
  const { rows, sections } = useMemo(() => {
    const order: string[] = [];
    const bucket = new Map<string, PaletteItem[]>();
    for (const item of filtered) {
      if (!bucket.has(item.section)) { bucket.set(item.section, []); order.push(item.section); }
      (bucket.get(item.section) as PaletteItem[]).push(item);
    }
    const flat: PaletteItem[] = [];
    const secs: Array<{ label: string; start: number; items: PaletteItem[] }> = [];
    for (const section of order) {
      const items = bucket.get(section) as PaletteItem[];
      secs.push({ label: section, start: flat.length, items });
      flat.push(...items);
    }
    return { rows: flat, sections: secs };
  }, [filtered]);

  useEffect(() => { setIndex((i) => (i >= rows.length ? 0 : i)); }, [rows.length]);

  const activate = useCallback((i: number) => {
    const item = rows[i];
    if (!item || busy) return;
    const result = item.run();
    if (result instanceof Promise) {
      setBusy(true);
      void result.finally(() => setBusy(false));
    }
  }, [rows, busy]);

  const listNav = useMemo(
    () => createListKeyNav({
      count: rows.length,
      index,
      onIndexChange: setIndex,
      onActivate: activate,
      loop: true,
    }),
    [rows.length, index, activate],
  );

  if (!open) return null;

  const ctxTitle = contextEntity?.title;
  const stepLabel = modeTitle(mode, mode.kind === 'create' && mode.parentId ? ctxTitle : undefined);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (history.length > 1) popMode();
      else close();
      return;
    }
    if (e.key === 'Backspace' && query === '' && history.length > 1) {
      e.preventDefault();
      popMode();
      return;
    }
    // Enter in the create step commits the typed title even with no selection.
    if (e.key === 'Enter' && rows.length > 0) {
      e.stopPropagation();
    }
    listNav(e as unknown as Parameters<typeof listNav>[0]);
  };

  const toggleKind = (kind: EntityKind): void => {
    setKinds((k) => (k.includes(kind) ? k.filter((x) => x !== kind) : [...k, kind]));
    setIndex(0);
    inputRef.current?.focus();
  };

  return (
    <div className="cv2-palette__scrim" data-testid="palette-scrim" onMouseDown={close}>
      <div
        className="cv2-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cv2-palette__head">
          {contextEntity && (
            <span className="cv2-palette__ctx" data-testid="palette-context">
              <EntityChip entity={contextEntity} interactive={false} draggable={false} variant="ref" />
            </span>
          )}
          <input
            ref={inputRef}
            className="cv2-palette__input"
            data-testid="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="cv2-palette-list"
            aria-activedescendant={rows.length > 0 ? OPTION_ID(index) : undefined}
            aria-label={stepLabel ?? 'Search actions and recent entities'}
            autoFocus
            value={query}
            placeholder={stepLabel ?? 'Type a command… (search lands in a later release)'}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={onKeyDown}
          />
          <span className="cv2-palette__hint">
            <Kbd>↑↓</Kbd><Kbd>⏎</Kbd><Kbd>esc</Kbd>
          </span>
        </div>

        {stepLabel && (
          <div className="cv2-palette__step" data-testid="palette-step">
            <span>{stepLabel}</span>
            <span className="cv2-palette__stepback"><Kbd>⌫</Kbd> back</span>
          </div>
        )}

        <div className="cv2-palette__filters" role="group" aria-label="Kind filters">
          <button
            type="button"
            className="cv2-palette__filter"
            role="checkbox"
            aria-checked={activeKinds.length === 0}
            data-active={activeKinds.length === 0 || undefined}
            onClick={() => { setKinds([]); setIndex(0); inputRef.current?.focus(); }}
          >
            All
          </button>
          {KIND_ORDER.map((kind) => {
            const entry = registryFor(kind);
            const on = activeKinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                className="cv2-palette__filter"
                role="checkbox"
                aria-checked={on}
                data-active={on || undefined}
                onClick={() => toggleKind(kind)}
              >
                <span aria-hidden="true">{entry.glyph}</span> {entry.label}
              </button>
            );
          })}
        </div>

        <div
          className="cv2-palette__list"
          id="cv2-palette-list"
          role="listbox"
          aria-label="Palette results"
          data-testid="palette-list"
        >
          {rows.length === 0 && (
            <div className="cv2-palette__empty" data-testid="palette-empty">
              Nothing matches “{text.trim()}”.
            </div>
          )}
          {sections.map((section) => (
            <div className="cv2-palette__section" key={section.label}>
              <div className="cv2-palette__sectionhead">{section.label}</div>
              {section.items.map((item, i) => {
                const flatIndex = section.start + i;
                const selected = flatIndex === index;
                return (
                  <div
                    key={item.id}
                    id={OPTION_ID(flatIndex)}
                    role="option"
                    aria-selected={selected}
                    className="cv2-palette__row"
                    data-selected={selected || undefined}
                    data-item-id={item.id}
                    onMouseMove={() => setIndex(flatIndex)}
                    onClick={() => activate(flatIndex)}
                  >
                    {item.entity
                      ? <EntityChip entity={item.entity} interactive={false} draggable={false} />
                      : <span className="cv2-palette__glyph" aria-hidden="true">{item.glyph ?? '•'}</span>}
                    <span className="cv2-palette__label">{item.label}</span>
                    {item.hint && <span className="cv2-palette__rowhint">{item.hint}</span>}
                  </div>
                );
              })}
              {section.label === 'Recent & known' && (
                <div className="cv2-palette__slot" data-testid="palette-search-slot">
                  Full search arrives in a later release — showing recent &amp; known entities.
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="cv2-palette__foot">
          {notice
            ? <span className={`cv2-palette__notice cv2-palette__notice--${notice.kind}`} role="status">{notice.message}</span>
            : <span className="cv2-palette__notice" role="status">{busy ? 'Working…' : `${rows.length} result${rows.length === 1 ? '' : 's'}`}</span>}
          <span className="cv2-palette__foothint">
            <Kbd>kind:task</Kbd> filters · <Kbd>tab</Kbd> reaches kind chips
          </span>
        </div>
      </div>
    </div>
  );
}

/** Convenience wrapper for hosts that always want the store-driven palette. */
export function usePaletteOpen(): boolean {
  return useNavStore((s) => s.paletteOpen);
}
