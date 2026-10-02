/**
 * WHERE THE STYLE EDITOR LIVES. The picker sits inside the account menu, a
 * popover that closes on any outside press — and a portalled editor IS
 * outside it, so an editor owned by the picker would unmount the moment it
 * was clicked. The shell mounts this host once instead; the picker only calls
 * `openStyleEditor`, and closing the menu leaves the editor open.
 */
import { useSyncExternalStore } from 'react';
import type { ActorSummary, StyleWarning } from '@tm8/contract';

import { StyleEditor, type StyleEditorSeam, type StyleEditorTarget } from './StyleEditor';
import { notifyStyleCatalogChanged } from './style-sync';

interface Open {
  target: StyleEditorTarget;
  warnings?: StyleWarning[];
  /** Bumped per open so re-opening the same style remounts with fresh state. */
  key: number;
}

let open: Open | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Open the editor on a personal style (editable) or a space style (read-only). */
export function openStyleEditor(target: StyleEditorTarget, warnings?: StyleWarning[]): void {
  open = { target, key: ++seq, ...(warnings?.length ? { warnings } : {}) };
  emit();
}

export function closeStyleEditor(): void {
  open = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Open | null {
  return open;
}

export interface StyleEditorHostProps {
  seam: StyleEditorSeam | null;
  spaceId: string | null;
  members: readonly ActorSummary[];
}

export function StyleEditorHost({ seam, spaceId, members }: StyleEditorHostProps) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!current || !seam) return null;
  return (
    <StyleEditor
      key={current.key}
      seam={seam}
      target={current.target}
      spaceId={spaceId}
      members={members}
      {...(current.warnings ? { initialWarnings: current.warnings } : {})}
      onClose={closeStyleEditor}
      onChanged={notifyStyleCatalogChanged}
      onOpen={(target) => openStyleEditor(target)}
    />
  );
}
