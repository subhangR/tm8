import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { getKind } from '../../domain';
import { Chip, Eyebrow } from '../../kit';
import { EmptyBody } from '../detail/PanelStates';
import { DisabledIconControl, NOT_WIRED_REASON } from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';
import './restricted-body.css';

/**
 * THE RESTRICTED ARCHETYPE BODY — T0-4 "Governed & fallback kinds", the
 * INTERACTION PROFILE card (oracle lines 714–762; the body region is 734–758).
 *
 * WHAT MAKES A KIND "RESTRICTED", stated as the archetype's thesis: the
 * generic verbs do not apply to it, and it moves through a LIFECYCLE of its
 * own instead. The oracle's note: "restricted kind: draft → active → retired
 * (tweak it); generic verbs disabled with the reason stated" (line 761). So
 * the body's job is to say where in that lifecycle this entity is, what the
 * thing actually contains, and which ordinary verbs are refused and why —
 * because a verb that is simply missing is indistinguishable from a screen
 * that forgot to draw it.
 *
 * ARCHETYPE, NOT KIND (§15.2 — `panels/no-branching.test.ts` fails the build
 * on a kind literal here). Nothing below names a kind, and — deliberately —
 * nothing below names a STATUS VALUE either. The lifecycle words and their
 * banner copy are registry DATA keyed by the status the entity carries
 * (`params[status]`), which is why draft/active/retired can gain a fourth
 * member without an edit to this file, and why ACTIVE draws no banner: the
 * registry declares no note for it, exactly as the oracle draws none.
 *
 * THE ONE DUPLICATION THIS BODY REFUSES TO MAKE (D64, bought last night when
 * a live-session strip duplicated the header beneath it): the status PILL
 * belongs to the panel chrome, which already renders it from
 * `registry(kind).panel.statusPill`. The banner here is a SENTENCE about a
 * consequence, not a second rendering of the same word — and where the
 * registry declares no sentence, this block draws nothing at all rather than
 * a bare pill the chrome is already showing.
 *
 * WHAT THE CONTRACT DOES NOT CARRY, measured rather than assumed (I read
 * `contract.ts` and `src/data/seam.ts` in full): `EntityContent` for this kind
 * is `{ status, templateKey, templateVersion, resolvedHash,
 * generatedByTeamMemberId }` (contract.ts:161–163) — there is NO prompt text,
 * NO voice/risk/tools projection and NO default-for list on it. The contract's
 * `InteractionProfilePreview` view is a separate shape the stamped facade seam
 * has no read for, and it is sanitized of prompt policy in any case. So those
 * regions render HOLLOW with that reason rather than blank or invented. See
 * §GAPS in the handover.
 *
 * Colours are tokens only (§14; `src/hex-ban.test.ts` scans the sheet). Micro
 * type sizes are D5-verbatim.
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
 * `items` and `notice` are deliberately the SAME names `GenericBody` uses —
 * one block name, one meaning, several renderers.
 */
export const RESTRICTED_BLOCKS = [
  'status-banner',
  'preview',
  'field-rows',
  'items',
  'restrictions',
  'pin-provenance',
  'notice',
] as const;

export type RestrictedBlockName = (typeof RESTRICTED_BLOCKS)[number];

/**
 * The registry's `ContentBlockRef` shape, widened at `block` to `string` —
 * these names are additions to `domain/types.ts`'s closed `ContentBlockKind`
 * union, and that file belongs to the registry lane, not to me. The
 * `ProfileBody` precedent, and its reason: a `readonly ContentBlockRef[]` is
 * assignable to this today, so the panel passes `config.panel.blocks` straight
 * through and nothing here changes when the union grows.
 */
export interface RestrictedBlockRef {
  block: string;
  /** Section eyebrow above the block. */
  label?: string;
  /** Block parameters — the "new display need = a new block parameter" seam. */
  params?: Readonly<Record<string, string | number | boolean>>;
}

