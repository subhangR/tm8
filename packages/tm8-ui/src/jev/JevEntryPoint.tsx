import { useEffect, useId, useRef, useState } from 'react';
import { LAUNCH_SUGGEST_GROUPS } from '@tm8/contract';

import { openJevKeySettings } from './credentials-link';
import { formatUsd } from './format';
import { JevPanel, type JevPanelSource } from './JevPanel';
import { JEV_ADD_KEY_COPY, JEV_ENTITY_GROUPS, JEV_UNAVAILABLE_COPY } from './useJevSuggestions';

/** How many rows Jev pre-ticked or picked, across every group that answered. */
export function suggestedCount(jev: JevPanelSource): number {
  let n = 0;
  if (jev.groups.model.status === 'ok') n += 1;
  const teammates = jev.groups.teammates;
  if (teammates.status === 'ok' && !teammates.value.noFit && teammates.value.items.some((item) => item.suggested)) n += 1;
  for (const group of JEV_ENTITY_GROUPS) n += jev.entity[group].rows.filter((row) => row.suggested).length;
  return n;
}

/** How many changes Apply has made to this launch: one per model or teammate, one per id added or default removed. */
export function appliedCount(jev: JevPanelSource): number {
  let n = (jev.applied.model ? 1 : 0) + (jev.applied.teammate ? 1 : 0);
  for (const group of JEV_ENTITY_GROUPS) {
    const entry = jev.applied[group];
    if (entry) n += entry.added.length + entry.removed.length;
  }
  return n;
}

function failedCount(jev: JevPanelSource): number {
  return LAUNCH_SUGGEST_GROUPS.filter((group) => {
    const state = jev.groups[group];
    return state.status === 'failed' && state.reason !== 'no_key';
  }).length;
}

/** The button's tooltip: the badge counts CHANGES, not rows, and says what one is. */
export const ENTRY_TITLE =
  'Jev’s recommendations for this launch. A change is the model, the teammate, and each memory, skill or reference added or default removed. Nothing changes until you apply it.';

/** The button's words for the run's state: `✦ 12 suggested · 3 changes applied`. */
export function entryBadge(jev: JevPanelSource): string {
  if (jev.state === 'idle') return '✦ Ask Jev';
  if (jev.state === 'asking') return '✦ Asking Jev…';
  if (jev.state === 'unavailable') return '✦ Jev unavailable';
  const failed = failedCount(jev);
  const touched = LAUNCH_SUGGEST_GROUPS.filter((group) => jev.groups[group].status !== 'idle').length;
  if (failed > 0 && failed === touched) return '✦ Jev failed';
  const changes = appliedCount(jev);
  const parts = [`✦ ${String(suggestedCount(jev))} suggested`, `${String(changes)} ${changes === 1 ? 'change' : 'changes'} applied`];
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (jev.state === 'stale') parts.push('stale');
  return parts.join(' · ');
}

/**
 * THE ONE JEV ENTRY POINT on a launch config (Subhang's I9b note): a small ✦
 * button, collapsed by default, whose badge says how much Jev suggested and how
 * much of it is applied, plus what asking cost. The first press asks Jev and
 * opens the panel; after that the button only opens and closes it.
 *
 * A disclosure, not a dialog: the panel opens IN PLACE below the button, so the
 * launch config stays reachable. Opening moves focus to the panel's heading;
 * Escape or Close puts it back on the button.
 */
export function JevEntryPoint({ jev, modelLabel, open: controlledOpen, onOpenChange, defaultOpen = false }: {
  /** `useJevSuggestions(...)` with the surface's `host`: every Apply goes through it, so the ledger knows. */
  jev: JevPanelSource;
  /** The catalog's words for Jev's model (`modelLabel(suggestion, catalog)`). */
  modelLabel: string;
  /** Controlled open state; omit to let the entry point own it. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  defaultOpen?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = controlledOpen ?? ownOpen;
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /* Focus moves only on a person's open, never on the first render of an
     already-open panel — a surface mounting must not steal focus. */
  const focusOnOpen = useRef(false);

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (open && focusOnOpen.current) {
      focusOnOpen.current = false;
      headingRef.current?.focus();
    }
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const refused = jev.askRefusal !== null;
  const asking = jev.state === 'asking';
  const cost = jev.run && jev.run.calls > 0 ? formatUsd(jev.run.usd) : null;

  return (
    <div className="jev-entry" data-testid="jev-entry" data-state={jev.state}>
      <div className="jev-entry__bar">
        <button
          ref={buttonRef}
          type="button"
          className="jev-entry__button"
          data-testid="jev-entry-button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-disabled={refused ? true : undefined}
          aria-busy={asking || undefined}
          title={jev.askRefusal ?? (jev.state === 'unavailable' ? JEV_UNAVAILABLE_COPY : ENTRY_TITLE)}
          onClick={(event) => {
            event.stopPropagation();
            if (refused) return;
            if (jev.state === 'idle') jev.ask();
            focusOnOpen.current = !open;
            setOpen(!open);
          }}
        >
          <span className="jev-entry__badge" data-testid="jev-entry-badge">{entryBadge(jev)}</span>
          {asking ? <span className="jev-spin" aria-hidden="true" /> : null}
          {cost ? <span className="jev-cost" data-testid="jev-entry-cost">{cost}</span> : null}
          <span className="jev-entry__chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
        {jev.state === 'unavailable' ? (
          <button
            type="button"
            className="jev-link"
            data-testid="jev-add-key"
            onClick={(event) => { event.stopPropagation(); openJevKeySettings(); }}
          >
            {JEV_ADD_KEY_COPY}
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <JevPanel
            ref={headingRef}
            id={panelId}
            jev={jev}
            modelLabel={modelLabel}
            onClose={close}
          />
        </div>
      ) : null}
    </div>
  );
}
