/**
 * ENTITY HELP — the content-module contract every kind's page is written to.
 *
 * WHAT A PAGE IS. One kind, three tabs, in this order and no other (user
 * form 01a0e7d3, final):
 *
 *   Story          what the entity is, why it exists, how it lives and ends
 *   Toolkit        a hand-written narrative around commands read LIVE from
 *                  the `tm8 help` catalog — never a hand-copied syntax line
 *   Constellation  which other kinds it relates to, through which edges
 *
 * A KIND WITH NO MODULE STILL HAS A PAGE. `baseline.ts` derives all three
 * tabs from data that already exists — the registry's `KindConfig`, the
 * vendored edge-type registry (`domain/edge-kinds`), and the help catalog —
 * so nothing is ever blank or "coming soon". An authored module REPLACES a
 * tab wholesale (author `story` and the baseline story is gone; leave
 * `toolkit` out and the baseline toolkit stays), and every authored Toolkit
 * still ends with the live command ledger, because that is the drift guard.
 *
 * TONE, in one line: a narrator who has used the thing, not a manual that
 * lists it. Second person is fine; the present tense is the default; every
 * claim must be true of the shipped product, not the planned one.
 */
import type { ReactNode } from 'react';

export type HelpTab = 'story' | 'toolkit' | 'constellation';

export interface HelpTabSpec {
  readonly id: HelpTab;
  /** `01`, `02`, `03` — the reel number the tab strip prints. */
  readonly reel: string;
  readonly label: string;
}

export const HELP_TABS: readonly HelpTabSpec[] = [
  { id: 'story', reel: '01', label: 'Story' },
  { id: 'toolkit', reel: '02', label: 'Toolkit' },
  { id: 'constellation', reel: '03', label: 'Constellation' },
];

export function isHelpTab(raw: string | null | undefined): raw is HelpTab {
  return HELP_TABS.some((tab) => tab.id === raw);
}

/* ── Story ─────────────────────────────────────────────────────────────── */

/** One titled passage of the story; drawn as a revealed block. */
export interface StoryBeat {
  /** Mono, uppercase, above the title: `WHY IT EXISTS`. Optional. */
  readonly eyebrow?: string;
  readonly title: string;
  readonly body: ReactNode;
}

/** One frame of the lifecycle filmstrip. */
export interface LifecycleStage {
  readonly name: string;
  /** One sentence: what is true of the entity while it is here. */
  readonly note: string;
}

export interface StoryContent {
  /** The hook, one sentence, set in italic serif under the title. */
  readonly logline: string;
  /** The opening passage: what the entity IS, in the reader's terms. */
  readonly opening: ReactNode;
  readonly beats: readonly StoryBeat[];
  /** The lifecycle filmstrip. Omit for a kind that has no lifecycle. */
  readonly lifecycle?: readonly LifecycleStage[];
}

/* ── Toolkit ───────────────────────────────────────────────────────────── */

/**
 * One scene of the toolkit: a paragraph of intent, the commands it names —
 * BY PATH ONLY (`'task tick'`), resolved against the live catalog at render
 * time — and, optionally, the lines the typed terminal plays. When `demo` is
 * omitted the terminal plays the catalog's own examples for those commands.
 */
export interface ToolkitScene {
  readonly title: string;
  readonly narrative: ReactNode;
  /** Command paths as a caller types them after `tm8`. */
  readonly commands: readonly string[];
  /** Typed-terminal lines. Each is one `tm8 …` invocation or a `# comment`. */
  readonly demo?: readonly string[];
}

export interface ToolkitContent {
  readonly intro: ReactNode;
  readonly scenes: readonly ToolkitScene[];
  /**
   * Extra catalog nouns / paths beyond the registry's vocabulary
   * (`domain/kind-nouns`) — additive; the registry's list is never narrowed.
   */
  readonly nouns?: readonly string[];
  readonly commands?: readonly string[];
}

/* ── Constellation ─────────────────────────────────────────────────────── */

export interface ConstellationContent {
  readonly intro: ReactNode;
  /**
   * A sentence per relation the author wants to gloss, keyed by edge type
   * (`depends_on`) or by type and direction (`assigned_to:outgoing`).
   */
  readonly notes?: Readonly<Record<string, string>>;
  /** Neighbour kinds to seat closest to the centre, in order. */
  readonly spotlight?: readonly string[];
}

/* ── The module ────────────────────────────────────────────────────────── */

/**
 * One file per kind under `entity-help/kinds/`, registered in
 * `kinds/index.ts`. Every field but `kind` is optional: an absent tab is the
 * baseline's.
 */
export interface KindHelpModule {
  readonly kind: string;
  readonly story?: StoryContent;
  readonly toolkit?: ToolkitContent;
  readonly constellation?: ConstellationContent;
}
