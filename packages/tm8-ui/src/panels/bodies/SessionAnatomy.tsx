import type { EntityDetail, HandoffView } from '@tm8/contract';
import { Chip, Eyebrow } from '../../kit';
import {
  DisabledAction,
  DisabledIconControl,
  NOT_WIRED_REASON,
} from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';
import { deliveryFacet, recordFacet } from '../share/facets';
import './session-anatomy.css';

/**
 * SESSION ANATOMY — the terminal archetype's facts, BESIDE the canvas.
 *
 * WHAT THIS IS. An ORDERED LIST OF BLOCKS, exactly like `GenericBody`: the
 * registry says which blocks in what order, this file knows only how to draw
 * each block TYPE, and every block reads the detail STRUCTURALLY ("does this
 * content carry a `transcriptDoc`?") rather than asking what kind the entity
 * is. So this is an ARCHETYPE body, not a session body — any registry row that
 * declares these blocks gets them, and `no-branching.test.ts` can keep failing
 * the build on a kind literal because there is none here to find.
 *
 * WHAT THIS IS *NOT*. It is not the canvas and it does not restack the panel.
 * D63/D64 (user-ruled, 2026-07-29) put the terminal directly under the tabs
 * with the chrome strip and context line BELOW it; `TerminalBody.tsx` owns
 * that stack and is frozen. Nothing here proposes an inversion of it.
 *
 * THE ORACLE REGIONS, cited per block below: T0-4 `#fullviews` → the Z4
 * TERMINAL frame's provenance strip (lines 1224–1234 of
 * `T0-4 Entity Detail Panels Hi-Fi.dc.html`), and T0-2 `#exited` → the exited
 * canvas interior (lines 225–231 of `T0-2 T0-5 Terminal & Live Session
 * Hi-Fi.dc.html`). Geometry literals are transcribed from those inline styles
 * into `session-anatomy.css` with the line cited; every colour resolves
 * through a token, and this screen needed NO new one — the oracle's dark
 * values (#665E4C, #BDB5A2, #3B3524, #1B1810, #2C2719) are exactly the dark
 * ramp tokens.css already declares.
 *
 * WHY THESE THREE BLOCKS AND NOT MORE. The T0-4 oracle labels its shared tabs
 * "DISCUSSION · CONNECTIONS · ACTIVITY — DESIGNED ONCE, SHARED BY EVERY KIND"
 * and draws them on a TASK. There is no session-specific tab body in the
 * oracle to build; inventing one would manufacture the very divergence the
 * oracle refuses. What the oracle DOES draw for a session and the build never
 * had is the provenance strip, the exit facts, and a transcript affordance
 * driven by the record.
 */

/** The block vocabulary this archetype answers to. Registry DATA names them. */
export type SessionBlockKind = 'provenance-strip' | 'exit-summary' | 'transcript';

export interface SessionBlockRef {
  block: SessionBlockKind;
  /** Section eyebrow above the block, as `ContentBlockRef.label` is for generic. */
  label?: string;
}

export interface SessionAnatomyProps {
  detail: EntityDetail;
  /** Registry-carried, ordered. Empty ⇒ this body costs the canvas nothing. */
  blocks: readonly SessionBlockRef[];
  /** From the seam's `handoffs()` read — the same prop `TerminalBody` takes. */
  handoffs?: readonly HandoffView[];
  onOpenEntity?: (id: string) => void;
}

export function SessionAnatomy({ detail, blocks, handoffs = [], onOpenEntity }: SessionAnatomyProps) {
  // No blocks is not an error and not an empty state: the canvas is the
  // primary surface, and an anatomy with nothing declared renders nothing at
  // all rather than a box explaining its own absence (R5 #10 generalised).
  if (blocks.length === 0) return null;
  return (
    <div className="pn-anatomy" data-testid="session-anatomy">
      {blocks.map((block, i) => (
        <AnatomyBlock
          key={`${block.block}:${i}`}
          detail={detail}
          block={block}
          handoffs={handoffs}
          onOpenEntity={onOpenEntity}
        />
      ))}
    </div>
  );
}

