import { useState } from 'react';
import type { EntityDetail, EntitySummary, ProjectResource } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type { ActionContext, ActionDef } from '../../domain';
import { allActions, getKind } from '../../domain';
import { Eyebrow, Pill } from '../../kit';
/*
 * MODULE-DEEP, not through `terminal/index.ts` — the ProfileBody precedent,
 * and for its reason: the barrel also exports `LiveTerminal`, which drags
 * xterm into the graph of whatever imports it. A project panel must not pay
 * that. These two modules are pure presentation logic with no DOM dependency.
 * Read-only, per the charter carve.
 */
import { presentSession, presentationStyle } from '../../terminal/session-presentation';
import { toSessionRow } from '../../terminal/session-row';
import { EmptyBody } from '../detail/PanelStates';
import { DisabledAction, NOT_WIRED_REASON, toReason } from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';
import './governed-body.css';

/**
 * THE GOVERNED ARCHETYPE BODY — T0-4 "Governed & fallback kinds", the PROJECT
 * card (oracle lines 671–712; the body region is 690–708).
 *
 * WHAT MAKES A KIND "GOVERNED", stated as the archetype's thesis: the entity
 * in the panel is a PROJECTION of a record that lives somewhere this space
 * does not own, and the panel's job is to state the governing facts — where it
 * points on disk, whether agents may execute in it, what is running there now,
 * and which destructive verbs are refused and why. The oracle's own note:
 * "trust is safety UI: consequence stated both ways; refusals carry their
 * reason inline" (line 711).
 *
 * ARCHETYPE, NOT KIND (§15.2 — `panels/no-branching.test.ts` fails the build
 * on a kind literal here). Nothing below names a kind. The anatomy is the
 * ordered block list the registry row carries, exactly as `GenericBody` and
 * `ProfileBody` work; this file only knows how to draw each block TYPE. A
 * second governed-shaped kind is a registry row, not an edit here.
 *
 * THE TWO-SOURCE LAW THIS BODY IS A CONSUMER OF (D6/D27/D39): a liveness
 * VERDICT outranks a stored record at every consumer, and the verdict arrives
 * ONLY through `livenessOf` — never derived from `activityAt`, never read off
 * `state.status`. The session rows hand the verdict and the record to
 * `presentSession`, the module that already owns that combination for the
 * terminal, rather than re-deciding it here. With no `livenessOf` in hand the
 * eyebrow says LIVENESS UNVERIFIED and never prints a live count, because
 * "0 LIVE" would claim a measurement nobody took (the SubtreeBody precedent,
 * and the gate-evidence defect in the other direction).
 *
 * THE DATA THAT IS NOT ON THE ENTITY, stated as a measurement rather than a
 * prediction: `EntityContent` for this kind carries `projectId`, `repoUrl?`
 * and `materializedVersion` (contract.ts:159–160) and NOTHING ELSE. The
 * execution root path and the trust level live on `ProjectResource`
 * (contract.ts:948–961), which the stamped facade seam has NO read for — I
 * checked `src/data/seam.ts` in full. So `resource` is a prop, typed as the
 * contract's own view, and its ABSENCE is rendered HOLLOW: an unread trust
 * level may not be painted as `untrusted`, which would be a refusal the node
 * never issued. See §GAPS in the handover.
 *
 * Colours are tokens only (§14; `src/hex-ban.test.ts` scans the sheet). Micro
 * type sizes are D5-verbatim — the single `zoom` lever on `.cv2-root` is what
 * scales this family, never a per-element bump.
 */

// ---------------------------------------------------------------------------
// The block vocabulary
// ---------------------------------------------------------------------------

/**
 * The block names this body renders. Exported so the registry seam is
 * assertable from a test rather than kept in two heads: a row that declares a
 * name absent from this list draws nothing, and that must be a red, not a
 * blank section.
 *
 * `notice` is deliberately the SAME name `GenericBody` uses — one block name,
 * one meaning, two renderers.
 */
export const GOVERNED_BLOCKS = [
  'path-row',
  'trust-card',
  'live-sessions',
  'unlink-footer',
  'notice',
] as const;

export type GovernedBlockName = (typeof GOVERNED_BLOCKS)[number];

