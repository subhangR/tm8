/**
 * The story's playground: the floating plus, ⌘K / Ctrl-K, the "Add anything"
 * sheet, and the popover for a node the user clicked (`pick`).
 *
 * Everything acts through `actions`: no `add` means no plus, no ⌘K and no
 * sheet; each popover verb draws only when its member exists. Mount it as the
 * LAST child of the story's scroll container: the dock is sticky to that
 * container's bottom, so the plus and the sheet stay inside the panel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Kbd } from '../../kit/Kbd';
import type { StoryBlockProps, StoryNodePick } from '../props';
import { AddSheet, type SheetDraft } from './AddSheet';
import { NodePopover } from './NodePopover';
import { useStoryHotkey } from './keys';
import './playground.css';

export interface StoryPlaygroundProps extends StoryBlockProps {
  pick: StoryNodePick | null;
  onClosePick: () => void;
  launchTarget?: { id: string; seq: number } | null;
}

const MOD_K = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

export function StoryPlayground({ view, actions, pick, onClosePick, runners, launchTarget }: StoryPlaygroundProps) {
  const host = useRef<HTMLDivElement>(null);
  /** The open sheet's draft; `seq` remounts it so a new opening starts fresh. */
  const [sheet, setSheet] = useState<{ draft: SheetDraft; seq: number } | null>(null);
  const add = actions.add;

  const openSheet = useCallback(
    (draft: SheetDraft = { intent: 'spawn' }) => {
      onClosePick();
      setSheet((s) => ({ draft, seq: (s?.seq ?? 0) + 1 }));
    },
    [onClosePick],
  );
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeSheet = useCallback(() => {
    setSheet(null);
    returnFocus.current?.focus();
  }, []);
  useEffect(() => {
    if (!launchTarget) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    openSheet({ intent: 'spawn', onId: launchTarget.id });
  }, [launchTarget, openSheet]);

  // ⌘K while the story is focused opens the sheet (or keeps it, focused).
  useStoryHotkey(host, !!add, () => {
    if (sheet) host.current?.querySelector<HTMLTextAreaElement>('.sp-sheet textarea')?.focus();
    else openSheet();
  });

  return (
    <div ref={host} className="sp-dock">
      {add && !sheet && (
        <button type="button" className="sp-fab" aria-label="Add anything" title={`Add anything · ${MOD_K}`} onClick={() => openSheet()}>
          <span className="sp-fab__k" aria-hidden="true">
            add anything · <Kbd bare>{MOD_K}</Kbd>
          </span>
          +
        </button>
      )}
      {add && sheet && <AddSheet key={sheet.seq} view={view} add={add} draft={sheet.draft} onClose={closeSheet} runners={runners ?? null} />}
      {pick && (
        <NodePopover
          key={pick.entityId}
          view={view}
          actions={actions}
          pick={pick}
          onClose={onClosePick}
          onHandOver={add ? openSheet : null}
        />
      )}
    </div>
  );
}
