/**
 * SPECIMEN DATA — for the review board only, never for product.
 *
 * WHY IT IS HERE AND NOT IN `src/fixtures/`. Two reasons, and the second is
 * the load-bearing one:
 *   1. File ownership: this lane creates files under `src/files/` and nowhere
 *      else. `src/auth/specimen.ts` and `src/settings-space/specimen.ts` set
 *      the precedent for a lane-local board dataset.
 *   2. `src/fixtures/` is the SHARED dataset the gate screen and the seam run
 *      on. Rich specimen states that exist only to exercise a canvas frame do
 *      not belong in the data every other suite reasons about.
 *
 * WHAT THESE VALUES ARE. The names, sizes and copy are TRANSCRIBED FROM THE
 * ORACLE (`T3 Files, Node & Inbox Hi-Fi.dc.html` L39–L116), so a reviewer can
 * put the board beside the canvas and compare like with like. They are not
 * measurements of anything real, and no product path reads them — a fact the
 * suite asserts by checking that `FilesScreen`'s and `NodeRoom`'s own
 * defaults are empty.
 */
import type { FileRow, UploadItem } from './model';
import type { MessageBubble } from './FilesScreen';
import type { ProviderRow } from './NodeRoom';
import type { NodeFacts } from './port';

const ADA = { displayName: 'ada', isAgent: false };
const FORGE = { displayName: 'forge', isAgent: true };

/** L42–L64: the three queue phases, in the oracle's own order. */
export const SPECIMEN_QUEUE: readonly UploadItem[] = [
  { phase: 'uploading', name: 'rail-collapsed-states.png', mime: 'image/png', percent: 64 },
  { phase: 'uploaded', name: 'layout-spec-v3.pdf', mime: 'application/pdf', sizeBytes: 1_258_291 },
  {
    phase: 'failed',
    name: 'session-recording.mov',
    mime: 'video/quicktime',
    sizeBytes: 42_991_616,
    why: '41 MB — over the 25 MB cap',
  },
];

/** L76–L77: the chips on the bubble. */
export const SPECIMEN_CHIP_FILES: readonly FileRow[] = [
  {
    fileEntityId: 'spec-file-pdf',
    name: 'layout-spec-v3.pdf',
    mime: 'application/pdf',
    sizeBytes: 1_258_291,
    attributedTo: ADA,
    attributedAt: '2m',
    sourceMissing: false,
    edgeId: null,
  },
  {
    fileEntityId: 'spec-file-png',
    name: 'rail-collapsed.png',
    mime: 'image/png',
    sizeBytes: 348_160,
    attributedTo: ADA,
    attributedAt: '2m',
    sourceMissing: false,
    edgeId: null,
  },
];

export const SPECIMEN_BUBBLE: MessageBubble = {
  authorName: 'ada',
  authorIsAgent: false,
  meta: 'to this session · 2m',
  body: 'Here’s the spec and the two reference shots — match the collapsed rail exactly.',
  files: SPECIMEN_CHIP_FILES,
};

/**
 * L84–L90: the FILES · 3 list, INCLUDING the missing-bytes row. That third
 * row is the only way to see the wait-amber treatment at all — nothing in the
 * contract reports per-file `sourceMissing` today (see `model.ts`), so the
 * state is reachable from specimen data and from nowhere else. Recorded in
 * HANDOVER §GAPS rather than left as a surprise.
 */
export const SPECIMEN_ATTACHED: readonly FileRow[] = [
  ...SPECIMEN_CHIP_FILES.slice().reverse(),
  {
    fileEntityId: 'spec-file-log',
    name: 'bench-run.log',
    mime: 'text/plain',
    sizeBytes: null,
    attributedTo: FORGE,
    attributedAt: '2m',
    sourceMissing: true,
    edgeId: null,
  },
  {
    fileEntityId: 'spec-file-mov',
    name: 'session-recording.mov',
    mime: 'video/quicktime',
    sizeBytes: 42_991_616,
    attributedTo: FORGE,
    attributedAt: '14m',
    sourceMissing: false,
    edgeId: null,
  },
];

/** L197–L212: the two providers, with the real exit-127 failure body. */
export const SPECIMEN_PROVIDERS: readonly ProviderRow[] = [
  {
    name: 'claude',
    command: 'claude-code --print --session-dir {workdir} --profile {profile}',
    lastTest: { ok: true, detail: 'ok · 41ms' },
  },
  {
    name: 'openai',
    command: 'codex exec --workdir {workdir} --quiet',
    lastTest: {
      ok: false,
      detail: 'exit 127 · stderr: “codex: command not found” — is it on the server’s PATH?',
    },
  },
];

/**
 * A node whose seam is LIVE with three sessions running — the board's
 * "everything measurable is measured" specimen. `slotCap` stays null even
 * here, because no specimen may assert a number the build cannot read.
 */
export const SPECIMEN_NODE_FACTS: NodeFacts = {
  connection: { phase: 'live' },
  liveSessionCount: 3,
  nodeBootId: 'boot-7f3c1a',
  checkedAt: '2026-07-29T06:12:00.000Z',
  slotCap: null,
};

/** The degraded twin — the oracle's amber frame, from a real seam state. */
export const SPECIMEN_NODE_FACTS_DEGRADED: NodeFacts = {
  connection: { phase: 'polling', disconnectedSince: '2026-07-29T06:12:00.000Z' },
  liveSessionCount: 3,
  nodeBootId: 'boot-7f3c1a',
  checkedAt: '2026-07-29T06:12:00.000Z',
  slotCap: null,
};

/** Nothing measured at all — the state a cold mount actually renders. */
export const SPECIMEN_NODE_FACTS_COLD: NodeFacts = {
  connection: { phase: 'connecting' },
  liveSessionCount: null,
  nodeBootId: null,
  checkedAt: null,
  slotCap: null,
};
