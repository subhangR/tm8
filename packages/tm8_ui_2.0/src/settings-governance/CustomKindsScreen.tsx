/**
 * T2-5 — CUSTOM-KIND AUTHORING. Oracle:
 * `T2 Settings, Trust & Authoring Hi-Fi.dc.html`,
 * `data-screen-label="T2-5 — Custom-kind authoring"`, lines 496–618.
 *
 * The frame's promise (L498): "DEFINE A SCHEMA, GET THE WHOLE UI FOR FREE".
 * That promise is already TRUE in this package — `domain/registry.ts` carries
 * a single `c:*` fallback row, and `getKind()` resolves any unknown kind to it
 * without throwing. So the "what you get" column is not a mock-up of a future:
 * it reads the real registry and shows what the real registry would do.
 *
 * WHAT IS REAL HERE (more than anywhere else in this lane):
 *  · the existing-kinds list is `seam.entityKinds(spaceId)`, which the seam's
 *    own docblock rules is THE custom-kind source (seam.ts:169);
 *  · the whole authoring form works — typing, glyph choice, adding, removing
 *    and REORDERING fields, all of it local state that genuinely changes;
 *  · validation runs against the actual registry: reserved route words, core
 *    kind slugs, kinds this space already defines, spine-shadowing field names,
 *    duplicate fields, empty enums. Every one of those is a real answer.
 *  · the composed `EntityKindCreateInput` is shown, exactly as it would be sent.
 *
 * WHAT IS NOT: the COMMIT. `seam.entityKinds()` is a read and there is no
 * write beside it (GG16), so "Create kind" is refused with the mechanism
 * named. A form that cannot submit can still tell the truth about whether what
 * you typed would work — and this one does, which is most of its value.
 *
 * ── 2026-08-16 · IT IS A SETTINGS SECTION, NOT A SCREEN ────────────────────
 *
 * It was written as a review-board SCREEN and then handed to `SettingsShell`
 * through the `sections` slot, where it double-framed the shell: `.gov-screen`
 * carried its own `padding: var(--pn-space-4)` inside the shell's own gutters,
 * and its three `flex: 1 1 340px` columns tried to sit side by side inside a
 * card that stops at `--set-card-max` (1080px) less a 160px nav — so at any
 * real settings width the three columns wrapped into a ragged 2+1 with a
 * different rag at every window size, and none of it had a section title
 * because the screen never drew one.
 *
 * It is now three stacked GROUPS inside one `SectionFrame`, in the order a
 * person actually reads them:
 *
 *   1. what this space already has  — the record, and the empty state most
 *      spaces are actually in;
 *   2. the authoring form           — identity and schema as two labelled
 *      fieldsets rather than one flat run of every field the DTO carries;
 *   3. what it would produce        — the generic rendering and the exact
 *      payload, subordinate to the form that composes them.
 *
 * The review-board `CardNote` annotations went with the frame. They are the
 * oracle's own margin voice ("authoring — name, glyph, field schema; no layout
 * editor exists, on purpose"), and in a product settings pane they read as
 * debug text under every card.
 */
import { useId, useMemo, useState } from 'react';
import type { CustomFieldType, EntityKindDef } from '@tm8/contract';
import { Pill } from '../kit';
import { DisabledAction } from '../panels';
import { KindIcon } from '../domain/KindIcon';
import { getKind } from '../domain/registry';
import { SectionAbsent, SectionFrame } from '../settings-space';
import {
  FIELD_TYPES,
  GLYPH_CHOICES,
  UNIVERSAL_SPINE,
  draftKindId,
  draftRouteSlug,
  draftToCreateInput,
  emptyKindDraft,
  fieldTreatment,
  moveField,
  validateKindDraft,
  type DraftField,
  type KindDraft,
} from './governance-model';
import { GOVERNANCE_REASONS } from './reasons';
import type { LoadState } from './port';
import { EmptyRegion, GovCard, GovEyebrow, LoadRegion, RefusedControl } from './parts';
import './governance.css';
import './custom-kinds.css';