type Params = Readonly<Record<string, string | number | boolean>>;

export interface RestrictedBodyProps {
  detail: EntityDetail;
  /** Ordered blocks from `registry(kind).panel.blocks` — registry DATA. */
  blocks: readonly RestrictedBlockRef[];
  onOpenEntity?: (id: string) => void;
}

export function RestrictedBody({ detail, blocks, onOpenEntity }: RestrictedBodyProps) {
  if (blocks.length === 0) {
    return (
      /* The tabpanel identity rides on BOTH branches: a Content tab whose
         `aria-controls` resolves to nothing when the body happens to be empty
         is a small real defect, not a styling detail. */
      <div
        className="pn-body"
        data-testid="restricted-body"
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

  return (
    <div
      className="pn-body rs-body"
      data-testid="restricted-body"
      id="tabpanel-content"
      role="tabpanel"
      aria-labelledby="tab-content"
    >
      {blocks.map((block, i) => (
        <RestrictedBlock
          key={`${block.block}:${i}`}
          detail={detail}
          block={block}
          onOpenEntity={onOpenEntity}
        />
      ))}
    </div>
  );
}

function RestrictedBlock({
  detail,
  block,
  onOpenEntity,
}: {
  detail: EntityDetail;
  block: RestrictedBlockRef;
  onOpenEntity?: (id: string) => void;
}) {
  const params = block.params ?? {};
  switch (block.block) {
    case 'status-banner':
      return <StatusBannerBlock detail={detail} params={params} />;
    case 'preview':
      return <PreviewBlock detail={detail} params={params} label={block.label} />;
    case 'field-rows':
      return <FieldRowsBlock detail={detail} params={params} />;
    case 'items':
      return (
        <ItemsBlock detail={detail} params={params} label={block.label} onOpenEntity={onOpenEntity} />
      );
    case 'restrictions':
      return <RestrictionsBlock detail={detail} params={params} />;
    case 'pin-provenance':
      return <PinProvenanceBlock detail={detail} params={params} />;
    case 'notice':
      return <NoticeBlock params={params} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// STATUS BANNER — the lifecycle consequence (oracle 735–740)
// ---------------------------------------------------------------------------

/**
 * ONE BANNER, N LIFECYCLE STATES, ZERO STATUS LITERALS.
 *
 * The registry names the MEMBER that holds the lifecycle value
 * (`params.source`), and the SENTENCE for each value comes from
 * `params[value]`. So the registry declares:
 *
 *   params: { source: 'status',
 *             draft: 'preview only — activate to offer it at launch.',
 *             retired: 'sessions pinned to it keep running — new launches …' }
 *
 * and a state with no declared sentence — the oracle's ACTIVE (it draws no
 * banner at all, line 734 goes straight to PREVIEW) — renders nothing. That is
 * the honest reading of the canvas AND the anti-duplication rule: the chrome
 * already carries the status word, so a bare pill here would be a second
 * rendering of one fact, which is how the two disagree later.
 *
 * WHY `params.source` AND NOT `panel.statusPill.source`, stated because the
 * alternative looks more elegant and is worse: the pill spec names a SOURCE
 * ('profileStatus'), not a member, and translating one to the other needs
 * `chrome.tsx`'s private `STATUS_FIELD` map — which is not exported, and of
 * which FOUR hand-copies already exist in this package (chrome, SubtreeBody,
 * home-model, GraphView). A fifth copy is a fifth thing to drift. The tone
 * below still comes from the pill spec, because tones are keyed by the VALUE
 * and need no translation. The real fix is exporting that map; it is proposed
 * in the handover rather than taken unilaterally.
 *
 * A DECLARED BLOCK WITH NO STATUS VALUE AT ALL is different from a state with
 * no sentence, and says so: the registry asked for a lifecycle and the entity
 * carries none, which is a data fault worth seeing rather than a blank.
 */
function StatusBannerBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const spec = getKind(detail.kind).panel.statusPill;
  const source = asText(params.source);
  const value = source ? scalar(lookup(detail, source)) : null;

  if (!value) {
    return (
      <p className="pn-section__empty" data-testid="restricted-banner-hollow">
        <HollowInline caption="This entity carries no lifecycle status, though its registry row asks for one. Nothing is assumed on its behalf.">
          — lifecycle
        </HollowInline>
      </p>
    );
  }

  const note = asText(params[value]);
  if (!note) return null;

  const tone = spec?.tones?.[value] ?? 'idle';
  return (
    <div className="rs-banner" data-testid="restricted-banner" data-status={value} data-tone={tone}>
      <span className="rs-banner__word">{spec?.labels?.[value] ?? value}</span>
      <span className="rs-banner__note">{note}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PREVIEW — the sanitized projection (oracle 741–744)
// ---------------------------------------------------------------------------

/** The oracle's eyebrow (line 742). */
const DEFAULT_PREVIEW_LABEL = 'PREVIEW';

/**
 * THE REGION WITH NO SOURCE, and this is the honest way to ship it.
 *
 * The oracle draws real prompt prose here ("You are terse and evidence-first…",
 * line 743). Measured: no member of this kind's `EntityContent` carries it, and
 * the contract's own preview view is explicitly "sanitized, non-interactive:
 * no prompt/tool/capture policy" (contract.ts:1452) — and the facade seam has
 * no read for it either way. So the block renders its shape with the absence
 * STATED and its cause named, which is the one presentation that stays true
 * whether the seam grows the read or the policy stays sanitized forever.
 * `params.source` is honoured the moment a member does carry it.
 */
function PreviewBlock({
  detail,
  params,
  label,
}: {
  detail: EntityDetail;
  params: Params;
  label?: string;
}) {
  const source = asText(params.source) ?? 'preview';
  const text = scalar(lookup(detail, source));

  return (
    <section className="rs-group" data-testid="restricted-preview">
      <Eyebrow faint>{label ?? DEFAULT_PREVIEW_LABEL}</Eyebrow>
      {text ? (
        <p className="rs-preview">{text}</p>
      ) : (
        <p className="rs-preview rs-preview--hollow" data-testid="restricted-preview-hollow">
          <HollowInline caption="No preview read has run: this entity's content carries no prompt text, and the contract's preview view is sanitized of prompt policy and has no seam read in this build.">
            — no preview text is available
          </HollowInline>
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// FIELD ROWS — the labelled facts table (oracle 745–749)
// ---------------------------------------------------------------------------

/**
 * The registry names WHICH facts and what to call them
 * (`params.fields: 'voice=VOICE,risk=RISK,tools=TOOLS'` — the `ProfileBody`
 * pairs idiom, so the two blocks read the same authoring shape).
 *
 * A NAMED FIELD THAT IS ABSENT KEEPS ITS ROW, hollow. Dropping it would make
 * "this profile has no risk policy" indistinguishable from "nobody asked about
 * risk", and the first of those is a fact about the entity while the second is
 * a fact about this build.
 */
function FieldRowsBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const pairs = pairsOf(params.fields);
  if (pairs.length === 0) return null;

  return (
    <dl className="rs-fields" data-testid="restricted-fields">
      {pairs.map(([key, label]) => {
        const value = scalar(lookup(detail, key));
        return (
          <div className="rs-fields__row" key={key}>
            <dt className="rs-fields__key">{label}</dt>
            <dd className="rs-fields__value">
              {value ?? (
                <HollowInline
                  caption={`This entity carries no '${key}'. The field is declared by the registry and left unmeasured by the data, which is not the same as empty.`}
                >
                  —
                </HollowInline>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// ITEMS — the DEFAULT FOR chip row (oracle 750–756)
// ---------------------------------------------------------------------------

/**
 * TWO ABSENCES THAT MUST NOT COLLAPSE (the HubBody law, applied here):
 *   · the named member is MISSING     — nothing read it; renders hollow;
 *   · the named member is an EMPTY []  — a read ran and found none; a real zero.
 * Collapsing them would print "not a default anywhere" over a question nobody
 * asked, which on this surface is a claim about governance.
 */
function ItemsBlock({
  detail,
  params,
  label,
  onOpenEntity,
}: {
  detail: EntityDetail;
  params: Params;
  label?: string;
  onOpenEntity?: (id: string) => void;
}) {
  const source = asText(params.source) ?? 'items';
  const raw = lookup(detail, source);
  const items: EntitySummary[] = Array.isArray(raw) ? raw.filter(isSummary) : [];

  return (
    <section className="rs-group" data-testid="restricted-items">
      <Eyebrow faint>{label ?? 'ITEMS'}</Eyebrow>
      {!Array.isArray(raw) ? (
        <p className="pn-section__empty" data-testid="restricted-items-hollow">
          <HollowInline caption="Nothing read this list for this panel — the entity carries no such member and this build has no seam read that would supply one.">
            — not read
          </HollowInline>
        </p>
      ) : items.length === 0 ? (
        <p className="pn-section__empty">Not the default anywhere.</p>
      ) : (
        <div className="pn-chiprow">
          {items.map((item) =>
            /*
             * A chip is a real navigation, so it renders as a real control —
             * WHEN one is wired. With no opener it would be enabled-inert,
             * the R5 #9 class. The check is structural, so it cannot drift
             * from what the host actually dispatches.
             */
            onOpenEntity ? (
              <Chip
                key={item.id}
                glyph={getKind(item.kind).chip.glyph}
                onClick={() => onOpenEntity(item.id)}
              >
                {item.title}
              </Chip>
            ) : (
              <DisabledIconControl
                key={item.id}
                label={item.title}
                glyph={getKind(item.kind).chip.glyph}
                reason={NOT_WIRED_REASON}
              >
                {item.title}
              </DisabledIconControl>
            ),
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// RESTRICTIONS — the refusals, stated (oracle 726–727's law, in the body)
// ---------------------------------------------------------------------------

/**
 * The human name of each capability the registry may withhold a reason for.
 * Not a kind fact and not a status fact — a fixed vocabulary of the capability
 * flags themselves, which is why it can live here.
 */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  canEdit: 'Edit',
  canDelete: 'Delete',
  canAddChild: 'Add child',
  canLink: 'Link',
  canPull: 'Pull',
  canReact: 'React',
  canGrantPoints: 'Grant points',
  canComplete: 'Complete',
};

/**
 * WHY THIS IS STATED PROSE AND NOT A ROW OF BUTTONS.
 *
 * The oracle draws the refused verbs in the ACTION BAR — "▲ —", "⊕ Link" at
 * .35 opacity with the caption "disabled — restricted kind" (lines 726–727) —
 * and that bar is the panel chrome, which ALREADY renders those two through
 * `ActionButton`'s disabled-with-reason path. Building a second set of verb
 * controls in the body would be D64's defect exactly: two renderings of one
 * fact, which disagree the moment one is edited.
 *
 * What the chrome does NOT show is WHY editing and deleting are refused for
 * this kind — the registry authors those sentences
 * (`panel.capabilityReasons`) and, until now, nothing rendered them. This
 * block is that surface: the refusals the server or the registry has already
 * decided, named, with their authored mechanism. It adds no control; it
 * removes a silence.
 *
 * SERVER TRUTH DECIDES WHETHER TO SHOW A ROW: a capability the server GRANTS
 * is not a restriction, even if the registry has a sentence ready for the case
 * where it doesn't. `capabilities == null` means nobody has loaded them, and
 * that renders as the checking state rather than as a refusal.
 */
function RestrictionsBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const reasons = getKind(detail.kind).panel.capabilityReasons ?? {};
  const capabilities = detail.capabilities as unknown as Record<string, unknown> | null;

  if (capabilities == null) {
    return (
      <p className="pn-section__empty" data-testid="restricted-restrictions-checking">
        <HollowInline caption="Permissions for this entity have not loaded yet — an unanswered question is not a refusal.">
          — refusals
        </HollowInline>
      </p>
    );
  }

  const refused = Object.entries(reasons).filter(
    ([flag, reason]) => typeof reason === 'string' && capabilities[flag] !== true,
  );
  if (refused.length === 0) return null;

  return (
    <section className="rs-group" data-testid="restricted-restrictions">
      <Eyebrow faint>{asText(params.label) ?? 'REFUSED HERE'}</Eyebrow>
      <ul className="rs-refusals">
        {refused.map(([flag, reason]) => (
          <li className="rs-refusals__row" key={flag}>
            <span className="rs-refusals__verb">{CAPABILITY_LABELS[flag] ?? flag}</span>
            <span className="rs-refusals__why">{reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PIN PROVENANCE — the immutability caption (oracle 757)
// ---------------------------------------------------------------------------

/**
 * The oracle's sentence carries a count ("Pinned by 3 running sessions — …",
 * line 757). Measured: no member of this entity carries that number, and the
 * contract's pin view is per-WORK-SESSION (`InteractionProfilePinView`), so
 * the count would have to be a read this build does not make.
 *
 * So the LAW is always stated (it is true regardless of the number), and the
 * count appears only where the registry names a source that resolves. A named
 * source that does not resolve renders hollow — because "pinned by 0" is the
 * one thing this caption must never say by accident.
 */
const DEFAULT_PIN_LAW =
  'A session’s pinned profile is immutable provenance: it is shown on the session and never edited from here.';

function PinProvenanceBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const law = asText(params.text) ?? DEFAULT_PIN_LAW;
  const source = asText(params.countSource);
  const count = source ? countable(lookup(detail, source)) : null;

  return (
    <p className="rs-provenance" data-testid="restricted-provenance">
      {source ? (
        count == null ? (
          <HollowInline caption="No pin count is available: pins are recorded per work session, and this build makes no read that would total them.">
            — pinned by
          </HollowInline>
        ) : (
          <span className="rs-provenance__count">{`Pinned by ${count} running session${count === 1 ? '' : 's'} — `}</span>
        )
      ) : null}
      {law}
    </p>
  );
}

/** NOTICE — a static honest explanation, identical in meaning to GenericBody's. */
function NoticeBlock({ params }: { params: Params }) {
  const text = asText(params.text);
  if (!text) return null;
  return <p className="pn-notice">{text}</p>;
}

// ---------------------------------------------------------------------------
// Structural readers — they ask what the data HAS, never what it IS (§15.2)
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `state` first, then `content` — the registry names a key, not a home. */
function lookup(detail: EntityDetail, key: string): unknown {
  const state = record(detail.state);
  if (key in state) return state[key];
  return record(detail.content)[key];
}

/** `key=Label` pairs, comma-separated — the `ProfileBody` authoring shape. */
function pairsOf(raw: unknown): Array<[string, string]> {
  const parts: string[] = typeof raw === 'string' ? raw.split(',') : [];
  const pairs: Array<[string, string]> = [];
  for (const part of parts) {
    const [key, label] = part.split('=');
    const k = key?.trim();
    if (!k) continue;
    pairs.push([k, (label ?? k).trim()]);
  }
  return pairs;
}

function asText(value: string | number | boolean | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A list counts; a number is itself; anything else is not a measurement. */
function countable(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  return null;
}

/**
 * Scalars only. `null` returns null — a missing value is not a value, and
 * printing "null" into a field cell is the small end of the same dishonesty as
 * printing "0" for unmeasured presence.
 */
function scalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

function isSummary(value: unknown): value is EntitySummary {
  const bag = record(value);
  return typeof bag.id === 'string' && typeof bag.kind === 'string' && typeof bag.title === 'string';
}
