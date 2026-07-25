/**
 * Keyboard parity for the grammar (DEF-16): every drop has a keyboard path.
 *
 *   openMoveTo(entity) → "Move to…" picker  = the parent-zone drop (reparent)
 *   openLink(entity)   → "Link…" picker     = drop onto the target's surface
 *
 * Both resolve through the SAME grammar table and commit through the SAME
 * `runPlacement` pipe as pointer drops — one placements command, ghost-label
 * text as row hints, undo toast, activity. The pickers run on recent/known
 * entities (graph store), matching the palette's no-search rule (DEV-13).
 *
 * `InteractionMenusHost` is mounted by hosts (or standalone); the palette can
 * later gain "Move to… / Link…" rows that just call these opens (one-line
 * Pulse change, reported to Atlas).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useFacade } from '../entity';
import { kindCan, registryFor } from '../registry';
import { useGraphStore } from '../stores';
import { openPaletteWith } from '../subsystems/palette';
import type { EntitySummary } from '../types/contract';
import {
  resolveDrop, sourceRef, targetRef, surfaceForEntity,
  type PlacementOption,
} from './grammar';
import { runPlacement } from './execute';

// ---------------------------------------------------------------------------
// imperative open state (mirrors openPaletteWith / openCreation)
// ---------------------------------------------------------------------------

type MenuKind = 'move' | 'link';

interface MenuState {
  open: { kind: MenuKind; entity: EntitySummary } | null;
  show: (kind: MenuKind, entity: EntitySummary) => void;
  close: () => void;
}

export const useInteractionMenuStore = create<MenuState>()((set) => ({
  open: null,
  show: (kind, entity) => set({ open: { kind, entity } }),
  close: () => set({ open: null }),
}));

/** Keyboard "Move to…" — the parent-zone drop for `entity`. */
export function openMoveTo(entity: EntitySummary): void {
  useInteractionMenuStore.getState().show('move', entity);
}

/** Keyboard "Link…" — the grammar drop of `entity` onto a picked target. */
export function openLink(entity: EntitySummary): void {
  useInteractionMenuStore.getState().show('link', entity);
}

// ---------------------------------------------------------------------------
// shared picker list (arrow keys + Enter + Escape, no pointer needed)
// ---------------------------------------------------------------------------

interface PickerRow {
  id: string;
  label: string;
  hint?: string;
  glyph?: ReactNode;
  run: () => void;
}