/** The heading `SETTINGS_SECTIONS` gives the `kinds` row. Not re-typed prose. */
export const CUSTOM_KINDS_HEADING = 'Custom kinds';

export interface CustomKindsScreenProps {
  spaceLabel: string;
  /** `seam.entityKinds(spaceId)` — a real read. */
  kinds: LoadState<readonly EntityKindDef[]>;
  /**
   * The shell's own heading for this section. Defaulted rather than required
   * so the existing mounts keep working; a host should pass the `heading` from
   * `SETTINGS_SECTIONS` so the nav row and the head can never disagree.
   */
  heading?: string;
}

let fieldSeq = 0;
const newField = (): DraftField => ({
  id: `f${++fieldSeq}`,
  name: '',
  type: 'text',
  required: false,
  values: [],
});

export function CustomKindsScreen({
  spaceLabel,
  kinds,
  heading = CUSTOM_KINDS_HEADING,
}: CustomKindsScreenProps) {
  const [draft, setDraft] = useState<KindDraft>(emptyKindDraft);
  const existing = kinds.phase === 'ready' ? kinds.value : [];
  const issues = useMemo(() => validateKindDraft(draft, existing), [draft, existing]);
  const payload = useMemo(
    () => draftToCreateInput(draft, 'preview', existing),
    [draft, existing],
  );

  return (
    <SectionFrame title={heading} bodyTestId="custom-kinds-body">
      {/* One column, in reading order. The `gov-screen` three-column deal was
          review-board furniture and is gone; what is left is a stack whose
          width the frame's measure already caps. */}
      <div className="set-kinds" data-testid="custom-kinds-screen">
        <ExistingKindsCard kinds={kinds} />
        <NewKindCard
          spaceLabel={spaceLabel}
          draft={draft}
          setDraft={setDraft}
          issues={issues}
          hasPayload={payload !== null}
        />
        <WhatYouGetCard draft={draft} payload={payload} issueCount={issues.length} />
      </div>
    </SectionFrame>
  );
}

// ---------------------------------------------------------------------------
// The authoring form — oracle L502–561
// ---------------------------------------------------------------------------

/**
 * A labelled group inside a card. The brief's "group related fields" made
 * concrete, and made real in the accessibility tree rather than only in the
 * pixels: `role="group"` + `aria-labelledby` announces "Identity, Name"
 * instead of a flat run of eight fields with no relationship between them.
 *
 * NOT `fieldset`/`legend`, which would be the semantic first choice: a
 * rendered `<legend>` is lifted out of the fieldset's anonymous content box
 * and does not behave as a flex item, so a `display: flex` fieldset lays its
 * legend out differently in every engine. `role="group"` is the same node in
 * the a11y tree with none of that.
 */