function AnatomyBlock({
  detail,
  block,
  handoffs,
  onOpenEntity,
}: {
  detail: EntityDetail;
  block: SessionBlockRef;
  handoffs: readonly HandoffView[];
  onOpenEntity?: (id: string) => void;
}) {
  const body = (() => {
    switch (block.block) {
      case 'provenance-strip':
        return <ProvenanceStrip detail={detail} handoffs={handoffs} onOpenEntity={onOpenEntity} />;
      case 'exit-summary':
        return <ExitSummary detail={detail} />;
      case 'transcript':
        return <TranscriptAction detail={detail} onOpenEntity={onOpenEntity} />;
      default:
        return null;
    }
  })();
  if (!body) return null;
  return (
    <section className="pn-section" data-testid={`block-${block.block}`}>
      {block.label ? <Eyebrow faint>{block.label}</Eyebrow> : null}
      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------
// provenance-strip — T0-4:1224–1234 (Z4 TERMINAL, the strip under the title)
// ---------------------------------------------------------------------------

/**
 * TWO COLUMNS, SIDE BY SIDE: where this session may act, and what has been
 * shared into it. The oracle's own annotation names the distinction it is
 * drawing — "provenance strip (immutable 'launched from' vs editable
 * associations; delivery ≠ recorded)" (T0-4:1268).
 *
 * WHY A COMPACT SECOND RENDERING OF SHARES. `SharedContextSection` is the
 * T0-2 §6 FULL form — one row per share with notes, audit lines and the
 * withdraw control. The oracle's strip is a different, deliberate rendering:
 * one line per share, both facet pills, no controls. The WORDS and TONES come
 * from `share/facets.ts` in both, so there is still exactly one home for what
 * a facet says; only the geometry differs.
 */
function ProvenanceStrip({
  detail,
  handoffs,
  onOpenEntity,
}: {
  detail: EntityDetail;
  handoffs: readonly HandoffView[];
  onOpenEntity?: (id: string) => void;
}) {
  // Structural read, never a kind comparison (§15.2): ask what the content HAS.
  const content = detail.content as unknown as Record<string, unknown>;
  const launchProjectId = typeof content.launchProjectId === 'string' ? content.launchProjectId : null;

  return (
    <div className="pn-anatomy__strip" data-testid="anatomy-provenance-strip">
      <div className="pn-anatomy__col">
        <Eyebrow faint>ASSOCIATED PROJECTS</Eyebrow>
        <div className="pn-chiprow">
          {launchProjectId ? (
            <>
              <Chip glyph="⬒" onClick={() => onOpenEntity?.(launchProjectId)}>
                {launchProjectId}
              </Chip>
              {/* The oracle's caption, verbatim (T0-4:1226). The launch root is
                  the record of where an agent was ALLOWED to act; rewriting it
                  would falsify that record, so it is styled as a fact and never
                  as something editable. */}
              <span className="pn-provenance">launched from · immutable</span>
            </>
          ) : (
            <span className="pn-section__empty">no project recorded for this session</span>
          )}
        </div>
      </div>

      <div className="pn-anatomy__col pn-anatomy__col--share">
        <Eyebrow faint>{`SHARED CONTEXT · ${handoffs.length}`}</Eyebrow>
        {handoffs.length === 0 ? (
          <span className="pn-section__empty">nothing shared into this session yet</span>
        ) : (
          <div className="pn-anatomy__shares">
            {handoffs.map((h) => (
              <ShareRow key={h.handoffId} handoff={h} onOpenSource={onOpenEntity} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ShareRow({
  handoff,
  onOpenSource,
}: {
  handoff: HandoffView;
  onOpenSource?: (entityId: string) => void;
}) {
  const delivery = deliveryFacet(handoff);
  const record = recordFacet(handoff);
  const { title } = handoff.sourceSnapshot;

  return (
    <div
      className={
        handoff.sourceMissing
          ? 'pn-anatomy__share-row pn-anatomy__share-row--missing'
          : 'pn-anatomy__share-row'
      }
      data-testid="anatomy-share-row"
      data-delivery={handoff.deliveryStatus}
      data-record={handoff.recordStatus}
    >
      {handoff.sourceMissing ? (
        /* No link: the entity is gone, and an affordance that cannot resolve
           lies about what it can do. The bare amber word is T4's own
           source-missing treatment (see share/facets.ts) — one WORD here, not
           the full section's sentence, so that copy keeps one home. */
        <>
          <span className="pn-anatomy__share-label" title={title}>
            {title}
          </span>
          <span className="pn-anatomy__missing">source missing</span>
        </>
      ) : (
        <button
          type="button"
          className="pn-anatomy__share-label pn-anatomy__share-label--link"
          onClick={() => onOpenSource?.(handoff.sourceEntityId)}
          title={title}
        >
          {title}
        </button>
      )}

      <span className="pn-anatomy__spacer" />

      {/* TWO pills. Always both. Never merged (L7) — `delivered × failed` and
          `unknown × recorded` are different worlds, and one badge erases the
          only distinction that tells a user whether to share again. */}
      <span className={`pn-facet kit-pill--${delivery.tone}`} title={delivery.detail}>
        {delivery.label}
      </span>
      <span className={`pn-facet kit-pill--${record.tone}`} title={record.detail}>
        {record.label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// exit-summary — T0-2:228 ("exit code 0 · ran 41m · ended 12m ago")
// ---------------------------------------------------------------------------

/**
 * THE FACTS THE EXITED STATE NEVER HAD. `ExitedFallback` accepts a `meta`
 * string and its only caller passes none, so the built exit state has been
 * shipping with the oracle's fact line missing entirely.
 *
 * THE EXIT CODE IS HOLLOW, AND THAT IS THE POINT. The contract's work_session
 * state carries `status`, `agentTool`, `model`, `shareMode`, `startedAt` and
 * `exitedAt` — and no exit code, on any node (packages/contract
 * `src/schemas.ts`, the work_session state arm). The oracle's literal `0` is
 * therefore unrenderable honestly: printing it would claim a measurement
 * nobody took, which is exactly the lie T1-4's dash forbids. It renders as a
 * dash carrying its reason. If an exit code ever reaches the contract, this
 * block gains a value and loses a caption; nothing else here moves.
 *
 * NOT CHECKED, stated rather than assumed: whether the SERVER has an exit code
 * it simply does not project. I read the contract schema, not the server.
 *
 * NO CLOCK IN THE RENDER PATH. The oracle says "ended 12m ago"; a relative
 * word needs `Date.now()`, which makes every render time-dependent and every
 * test a moving target — the same reason `detail/tabs.tsx` renders a plain
 * date. The DURATION is not a clock read: it is the difference between two
 * recorded timestamps, so it is exact, stable, and computed here.
 */
function ExitSummary({ detail }: { detail: EntityDetail }) {
  // Structural read (§15.2): the timestamps, not the kind.
  const state = detail.state as unknown as Record<string, unknown>;
  const startedAt = typeof state.startedAt === 'string' ? state.startedAt : null;
  const exitedAt = typeof state.exitedAt === 'string' ? state.exitedAt : null;
  const ran = duration(startedAt, exitedAt);

  return (
    <p className="pn-anatomy__facts" data-testid="anatomy-exit-facts">
      {exitedAt ? (
        <>
          <HollowInline caption={NO_EXIT_CODE}>exit code —</HollowInline>
          <Sep />
          <span>{ran ? `ran ${ran}` : 'duration not recorded'}</span>
          <Sep />
          <span title={exitedAt}>{`ended ${day(exitedAt)}`}</span>
        </>
      ) : (
        /* No recorded end. Naming an exit code here would imply an ending the
           record does not claim — the stale case is precisely a record that
           says running with nothing to show for it. */
        <>
          <span title={startedAt ?? undefined}>
            {startedAt ? `started ${day(startedAt)}` : 'no start recorded'}
          </span>
          <Sep />
          <span>duration not recorded</span>
          <Sep />
          <span>no end recorded</span>
        </>
      )}
    </p>
  );
}

const NO_EXIT_CODE =
  'No exit code is recorded — the session record carries its status, start and end and nothing about how the process ended. A zero here would claim a measurement nobody took.';

function Sep() {
  return (
    <span className="pn-anatomy__sep" aria-hidden>
      ·
    </span>
  );
}

/**
 * "41m", "2h 14m", "6d 9h" — the oracle's own grain. Null when either end is
 * missing, so the caller states the absence rather than printing a zero.
 */
function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Deliberately coarse, same reason as `detail/tabs.tsx`: no clock in render. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// transcript — T0-2:228 ("View transcript ↗"), driven by the RECORD
// ---------------------------------------------------------------------------

/**
 * THE AFFORDANCE ANSWERS TO THE RECORD, in three states, and one of them is a
 * live defect this block exists in order not to repeat:
 *
 *   · a transcript IS recorded and the open handler is wired → a real button;
 *   · a transcript is recorded and NOTHING is wired → disabled-with-reason
 *     (R5 #9). At HEAD, `EntityDetailPanel` renders `TerminalBody` without
 *     `onOpenTranscript`, so the fallback's "View transcript ↗" is an enabled
 *     button that silently does nothing — the five-dead-verbs class, still
 *     live in the exited session panel. The check here is STRUCTURAL, so it
 *     cannot drift away from what is actually wired;
 *   · no transcript in the record → disabled-with-reason stating THAT fact.
 *     `content.transcriptDoc` is null on every session in the fixture set and
 *     is read by nothing else in the package today.
 */
function TranscriptAction({
  detail,
  onOpenEntity,
}: {
  detail: EntityDetail;
  onOpenEntity?: (id: string) => void;
}) {
  const content = detail.content as unknown as Record<string, unknown>;
  const doc = summaryRef(content.transcriptDoc);

  if (!doc) {
    return (
      <DisabledAction
        label="View transcript"
        reason={{
          cause: 'This session has no transcript to open',
          remedy: 'the record carries no transcript document — nothing to navigate to',
        }}
      >
        View transcript ↗
      </DisabledAction>
    );
  }

  if (!onOpenEntity) {
    return (
      <DisabledIconControl label="View transcript" reason={NOT_WIRED_REASON}>
        View transcript ↗
      </DisabledIconControl>
    );
  }

  return (
    /* BRASS, per the oracle: the transcript is the one action a session with
       no canvas offers, and T0-2:228 draws it in the brand fill
       (`color:#9A581F;background:rgba(178,106,43,.11)`) — which is exactly
       what `.pn-btn--primary` already resolves to. */
    <button type="button" className="pn-btn pn-btn--primary" onClick={() => onOpenEntity(doc.id)}>
      View transcript ↗
    </button>
  );
}

/**
 * The two members a navigable reference needs. Narrower than `EntitySummary`
 * on purpose: the only question this affordance has is whether the thing can
 * be OPENED, and `id` plus a name is the whole of it.
 */
function summaryRef(value: unknown): { id: string; title: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== 'string' || rec.id.length === 0) return null;
  return { id: rec.id, title: typeof rec.title === 'string' ? rec.title : rec.id };
}