function PickerList({ title, rows, onClose, emptyHint }: {
  title: string;
  rows: PickerRow[];
  onClose: () => void;
  emptyHint?: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.label} ${r.hint ?? ''}`.toLowerCase().includes(needle));
  }, [rows, query]);

  useEffect(() => { setIndex(0); }, [query]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && filtered[index]) { e.preventDefault(); filtered[index].run(); }
  };

  return (
    <div className="cv2-ixmenu__backdrop" data-testid="interaction-menu">
      <div className="cv2-ixmenu" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <header className="cv2-ixmenu__head">{title}</header>
        <input
          ref={inputRef}
          className="cv2-ixmenu__filter"
          aria-label="Filter"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div role="listbox" aria-label={title} className="cv2-ixmenu__list">
          {filtered.length === 0 && <div className="cv2-ixmenu__empty">{emptyHint ?? 'Nothing matches.'}</div>}
          {filtered.map((row, i) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={i === index}
              className={`cv2-ixmenu__row${i === index ? ' cv2-ixmenu__row--active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={row.run}
            >
              {row.glyph && <span className="cv2-ixmenu__glyph" aria-hidden="true">{row.glyph}</span>}
              <span className="cv2-ixmenu__label">{row.label}</span>
              {row.hint && <span className="cv2-ixmenu__hint">{row.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the two menus
// ---------------------------------------------------------------------------

/** Known entities from the session graph, newest activity first. */
function knownEntities(): EntitySummary[] {
  return Object.values(useGraphStore.getState().entities)
    .filter((e) => e.deletedAt == null)
    .sort((a, b) => (a.activityAt < b.activityAt ? 1 : -1));
}

export function MoveToMenu({ entity, onClose }: { entity: EntitySummary; onClose: () => void }) {
  const facade = useFacade();
  const source = sourceRef(entity);

  const rows: PickerRow[] = knownEntities()
    .filter((c) => c.kind === entity.kind && c.id !== entity.id && c.id !== entity.parentId)
    .map((candidate): PickerRow | null => {
      const target = targetRef(candidate, 'parent-zone');
      const options = resolveDrop(source, target);
      if (options.length === 0) return null;
      return {
        id: candidate.id,
        label: candidate.title,
        hint: options[0].ghost,
        glyph: registryFor(candidate.kind).glyph,
        run: () => {
          onClose();
          void runPlacement(facade, { source, target, option: options[0] });
        },
      };
    })
    .filter((r): r is PickerRow => r != null);

  const reparentable = kindCan(entity.kind, 'treeReparentable');
  return (
    <PickerList
      title={`Move ${entity.title} to…`}
      rows={reparentable ? rows : []}
      onClose={onClose}
      emptyHint={reparentable
        ? 'No other parent of this kind is known yet.'
        : `${registryFor(entity.kind).labelPlural} cannot be re-parented.`}
    />
  );
}

export function LinkMenu({ entity, onClose }: { entity: EntitySummary; onClose: () => void }) {
  const facade = useFacade();
  const source = sourceRef(entity);
  const [picked, setPicked] = useState<EntitySummary | null>(null);

  if (!picked) {
    const rows: PickerRow[] = knownEntities()
      .filter((c) => c.id !== entity.id)
      .map((candidate): PickerRow | null => {
        const surface = surfaceForEntity(candidate);
        const sameKindParent = candidate.kind === entity.kind ? targetRef(candidate, 'parent-zone') : null;
        const surfaceOptions = surface ? resolveDrop(source, targetRef(candidate, surface)) : [];
        const hasOptions = surfaceOptions.length > 0
          || (sameKindParent ? resolveDrop(source, sameKindParent).length > 0 : false);
        if (!hasOptions) return null;
        return {
          id: candidate.id,
          label: candidate.title,
          hint: registryFor(candidate.kind).label,
          glyph: registryFor(candidate.kind).glyph,
          run: () => setPicked(candidate),
        };
      })
      .filter((r): r is PickerRow => r != null);
    return (
      <PickerList
        title={`Link ${entity.title} to…`}
        rows={rows}
        onClose={onClose}
        emptyHint={(
          <>
            No grammar target known.{' '}
            <button
              type="button"
              className="cv2-thread__act"
              onClick={() => { onClose(); openPaletteWith(entity.id); }}
            >
              Open ⌘K for a custom edge
            </button>
          </>
        )}
      />
    );
  }

  // Step 2 — the same options a drop on that target would offer (≤3/surface).
  const optionRows: PickerRow[] = [];
  const surfaces = [surfaceForEntity(picked), picked.kind === entity.kind ? 'parent-zone' as const : null];
  for (const surface of surfaces) {
    if (!surface) continue;
    const target = targetRef(picked, surface);
    for (const option of resolveDrop(source, target)) {
      optionRows.push({
        id: `${surface}:${option.intent}:${option.label}`,
        label: option.label,
        hint: option.ghost,
        run: () => {
          onClose();
          void runPlacement(facade, { source, target, option });
        },
      });
    }
  }

  return (
    <PickerList
      title={`${entity.title} → ${picked.title}`}
      rows={optionRows}
      onClose={onClose}
    />
  );
}

/** Mount once anywhere under CollabFacadeProvider (the DndProvider does). */
export function InteractionMenusHost() {
  const open = useInteractionMenuStore((s) => s.open);
  const close = useInteractionMenuStore((s) => s.close);
  if (!open) return null;
  return open.kind === 'move'
    ? <MoveToMenu entity={open.entity} onClose={close} />
    : <LinkMenu entity={open.entity} onClose={close} />;
}

/** Grammar-equivalent option list for a picked pair (palette rows, tests). */
export function keyboardOptionsFor(
  source: EntitySummary, target: EntitySummary,
): Array<{ option: PlacementOption; surface: NonNullable<ReturnType<typeof surfaceForEntity>> | 'parent-zone' }> {
  const out: Array<{ option: PlacementOption; surface: NonNullable<ReturnType<typeof surfaceForEntity>> | 'parent-zone' }> = [];
  const src = sourceRef(source);
  const surface = surfaceForEntity(target);
  if (surface) {
    for (const option of resolveDrop(src, targetRef(target, surface))) out.push({ option, surface });
  }
  if (target.kind === source.kind) {
    for (const option of resolveDrop(src, targetRef(target, 'parent-zone'))) out.push({ option, surface: 'parent-zone' });
  }
  return out;
}