function KindGroup({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const legendId = useId();
  return (
    <div className="set-kinds__group" role="group" aria-labelledby={legendId}>
      <span className="set-kinds__legend" id={legendId}>
        {legend}
      </span>
      {hint ? <p className="set-kinds__hint">{hint}</p> : null}
      {children}
    </div>
  );
}

function NewKindCard({
  spaceLabel,
  draft,
  setDraft,
  issues,
  hasPayload,
}: {
  spaceLabel: string;
  draft: KindDraft;
  setDraft: (next: KindDraft) => void;
  issues: readonly { at: string; message: string }[];
  hasPayload: boolean;
}) {
  const titleId = useId();
  const nameId = useId();
  const pluralId = useId();

  /**
   * A PRISTINE FORM IS NOT SCOLDED. Measured in Chrome 2026-08-16: on first
   * paint, with nothing typed, this section rendered "A kind needs a name."
   * and "The plural is the menu label — the rail has nothing to show without
   * it." in error red under two empty inputs. `validateKindDraft` is answering
   * correctly — an empty draft IS invalid — but an error is a report on
   * something the reader did, and there is nothing yet to report on.
   *
   * The issue is withheld until the field has been touched, NOT dropped: the
   * count still feeds the verdict line at the foot ("2 things to fix"), the
   * payload is still withheld, and the moment a field is touched its own
   * issue appears. Nothing is hidden that would let a bad draft through.
   */
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touch = (at: string) => setTouched((prev) => (prev.has(at) ? prev : new Set(prev).add(at)));
  const issuesAt = (at: string) =>
    touched.has(at) ? issues.filter((i) => i.at === at) : [];

  return (
    <GovCard labelledBy={titleId} title="New kind" subtitle={spaceLabel}>
      <div className="gov-form set-kinds__form">
        <KindGroup legend="Identity" hint="What it is called, and the mark it is filed under.">
          <div className="gov-form__pair">
            <label className="gov-field-block" htmlFor={nameId}>
              <GovEyebrow>NAME</GovEyebrow>
              <input
                id={nameId}
                className="gov-input"
                value={draft.name}
                placeholder="incident"
                onChange={(e) => {
                  touch('name');
                  setDraft({ ...draft, name: e.target.value });
                }}
              />
              <Issues list={issuesAt('name')} />
            </label>
            <label className="gov-field-block" htmlFor={pluralId}>
              <GovEyebrow>PLURAL · MENU LABEL</GovEyebrow>
              <input
                id={pluralId}
                className="gov-input"
                value={draft.plural}
                placeholder="Incidents"
                onChange={(e) => {
                  touch('plural');
                  setDraft({ ...draft, plural: e.target.value });
                }}
              />
              <Issues list={issuesAt('plural')} />
            </label>
          </div>

          <div className="gov-field-block">
            <GovEyebrow>GLYPH</GovEyebrow>
            <div className="gov-glyphs" role="radiogroup" aria-label="Kind glyph">
              {GLYPH_CHOICES.map((glyph) => (
                <button
                  key={glyph}
                  type="button"
                  role="radio"
                  aria-checked={draft.glyph === glyph}
                  aria-label={`Glyph ${glyph}`}
                  className={draft.glyph === glyph ? 'gov-glyph gov-glyph--on' : 'gov-glyph'}
                  onClick={() => {
                    touch('glyph');
                    setDraft({ ...draft, glyph });
                  }}
                >
                  {glyph}
                </button>
              ))}
              {/* The oracle's "…" overflow. There is no larger set to open. */}
              <DisabledAction reason={GOVERNANCE_REASONS.moreGlyphs} label="More glyphs">
                …
              </DisabledAction>
            </div>
            <Issues list={issuesAt('glyph')} />
          </div>
        </KindGroup>

        <KindGroup
          legend="Schema"
          hint={`${UNIVERSAL_SPINE.join(' · ')} come built-in — every kind gets the universal spine, so these are the fields ON TOP of it.`}
        >
          {draft.fields.length === 0 ? (
            <span className="gov-empty-inline">
              no fields yet — a kind with none still gets the universal spine
            </span>
          ) : (
            <ul className="gov-field-rows">
              {draft.fields.map((field, index) => (
                <FieldEditor
                  key={field.id}
                  field={field}
                  index={index}
                  count={draft.fields.length}
                  issues={issuesAt(`field:${field.id}`)}
                  onChange={(next) => {
                    touch(`field:${field.id}`);
                    setDraft({
                      ...draft,
                      fields: draft.fields.map((f) => (f.id === field.id ? next : f)),
                    });
                  }}
                  onRemove={() =>
                    setDraft({ ...draft, fields: draft.fields.filter((f) => f.id !== field.id) })
                  }
                  onMove={(to) => setDraft({ ...draft, fields: moveField(draft.fields, index, to) })}
                />
              ))}
            </ul>
          )}
          <button
            type="button"
            className="gov-btn gov-btn--dashed set-kinds__add"
            onClick={() => setDraft({ ...draft, fields: [...draft.fields, newField()] })}
          >
            Add field
          </button>
        </KindGroup>

        {/* The verdict and the submit sit TOGETHER, at the foot of the form
            they belong to. The submit used to live in the card's header, above
            the verdict that gates it, which put the answer below the button
            asking the question. */}
        <div className="set-kinds__submit">
          {/* Refused for ONE reason and it is not the form's: the seam has no
              write. When it gains one, this becomes a live submit and the
              validation above already gates it. */}
          <RefusedControl reason={GOVERNANCE_REASONS.createKind} emphasis="primary">
            Create kind
          </RefusedControl>
          <p className="gov-prose gov-prose--quiet" data-testid="draft-verdict">
            {hasPayload
              ? 'This draft is valid — the payload it would send is shown below.'
              : issues.length === 0
                ? 'Fill in a name, plural and glyph to see the payload this would send.'
                : `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before this kind would be accepted.`}
          </p>
        </div>
      </div>
    </GovCard>
  );
}

function Issues({ list }: { list: readonly { message: string }[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="gov-issues" data-testid="draft-issues">
      {list.map((issue) => (
        <li key={issue.message}>{issue.message}</li>
      ))}
    </ul>
  );
}

/**
 * A field row. The ⠿ handle is a REAL control, not a decoration: pointer drag
 * is not built, so the handle is a focusable button that moves its row with
 * the arrow keys and says so. That is the honest version of the oracle's
 * `cursor:grab` — a grab cursor over something that cannot be grabbed is the
 * enabled-inert lie in cursor form, and `custom-kinds.css` takes that cursor
 * back off (governance.css still sets it, and it is shared).
 */
function FieldEditor({
  field,
  index,
  count,
  issues,
  onChange,
  onRemove,
  onMove,
}: {
  field: DraftField;
  index: number;
  count: number;
  issues: readonly { message: string }[];
  onChange: (next: DraftField) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  return (
    <li className="gov-field-row set-kinds__field" data-testid="field-row">
      <button
        type="button"
        className="gov-handle set-kinds__handle"
        aria-label={`Reorder ${field.name || 'unnamed field'} — position ${index + 1} of ${count}. Use the arrow keys.`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            onMove(index - 1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onMove(index + 1);
          }
        }}
      >
        ⠿
      </button>
      <input
        className="gov-input gov-input--mono set-kinds__field-name"
        value={field.name}
        placeholder="severity"
        aria-label="Field name"
        onChange={(e) => onChange({ ...field, name: e.target.value })}
      />
      <select
        className="gov-select"
        value={field.type}
        aria-label="Field type"
        onChange={(e) => onChange({ ...field, type: e.target.value as CustomFieldType })}
      >
        {FIELD_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={
          field.required ? 'gov-req gov-req--on set-kinds__tap' : 'gov-req set-kinds__tap'
        }
        aria-pressed={field.required}
        aria-label={`${field.name || 'Field'} required`}
        onClick={() => onChange({ ...field, required: !field.required })}
      >
        {field.required ? 'req' : 'opt'}
      </button>
      <button
        type="button"
        className="gov-remove set-kinds__tap"
        aria-label={`Remove ${field.name || 'field'}`}
        onClick={onRemove}
      >
        ✕
      </button>
      {/* The enum values take their OWN sub-row, under the name they belong
          to, rather than a sixth column that only some rows have. That column
          was what made every row's name input a different width. */}
      {field.type === 'enum' ? (
        <div className="set-kinds__enum">
          <span className="set-kinds__enum-label">
            values, separated by ·
          </span>
          <input
            className="gov-input gov-input--mono set-kinds__enum-input"
            value={field.values.join('·')}
            placeholder="sev1·sev2·sev3"
            aria-label="Enum values, separated by ·"
            onChange={(e) =>
              onChange({ ...field, values: e.target.value.split('·').map((v) => v.trim()) })
            }
          />
        </div>
      ) : null}
      <Issues list={issues} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// What you get — oracle L563–590
// ---------------------------------------------------------------------------

/**
 * The generic-rendering preview, built from the REAL registry row a custom
 * kind resolves to — plus the payload that would be sent, which used to be a
 * separate card in a separate column. They are one answer to one question
 * ("what would this produce?") and they are now one card.
 *
 * AND THE FINDING IT SURFACES, which is the most useful thing on this screen:
 * `getKind()` resolves every `c:*` kind to the fallback row, whose glyph is
 * the fallback mark. The glyph the author picks is stored on
 * `EntityKindDef.icon` — and NO consumer in this package reads that member
 * today. So the honest preview shows BOTH: the authored glyph, and the glyph
 * the app would actually paint. Showing only the authored one would promise a
 * result this build does not produce.
 *
 * No sample data is invented. The preview shows the SHAPE — field names and
 * how each type renders — with every value hollow, because no entity of this
 * kind exists yet. A preview with fabricated values ("sev1", "payments") reads
 * as data and is the same lie as a fabricated count.
 */
function WhatYouGetCard({
  draft,
  payload,
  issueCount,
}: {
  draft: KindDraft;
  payload: ReturnType<typeof draftToCreateInput>;
  issueCount: number;
}) {
  const titleId = useId();
  const fallback = getKind(draftKindId(draft) ?? 'c:unnamed');
  const authored = draft.glyph || '◇';
  const title = draft.name.trim() || 'unnamed kind';
  const routeSlug = draftRouteSlug(draft);

  return (
    <GovCard
      labelledBy={titleId}
      tone="node"
      title="What this would create"
      subtitle="rendered generically"
    >
      <div className="gov-preview set-kinds__preview">
        <KindGroup
          legend="Generic rendering"
          hint="Schema in, chip and card out — no code is written per kind. Values are hollow because no entity of this kind exists yet; nothing here is sample data."
        >
          <GovEyebrow>Z1 CHIP</GovEyebrow>
          <span className="gov-chip gov-chip--preview">
            <span aria-hidden>{authored}</span> {title}
          </span>

          <GovEyebrow>Z2 CARD</GovEyebrow>
          <div className="gov-preview-card">
            <div className="gov-preview-card__head">
              <span aria-hidden>{authored}</span>
              <span className="gov-preview-card__title">{title}</span>
            </div>
            {draft.fields.length === 0 ? (
              <span className="gov-empty-inline">no fields — the card shows the spine only</span>
            ) : (
              <ul className="gov-preview-fields">
                {draft.fields.map((field) => (
                  <li key={field.id}>
                    <span className="gov-preview-fields__name">{field.name || 'unnamed'}</span>
                    <span className={`gov-treat gov-treat--${fieldTreatment(field.type)}`}>—</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="gov-prose gov-prose--quiet">
            Z3 PANEL · FIELDS — fields render by type: enum and bool as word-chips, text and number
            as values, date as mono.
          </p>
        </KindGroup>

        <KindGroup legend="What the registry actually does today">
          <div className="gov-verdict" data-testid="registry-verdict">
            <ul>
              <li>
                archetype: <span className="gov-mono">{fallback.panel.archetype}</span> — the
                generic floor every custom kind lands on, with no code written per kind
              </li>
              <li>
                {/* The mark painted is the fallback row's DRAWN artwork, so the
                    verdict shows the drawing — quoting the text character would
                    state a fact this build stopped producing. */}
                mark painted: <KindIcon kind={fallback.kind} size={13} />
                {authored !== fallback.chip.glyph ? (
                  <>
                    {' '}
                    — NOT the {authored} you picked. The chosen glyph is stored on the kind record
                    and no consumer reads it yet.
                  </>
                ) : null}
              </li>
              <li>
                route:{' '}
                <span className="gov-mono">{routeSlug ? `k/${routeSlug}` : 'needs a name'}</span>
              </li>
            </ul>
          </div>
        </KindGroup>

        <KindGroup legend="What would be sent">
          <div className="gov-payload" data-testid="payload-card">
            {payload ? (
              <pre className="gov-pre">{JSON.stringify(payload, null, 2)}</pre>
            ) : (
              <span className="gov-empty-inline">
                {issueCount === 0
                  ? 'nothing yet — the draft is incomplete'
                  : 'the draft does not validate, so no payload is composed'}
              </span>
            )}
            <p className="gov-prose gov-prose--quiet">
              {GOVERNANCE_REASONS.createKind.cause} — {GOVERNANCE_REASONS.createKind.remedy}.
            </p>
          </div>
        </KindGroup>
      </div>
    </GovCard>
  );
}

// ---------------------------------------------------------------------------
// Existing kinds + the unknown-kind fallback — oracle L591–609
// ---------------------------------------------------------------------------

/**
 * The kinds this space already defines, from the one read the seam genuinely
 * performs. Each row shows its field schema raw — which IS the oracle's
 * unknown-kind treatment (L594–605: "◇ glyph, raw key:values, honest
 * caption"), applied to the case that actually occurs: a kind defined by a
 * newer tm8 than this UI knows about renders exactly like this, because the
 * registry has no row for it and the fallback carries no field vocabulary.
 *
 * THE EMPTY STATE IS THE COMMON STATE. Most spaces define no custom kinds at
 * all, so the pane a person is most likely to open is this one with nothing
 * in it. It is a `SectionAbsent` — the shell's own honest-absence block, which
 * says what would be here and why it is not — rather than a bare list that
 * renders as a void. It keeps the `empty-region` test id so the assertion that
 * this space "defines none" still points at the thing that says it.
 */
function ExistingKindsCard({ kinds }: { kinds: LoadState<readonly EntityKindDef[]> }) {
  const titleId = useId();
  return (
    <GovCard labelledBy={titleId} title="Kinds in this space" subtitle="custom only">
      <div className="set-kinds__list">
        <LoadRegion state={kinds} what="custom kinds">
          {(items) =>
            items.length === 0 ? (
              <EmptyRegion>
                <SectionAbsent
                  testId="section-absent-kinds"
                  head="This space defines no custom kinds."
                  why="core kinds are always present, are not listed here, and are not editable — define one below to add a kind of your own"
                />
              </EmptyRegion>
            ) : (
              <ul className="gov-rows">
                {items.map((def) => (
                  <li key={def.id} className="gov-row" data-testid="existing-kind-row">
                    <div className="gov-row__head">
                      <span aria-hidden className="gov-row__glyph">
                        {def.icon || <KindIcon kind={def.kind} />}
                      </span>
                      <span className="gov-row__title">{def.kind}</span>
                      <span className="gov-card__spacer" />
                      <Pill tone="idle">{def.origin}</Pill>
                    </div>
                    <div className="gov-row__meta">
                      {def.fieldSchema.length === 0 ? (
                        <span className="gov-empty-inline">no fields — spine only</span>
                      ) : (
                        <span className="gov-mono">
                          {def.fieldSchema
                            .map((f) => `${f.name}: ${f.type}${f.required ? ' (req)' : ''}`)
                            .join(' · ')}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadRegion>
      </div>
      <div className="gov-fallback">
        <GovEyebrow>UNKNOWN KIND — FALLBACK</GovEyebrow>
        <p className="gov-prose gov-prose--quiet">
          A kind defined by a newer tm8 than this UI knows still opens: the{' '}
          <KindIcon kind="c:unknown" size={13} /> fallback mark, raw key:values, and the{' '}
          {getKind('c:unknown').panel.archetype} archetype. Open, discuss and link keep working —
          only typed rendering is missing, and the caption says so rather than hiding the fields.
        </p>
      </div>
    </GovCard>
  );
}
