/**
 * Kind adapter registry (Spec B §6), one row per D7 kind, DERIVED from the
 * UI kind registry (`getKind`) and `creatableKind()` rather than a hand list
 * wherever one exists.
 */
import type { ComponentType } from 'react';
import type { EntityKind } from '@tm8/contract';
import { creatableKind } from '../../authoring';
import { getKind, type KindArt } from '../../domain';
import { WORKSPACE_KINDS, type KindId } from '../runtime/types';
import { draftBodyFor, type DraftHostProps } from './draft';

export interface KindAdapter {
  kind: KindId;
  /** "Task". */
  noun: string;
  /** "Tasks". */
  nounPlural: string;
  /** The kind's drawn mark (render with `KindIcon kind=…`). */
  icon: KindArt;
  /** `fullView` when the kind registers `panel.fullView` (D9). */
  body: 'fullView' | 'panel';
  creatable: true | { disabledReason: string };
  /** Kind-specific authoring body; absent ⇒ the generic draft host form. */
  draftBody?: ComponentType<DraftHostProps>;
  supportsChat: boolean;
  supportsRun: boolean;
}

/**
 * Kinds with no generic create that still have their own creation door,
 * hosted in a draft tab (Spec A §9): the launch sheet and the chat start.
 * `form` is NOT here: `forms.create` has no client door yet (the seam and
 * `FormsOps` only edit existing forms), so + New is disabled with the reason.
 */
const OWN_DOOR_KINDS: ReadonlySet<KindId> = new Set(['work_session', 'chat']);

function creatabilityOf(kind: KindId, nounPlural: string): KindAdapter['creatable'] {
  if (creatableKind(kind as EntityKind) || OWN_DOOR_KINDS.has(kind)) return true;
  return { disabledReason: `${nounPlural} can't be created here.` };
}

const cache = new Map<KindId, KindAdapter>();

export function getKindAdapter(kind: KindId): KindAdapter {
  const hit = cache.get(kind);
  if (hit) return hit;
  const config = getKind(kind);
  const adapter: KindAdapter = {
    kind,
    noun: config.label,
    nounPlural: config.labelPlural,
    icon: config.iconArt,
    body: config.panel.fullView ? 'fullView' : 'panel',
    creatable: creatabilityOf(kind, config.labelPlural),
    draftBody: draftBodyFor(kind),
    supportsChat: kind !== 'chat' && kind !== 'channel',
    supportsRun: config.launchable === true,
  };
  cache.set(kind, adapter);
  return adapter;
}

export function workspaceKindAdapters(): KindAdapter[] {
  return WORKSPACE_KINDS.map(getKindAdapter);
}

export function canCreateKind(kind: KindId): boolean {
  return getKindAdapter(kind).creatable === true;
}

/** "New task", "New task 2". */
export function draftTitle(kind: KindId, ordinal: number): string {
  const noun = getKindAdapter(kind).noun.toLowerCase();
  return ordinal > 1 ? `New ${noun} ${ordinal}` : `New ${noun}`;
}