/**
 * The registry's `ContentBlockRef` shape, widened at `block` to `string`.
 *
 * WHY WIDENED, as a constraint and not a preference: these block names are
 * additions to `domain/types.ts`'s closed `ContentBlockKind` union, and that
 * file belongs to the registry lane — not to me. A `readonly ContentBlockRef[]`
 * is assignable to `readonly GovernedBlockRef[]` today, so the panel can pass
 * `config.panel.blocks` straight through; once the union grows, nothing here
 * changes and the narrower type simply flows in. (The `ProfileBody` precedent.)
 */
export interface GovernedBlockRef {
  block: string;
  /** Section eyebrow above the block. */
  label?: string;
  /** Block parameters — the "new display need = a new block parameter" seam. */
  params?: Readonly<Record<string, string | number | boolean>>;
}

type Params = Readonly<Record<string, string | number | boolean>>;

export interface GovernedBodyProps {
  detail: EntityDetail;
  /** Ordered blocks from `registry(kind).panel.blocks` — registry DATA. */
  blocks: readonly GovernedBlockRef[];
  /**
   * The node-level record this entity is a projection of — the ONLY source of
   * the execution root path and the trust level (contract `ProjectResource`).
   * `undefined` means nobody read it: every field it would have supplied
   * renders HOLLOW with that reason, never as a default or a refusal.
   */
  resource?: ProjectResource | null;
  /**
   * THE verdict, per session id — `seam.liveness.statusOf`, threaded by the
   * shell. Absent means nobody asked, which reads as unverified and never as
   * running (D27). It is never computed here.
   */
  livenessOf?: (id: string) => SessionLiveness;
  /**
   * The action context the panel already builds for its chrome. Actions
   * resolve their availability through it, so a verb that becomes available
   * (its executor lands, or the server grants the capability) flips here with
   * no edit to this file.
   */
  actionContext?: ActionContext;
  /** Injected so relative times are deterministic under test. */
  now?: string;
  onOpenEntity?: (id: string) => void;
  /**
   * Copies the execution root. Optional: with no copier passed the body falls
   * back to the platform clipboard, and where neither exists the control is
   * DISABLED WITH REASON rather than a button that silently does nothing
   * (R5 #9 / L6).
   */
  onCopyPath?: (path: string) => void;
}

export function GovernedBody({
  detail,
  blocks,
  resource,
  livenessOf,
  actionContext,
  now,
  onOpenEntity,
  onCopyPath,
}: GovernedBodyProps) {
  if (blocks.length === 0) {
    return (
      /* The tabpanel identity rides on BOTH branches: a Content tab whose
         `aria-controls` resolves to nothing when the body happens to be empty
         is a small real defect, not a styling detail. */
      <div
        className="pn-body"
        data-testid="governed-body"
        id="tabpanel-content"
        role="tabpanel"
        aria-labelledby="tab-content"
      >
        <EmptyBody
          glyph={getKind(detail.kind).chip.glyph}
          sentence="This entity renders universal fields only — its registry row declares no blocks. Nothing is invented."
        />
      </div>
    );
  }

  const nowIso = now ?? new Date().toISOString();

  return (
    <div
      className="pn-body gb-body"
      data-testid="governed-body"
      id="tabpanel-content"
      role="tabpanel"
      aria-labelledby="tab-content"
    >
      {blocks.map((block, i) => (
        <GovernedBlock
          key={`${block.block}:${i}`}
          detail={detail}
          block={block}
          resource={resource}
          livenessOf={livenessOf}
          actionContext={actionContext}
          now={nowIso}
          onOpenEntity={onOpenEntity}
          onCopyPath={onCopyPath}
        />
      ))}
    </div>
  );
}

function GovernedBlock({
  detail,
  block,
  resource,
  livenessOf,
  actionContext,
  now,
  onOpenEntity,
  onCopyPath,
}: {
  detail: EntityDetail;
  block: GovernedBlockRef;
  resource?: ProjectResource | null;
  livenessOf?: (id: string) => SessionLiveness;
  actionContext?: ActionContext;
  now: string;
  onOpenEntity?: (id: string) => void;
  onCopyPath?: (path: string) => void;
}) {
  const params = block.params ?? {};
  switch (block.block) {
    case 'path-row':
      return <PathRowBlock detail={detail} params={params} resource={resource} onCopyPath={onCopyPath} />;
    case 'trust-card':
      return <TrustCardBlock params={params} resource={resource} actionContext={actionContext} />;
    case 'live-sessions':
      return (
        <LiveSessionsBlock
          detail={detail}
          params={params}
          label={block.label}
          livenessOf={livenessOf}
          now={now}
          onOpenEntity={onOpenEntity}
        />
      );
    case 'unlink-footer':
      return (
        <UnlinkFooterBlock
          detail={detail}
          params={params}
          livenessOf={livenessOf}
          actionContext={actionContext}
        />
      );
    case 'notice':
      return <NoticeBlock params={params} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// PATH ROW — the execution root, and the repo line under it (oracle 691–692)
// ---------------------------------------------------------------------------

/** The oracle's copy glyph (line 691) and its open-external glyph (line 692). */
const COPY_GLYPH = '⧉';
const REPO_GLYPH = '⑂';
const OPEN_GLYPH = '↗';

/**
 * THE PATH IS NOT ON THE ENTITY. `EntityContent` for a governed projection
 * carries an id, an optional repo URL and a materialized version — no working
 * directory. The path comes from the node record (`ProjectResource.workingDir`)
 * or from a registry-named content member, and when neither is present the row
 * says WHY rather than rendering an empty mono box that reads like a bug.
 */
function PathRowBlock({
  detail,
  params,
  resource,
  onCopyPath,
}: {
  detail: EntityDetail;
  params: Params;
  resource?: ProjectResource | null;
  onCopyPath?: (path: string) => void;
}) {
  const contentKey = typeof params.source === 'string' ? params.source : null;
  const fromContent = contentKey ? scalar(record(detail.content)[contentKey]) : null;
  const path = resource?.workingDir ?? fromContent;
  const repo = resource?.repoUrl ?? scalar(record(detail.content).repoUrl);

  return (
    <section className="gb-pathgroup" data-testid="governed-path">
      {path ? (
        <div className="gb-path">
          <span className="gb-path__value" title={path}>
            {path}
          </span>
          <CopyPathControl path={path} onCopyPath={onCopyPath} />
        </div>
      ) : (
        <div className="gb-path gb-path--hollow" data-testid="governed-path-hollow">
          <HollowInline caption="No node-record read has run for this entity — the execution root lives on the node's project record, which this build has no seam read for. An unread path is not an empty path.">
            — execution root
          </HollowInline>
        </div>
      )}
      {repo ? (
        <div className="gb-repo" data-testid="governed-repo">
          <span aria-hidden className="gb-repo__glyph">
            {REPO_GLYPH}
          </span>
          <span className="gb-repo__value">{repo}</span>
          {/* A real navigation, so a real control — and a real URL, so no
              wiring gap to disable for. The oracle draws the ↗ affordance at
              line 692. */}
          <a className="gb-repo__open" href={repo} target="_blank" rel="noreferrer" aria-label="Open repository">
            {OPEN_GLYPH}
          </a>
        </div>
      ) : null}
    </section>
  );
}

/**
 * COPY, or an honest refusal. The clipboard is not a seam capability — it is a
 * platform one — so this control is enabled exactly when a copier exists:
 * the injected `onCopyPath` first, then `navigator.clipboard`. Where neither
 * does (a non-secure context, an old engine, jsdom), the button renders
 * DISABLED WITH REASON instead of being a live control that silently does
 * nothing (R5 #9). The check is structural, so it cannot drift from what the
 * environment actually offers.
 */
function CopyPathControl({ path, onCopyPath }: { path: string; onCopyPath?: (path: string) => void }) {
  const [copied, setCopied] = useState(false);
  const clipboard =
    typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
      ? navigator.clipboard
      : null;
  const copier = onCopyPath ?? (clipboard ? (p: string) => void clipboard.writeText(p) : null);

  if (!copier) {
    return (
      <DisabledAction
        label="Copy path"
        reason={{
          cause: 'Copying isn’t available in this context',
          remedy: 'no clipboard was offered by the host and none was passed to this panel',
        }}
      >
        <span aria-hidden>{COPY_GLYPH}</span>
      </DisabledAction>
    );
  }

  return (
    <button
      type="button"
      className="gb-path__copy"
      aria-label="Copy path"
      data-testid="governed-copy-path"
      onClick={() => {
        copier(path);
        setCopied(true);
      }}
    >
      <span aria-hidden>{COPY_GLYPH}</span>
      {/* The confirmation is a fact about what happened, so it is announced
          rather than only shown. It does not time out: a state that clears
          itself on a timer is one more thing to disbelieve, and re-copying is
          idempotent anyway. */}
      <span className="gb-path__copied" aria-live="polite">
        {copied ? 'copied' : ''}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// TRUST CARD — the safety UI (oracle 693–696)
// ---------------------------------------------------------------------------

/**
 * The consequence sentences. The trusted one is the oracle's own bytes (line
 * 695). The untrusted one is AUTHORED BY ME — the oracle draws only the
 * trusted card, and its note demands the consequence "stated both ways" (line
 * 711), so the missing half is written in the same shape: what is true now,
 * then what changing it would and would not do. Both are overridable from
 * registry params, so a ruling elsewhere lands as data.
 */
const TRUSTED_NOTE =
  'Agents may run real terminal sessions in this root. Untrusting terminates nothing but blocks new runs.';
const UNTRUSTED_NOTE =
  'Agents cannot start terminal sessions in this root. Trusting it allows new runs; it starts nothing and revives nothing.';

/**
 * TRUST IS A THREE-STATE FACT, and that is the whole point of this block.
 * `trusted` and `untrusted` are answers; NO RECORD READ is not a third answer
 * dressed as `untrusted` — it is the absence of one, and it renders hollow.
 * Painting an unread trust level as a refusal would invent a governance
 * decision the node never made, which is the exact inversion of the honesty
 * this card exists to provide.
 */
function TrustCardBlock({
  params,
  resource,
  actionContext,
}: {
  params: Params;
  resource?: ProjectResource | null;
  actionContext?: ActionContext;
}) {
  const trust = resource?.trust ?? null;

  if (!trust) {
    return (
      <section className="gb-trust gb-trust--hollow" data-testid="governed-trust-hollow">
        <HollowInline caption="No node-record read has run for this entity — trust lives on the node's project record, which this build has no seam read for. An unread trust level is never shown as untrusted.">
          — trust
        </HollowInline>
        <p className="gb-trust__note">
          Trust decides whether agents may run terminal sessions in this root. This build cannot read
          it yet, so neither answer is claimed.
        </p>
      </section>
    );
  }

  /*
   * The tone is the functional ramp, and the WORD is always beside the colour
   * (kit Pill's own law): status is never colour alone. `trusted` is the run
   * tone the oracle draws at line 694; anything else is the idle tone, because
   * an untrusted root is a governed default and not an error.
   */
  const isTrusted = trust === 'trusted';
  const note = isTrusted
    ? (asText(params.trustedNote) ?? TRUSTED_NOTE)
    : (asText(params.untrustedNote) ?? UNTRUSTED_NOTE);

  return (
    <section
      className={isTrusted ? 'gb-trust gb-trust--on' : 'gb-trust gb-trust--off'}
      data-testid="governed-trust"
      data-trust={trust}
    >
      <div className="gb-trust__head">
        <Pill tone={isTrusted ? 'run' : 'idle'} dot="solid">
          {trust}
        </Pill>
        <div className="gb-trust__spacer" />
        <TrustVerb isTrusted={isTrusted} params={params} actionContext={actionContext} />
      </div>
      <p className="gb-trust__note">{note}</p>
    </section>
  );
}

/**
 * THE VERB, RESOLVED FROM THE REGISTRY — never named here.
 *
 * The block's `params.action` carries an action id; this looks it up in the
 * action registry and renders the definition's own label, glyph and
 * availability. So when the `untrust` executor lands and its definition stops
 * being deferred, the button becomes live with no edit to this file — which is
 * the property D39 calls for and the reason the ref is data.
 *
 * REVOKING and GRANTING are different verbs, and only one of them exists.
 * `ActionRef` has an `untrust` member and no `trust` member (domain/actions.ts),
 * so an UNTRUSTED root has no verb to render. That is stated in the refusal
 * copy rather than left blank — a missing verb the user cannot see is
 * indistinguishable from a screen that forgot to draw it.
 */
function TrustVerb({
  isTrusted,
  params,
  actionContext,
}: {
  isTrusted: boolean;
  params: Params;
  actionContext?: ActionContext;
}) {
  const grantRef = asText(params.grantAction);
  const revokeRef = asText(params.action);
  const ref = isTrusted ? revokeRef : grantRef;
  const def = ref ? findAction(ref) : null;

  if (!def) {
    return (
      <DisabledAction
        label={isTrusted ? 'Untrust' : 'Trust'}
        reason={{
          cause: isTrusted
            ? 'Revoking trust has no verb in this build'
            : 'Granting trust has no verb in this build',
          remedy: 'trust is a node-level grant — this space’s action registry carries no such action',
        }}
      >
        {isTrusted ? 'Untrust…' : 'Trust…'}
      </DisabledAction>
    );
  }

  return <ActionControl def={def} ctx={actionContext} />;
}

// ---------------------------------------------------------------------------
// LIVE SESSIONS IN THIS ROOT — the two-source region (oracle 697–703)
// ---------------------------------------------------------------------------

/** The oracle's eyebrow (line 698), minus the count this build must earn. */
const DEFAULT_SESSIONS_LABEL = 'LIVE SESSIONS IN THIS ROOT';

/**
 * WHERE THE ROWS COME FROM: the connections edge group the registry names
 * (`params.edgeType` / `params.direction`). The contract states the
 * association explicitly — a session's launch root is immutable provenance and
 * "associations are `in_project` edges" (contract.ts:157) — so this reads the
 * EDGE rather than a content member that would have to be kept in sync with
 * it. The D46 precedent: the session→teammate link was ruled an edge for the
 * same reason.
 *
 * WHERE THE WORD COMES FROM: `livenessOf` — the verdict — combined with the
 * row's RECORDED status by `presentSession`. The verdict settles "is there a
 * PTY"; the record only says which kind of "no" this is. No verdict at all
 * lands on unverified, never on running.
 */
function LiveSessionsBlock({
  detail,
  params,
  label,
  livenessOf,
  now,
  onOpenEntity,
}: {
  detail: EntityDetail;
  params: Params;
  label?: string;
  livenessOf?: (id: string) => SessionLiveness;
  now: string;
  onOpenEntity?: (id: string) => void;
}) {
  const type = asText(params.edgeType) ?? 'in_project';
  const direction = params.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const groups = direction === 'outgoing' ? detail.connections.outgoing : detail.connections.incoming;
  const sessions = groups
    .filter((group) => group.type === type)
    .flatMap((group) => group.edges)
    .map((edge) => (edge.source.id === detail.id ? edge.target : edge.source));

  const verdicts = sessions.map((s) => livenessOf?.(s.id));
  const measured = verdicts.filter((v) => v != null).length;
  const live = verdicts.filter((v) => v === 'live').length;
  const head = label ?? DEFAULT_SESSIONS_LABEL;

  /*
   * "· 2" is only sayable when somebody actually looked. The oracle's eyebrow
   * counts LIVE sessions (line 698, over two rows both reading "running"), so
   * with no verdicts in hand the count would be a measurement nobody took —
   * the eyebrow says how many sessions are RECORDED here and states plainly
   * that their liveness is unverified. The SubtreeBody precedent, and the
   * gate-evidence defect inverted.
   */
  const eyebrow =
    sessions.length === 0
      ? `${head} · 0`
      : measured === 0
        ? `${head} · ${sessions.length} RECORDED · LIVENESS UNVERIFIED`
        : `${head} · ${live}`;

  return (
    <section className="gb-sessions" data-testid="governed-sessions">
      <Eyebrow faint>{eyebrow}</Eyebrow>
      {sessions.length === 0 ? (
        <p className="pn-section__empty">No sessions are recorded against this root.</p>
      ) : (
        <div className="gb-sessions__rows">
          {sessions.map((session, i) => (
            <SessionRow
              key={session.id}
              session={session}
              verdict={verdicts[i]}
              now={now}
              onOpenEntity={onOpenEntity}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionRow({
  session,
  verdict,
  now,
  onOpenEntity,
}: {
  session: EntitySummary;
  verdict: SessionLiveness | undefined;
  now: string;
  onOpenEntity?: (id: string) => void;
}) {
  const row = toSessionRow(session);
  const style = presentationStyle(
    presentSession({ liveness: verdict ?? 'unknown', recordedStatus: row.recordedStatus }),
  );

  const content = (
    <>
      {/* Dot geometry comes from the presentation module, not from a local
          reading of the verdict: it already owns "solid vs hollow" and "does
          this pulse" for every verdict/record pair, and the oracle animates
          only its first dot (line 700). A recorded status alone can never
          light it — `presentSession` refuses that combination at the source. */}
      <span
        className={style.pulse ? 'gb-dot gb-dot--pulse' : 'gb-dot'}
        data-tone={style.tone}
        data-dot={style.dot}
        aria-hidden
      />
      <span aria-hidden className="gb-sessions__glyph">
        {getKind(session.kind).chip.glyph}
      </span>
      <span className="gb-sessions__name">{row.name}</span>
      <span aria-hidden className="gb-sessions__sep">
        —
      </span>
      <span className="gb-sessions__word" data-tone={style.tone} title={style.full}>
        {style.word}
      </span>
      <span aria-hidden className="gb-sessions__sep">
        ·
      </span>
      <span className="gb-sessions__ago">{elapsed(session.activityAt, now)}</span>
    </>
  );

  /*
   * The oracle gives these rows `cursor:pointer` (line 700) — opening a
   * session is a real navigation. With no opener wired that would be an
   * enabled-inert control, so the row states the gap instead (R5 #9). The
   * check is structural and disappears the moment the host wires an opener.
   */
  if (!onOpenEntity) {
    return (
      <div className="gb-sessions__row gb-sessions__row--static" data-testid="governed-session-row">
        {content}
        <span className="gb-sessions__nowire" title={`${NOT_WIRED_REASON.cause} — ${NOT_WIRED_REASON.remedy}`}>
          not openable here
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="gb-sessions__row"
      data-testid="governed-session-row"
      onClick={() => onOpenEntity(session.id)}
    >
      {content}
    </button>
  );
}

// ---------------------------------------------------------------------------
// UNLINK FOOTER — the refusal that carries its reason (oracle 704–707)
// ---------------------------------------------------------------------------

/**
 * THREE REASONS A DESTRUCTIVE VERB CAN BE UNAVAILABLE, and they are ranked
 * because collapsing them would tell the user the wrong thing to do:
 *
 *   1. LIVENESS UNVERIFIED — sessions are recorded here and nobody has
 *      confirmed whether they are running. The safe verb cannot be offered,
 *      and the remedy is a liveness read, not a node setting.
 *   2. BLOCKED BY LIVE SESSIONS — the oracle's own case (line 706): the
 *      count is named, because a refusal that names its number is actionable
 *      and one that doesn't is a wall.
 *   3. THE VERB'S OWN AVAILABILITY — the action registry's answer (deferred,
 *      a cached facade refusal, or a withheld capability), rendered verbatim.
 *
 * The ranking is deliberate: a live-session block is a fact about the WORLD and
 * outranks a fact about this BUILD. If the executor lands tomorrow, the
 * refusal here does not change — which is the correct outcome.
 */
function UnlinkFooterBlock({
  detail,
  params,
  livenessOf,
  actionContext,
}: {
  detail: EntityDetail;
  params: Params;
  livenessOf?: (id: string) => SessionLiveness;
  actionContext?: ActionContext;
}) {
  const type = asText(params.edgeType) ?? 'in_project';
  const direction = params.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const groups = direction === 'outgoing' ? detail.connections.outgoing : detail.connections.incoming;
  const sessionIds = groups
    .filter((group) => group.type === type)
    .flatMap((group) => group.edges)
    .map((edge) => (edge.source.id === detail.id ? edge.target.id : edge.source.id));

  const verdicts = sessionIds.map((id) => livenessOf?.(id));
  const measured = verdicts.filter((v) => v != null).length;
  const live = verdicts.filter((v) => v === 'live').length;

  const ref = asText(params.action);
  const def = ref ? findAction(ref) : null;
  const label = def?.label ?? (asText(params.label) ?? 'Unlink');

  const blocking: { cause: string; remedy: string } | null =
    sessionIds.length > 0 && measured === 0
      ? {
          cause: `${label} can’t be offered: liveness here is unverified`,
          remedy: `${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'} recorded in this root — none confirmed running or stopped`,
        }
      : live > 0
        ? {
            cause: `${label.toLowerCase()} blocked: ${live} live session${live === 1 ? '' : 's'} use this root`,
            remedy: 'stop them, or wait for them to exit',
          }
        : null;

  return (
    <section className="gb-unlink" data-testid="governed-unlink">
      {blocking ? (
        <DisabledAction label={label} reason={blocking}>
          {asText(params.verb) ?? 'Unlink from this space'}
        </DisabledAction>
      ) : def ? (
        <ActionControl def={def} ctx={actionContext} verb={asText(params.verb) ?? 'Unlink from this space'} />
      ) : (
        <DisabledAction
          label={label}
          reason={{
            cause: 'This build has no unlink verb for this entity',
            remedy: 'the registry block names no action id, so there is nothing to dispatch',
          }}
        >
          {asText(params.verb) ?? 'Unlink from this space'}
        </DisabledAction>
      )}
    </section>
  );
}

/** NOTICE — a static honest explanation, identical in meaning to GenericBody's. */
function NoticeBlock({ params }: { params: Params }) {
  const text = asText(params.text);
  if (!text) return null;
  return <p className="pn-notice">{text}</p>;
}

// ---------------------------------------------------------------------------
// The shared action control
// ---------------------------------------------------------------------------

/**
 * ONE renderer for "a registry-named verb", so the availability precedence is
 * decided in exactly one place for this body. It mirrors `chrome.tsx`'s
 * `ActionButton`, deliberately: same law, same order, different geometry — the
 * body's verbs are text controls, not icon buttons.
 *
 * NO CONTEXT IS NOT AVAILABLE. With no `ActionContext` there is nothing to ask,
 * and an unasked question renders as the wiring gap it is rather than as an
 * enabled button (R5 #9).
 */
function ActionControl({ def, ctx, verb }: { def: ActionDef; ctx?: ActionContext; verb?: string }) {
  const availability = ctx ? def.availability(ctx) : null;

  if (!availability) {
    return (
      <DisabledAction label={def.label} reason={NOT_WIRED_REASON}>
        {verb ?? `${def.label}…`}
      </DisabledAction>
    );
  }
  if (availability.kind === 'disabled') {
    return (
      <DisabledAction label={def.label} reason={toReason(availability.reason)}>
        {verb ?? `${def.label}…`}
      </DisabledAction>
    );
  }
  if (!ctx?.dispatch) {
    return (
      <DisabledAction label={def.label} reason={NOT_WIRED_REASON}>
        {verb ?? `${def.label}…`}
      </DisabledAction>
    );
  }

  return (
    <button
      type="button"
      className="gb-verb"
      data-testid="governed-action"
      onClick={() => void def.run(ctx)}
    >
      {verb ?? `${def.label}…`}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Structural readers — they ask what the data HAS, never what it IS (§15.2)
// ---------------------------------------------------------------------------

/**
 * Total over the action registry, so an id that does not resolve is `null`
 * rather than a crash: registry params are DATA and data can be wrong, and a
 * white screen is the worst possible way to report a typo.
 */
function findAction(id: string): ActionDef | null {
  return allActions().find((a) => a.id === id) ?? null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: string | number | boolean | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Scalars only. `null` returns null — a missing value is not a value, and
 * printing "null" into a path row is the small end of the same dishonesty as
 * printing "0" for unmeasured presence.
 */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * Elapsed time in the panel family's form (`2m`, `3h`, `2d`) — the same
 * function `ProfileBody` declares privately. Two copies, stated rather than
 * hidden: a shared home in `domain/` is the right fix and belongs to that
 * lane. Not measured whether a third copy exists.
 */
function elapsed(iso: string, now: string): string {
  const mins = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
