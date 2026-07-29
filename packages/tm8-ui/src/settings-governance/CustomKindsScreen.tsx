/**
 * T2-5 — CUSTOM-KIND AUTHORING. Oracle:
 * `T2 Settings, Trust & Authoring Hi-Fi.dc.html`,
 * `data-screen-label="T2-5 — Custom-kind authoring"`, lines 496–618.
 *
 * The frame's promise (L498): "DEFINE A SCHEMA, GET THE WHOLE UI FOR FREE".
 * That promise is already TRUE in this package — `domain/registry.ts:729` is
 * the single `c:*` fallback row, and `getKind()` resolves any unknown kind to
 * it without throwing. So the "what you get" column is not a mock-up of a
 * future: it reads the real registry and shows what the real registry would do.
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
 */
import { useId, useMemo, useState } from 'react';
import type { CustomFieldType, EntityKindDef } from '@tm8/contract';
import { Pill } from '../kit';
import { DisabledAction } from '../panels';
import { getKind } from '../domain/registry';
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
import {
  CardNote,
  EmptyRegion,
  GovCard,
  GovEyebrow,
  LoadRegion,
  RefusedControl,
} from './parts';
import './governance.css';

export interface CustomKindsScreenProps {
  spaceLabel: string;
  /** `seam.entityKinds(spaceId)` — a real read. */
  kinds: LoadState<readonly EntityKindDef[]>;
}

let fieldSeq = 0;
const newField = (): DraftField => ({
  id: `f${++fieldSeq}`,
  name: '',
  type: 'text',
  required: false,
  values: [],
});

export function CustomKindsScreen({ spaceLabel, kinds }: CustomKindsScreenProps) {
  const [draft, setDraft] = useState<KindDraft>(emptyKindDraft);
  const existing = kinds.phase === 'ready' ? kinds.value : [];
  const issues = useMemo(() => validateKindDraft(draft, existing), [draft, existing]);
  const payload = useMemo(
    () => draftToCreateInput(draft, 'preview', existing),
    [draft, existing],
  );

  return (
    <div className="gov-screen gov-screen--kinds" data-testid="custom-kinds-screen">
      <div className="gov-col gov-col--wide">
        <NewKindCard
          spaceLabel={spaceLabel}
          draft={draft}
          setDraft={setDraft}
          issues={issues}
          hasPayload={payload !== null}
        />
        <CardNote>authoring — name, glyph, field schema; no layout editor exists, on purpose</CardNote>
      </div>

      <div className="gov-col">
        <WhatYouGetCard draft={draft} />
        <CardNote>
          generic rendering — schema in, chip/card/panel out; the glyph row reads the REAL registry
          fallback, not a drawing of one
        </CardNote>
        <PayloadCard payload={payload} issueCount={issues.length} />
      </div>

      <div className="gov-col">
        <ExistingKindsCard kinds={kinds} />
        <CardNote>
          unknown kinds fall back honestly — ◇ glyph, raw key:values, nothing hidden
        </CardNote>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The authoring form — oracle L502–561
// ---------------------------------------------------------------------------

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
  const issuesAt = (at: string) => issues.filter((i) => i.at === at);

  return (
    <GovCard
      labelledBy={titleId}
      title="New kind"
      subtitle={spaceLabel}
      action={
        /* Refused for ONE reason and it is not the form's: the seam has no
           write. When it gains one, this becomes a live submit and the
           validation below already gates it. */
        <RefusedControl reason={GOVERNANCE_REASONS.createKind} emphasis="primary">
          Create kind
        </RefusedControl>
      }
    >
      <div className="gov-form">
        <div className="gov-form__pair">
          <label className="gov-field-block" htmlFor={nameId}>
            <GovEyebrow>NAME</GovEyebrow>
            <input
              id={nameId}
              className="gov-input"
              value={draft.name}
              placeholder="incident"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
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
              onChange={(e) => setDraft({ ...draft, plural: e.target.value })}
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
                onClick={() => setDraft({ ...draft, glyph })}
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

        <div className="gov-field-block">
          <GovEyebrow>FIELDS</GovEyebrow>
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
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      fields: draft.fields.map((f) => (f.id === field.id ? next : f)),
                    })
                  }
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
            className="gov-btn gov-btn--dashed"
            onClick={() => setDraft({ ...draft, fields: [...draft.fields, newField()] })}
          >
            ＋ field
          </button>
        </div>

        <p className="gov-spine">
          {UNIVERSAL_SPINE.join(' · ')} come built-in — every kind gets the universal spine
        </p>
        <p className="gov-prose gov-prose--quiet" data-testid="draft-verdict">
          {hasPayload
            ? 'This draft is valid — the payload it would send is shown beside it.'
            : issues.length === 0
              ? 'Fill in a name, plural and glyph to see the payload this would send.'
              : `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before this kind would be accepted.`}
        </p>
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
 * enabled-inert lie in cursor form.
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
    <li className="gov-field-row" data-testid="field-row">
      <button
        type="button"
        className="gov-handle"
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
        className="gov-input gov-input--mono"
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
      {field.type === 'enum' ? (
        <input
          className="gov-input gov-input--mono"
          value={field.values.join('·')}
          placeholder="sev1·sev2·sev3"
          aria-label="Enum values, separated by ·"
          onChange={(e) =>
            onChange({ ...field, values: e.target.value.split('·').map((v) => v.trim()) })
          }
        />
      ) : null}
      <button
        type="button"
        className={field.required ? 'gov-req gov-req--on' : 'gov-req'}
        aria-pressed={field.required}
        aria-label={`${field.name || 'Field'} required`}
        onClick={() => onChange({ ...field, required: !field.required })}
      >
        {field.required ? 'req' : 'opt'}
      </button>
      <button type="button" className="gov-remove" aria-label={`Remove ${field.name || 'field'}`} onClick={onRemove}>
        ✕
      </button>
      <Issues list={issues} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// What you get — oracle L563–590
// ---------------------------------------------------------------------------

/**
 * The generic-rendering preview, built from the REAL registry row a custom
 * kind resolves to.
 *
 * AND THE FINDING IT SURFACES, which is the most useful thing on this screen:
 * `getKind()` resolves every `c:*` kind to the fallback row, whose glyph is
 * `◇` (registry.ts:740). The glyph the author picks is stored on
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
function WhatYouGetCard({ draft }: { draft: KindDraft }) {
  const titleId = useId();
  const fallback = getKind(draftKindId(draft) ?? 'c:unnamed');
  const authored = draft.glyph || '◇';
  const title = draft.name.trim() || 'unnamed kind';
  const routeSlug = draftRouteSlug(draft);

  return (
    <GovCard labelledBy={titleId} tone="node" title="What you get" subtitle="rendered generically">
      <div className="gov-preview">
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

        <GovEyebrow>Z3 PANEL · FIELDS</GovEyebrow>
        <p className="gov-prose gov-prose--quiet">
          Fields render by type: enum and bool as word-chips, text and number as values, date as
          mono. Values are hollow here because no entity of this kind exists yet — nothing on this
          card is sample data.
        </p>

        <div className="gov-verdict" data-testid="registry-verdict">
          <GovEyebrow>WHAT THE REGISTRY ACTUALLY DOES TODAY</GovEyebrow>
          <ul>
            <li>
              archetype: <span className="gov-mono">{fallback.panel.archetype}</span> — the generic
              floor every custom kind lands on, with no code written per kind
            </li>
            <li>
              glyph painted: <span className="gov-mono">{fallback.chip.glyph}</span>
              {authored !== fallback.chip.glyph ? (
                <>
                  {' '}
                  — NOT the {authored} you picked. The chosen glyph is stored on the kind record and
                  no consumer reads it yet.
                </>
              ) : null}
            </li>
            <li>
              route: <span className="gov-mono">{routeSlug ? `k/${routeSlug}` : 'needs a name'}</span>
            </li>
          </ul>
        </div>
      </div>
    </GovCard>
  );
}

/** The composed payload — shown so the refusal is about the wire, not the form. */
function PayloadCard({
  payload,
  issueCount,
}: {
  payload: ReturnType<typeof draftToCreateInput>;
  issueCount: number;
}) {
  return (
    <GovCard>
      <div className="gov-payload" data-testid="payload-card">
        <GovEyebrow>WHAT WOULD BE SENT</GovEyebrow>
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
 */
function ExistingKindsCard({ kinds }: { kinds: LoadState<readonly EntityKindDef[]> }) {
  const titleId = useId();
  return (
    <GovCard labelledBy={titleId} title="Kinds in this space" subtitle="custom only">
      <LoadRegion state={kinds} what="custom kinds">
        {(items) =>
          items.length === 0 ? (
            <EmptyRegion>
              This space defines no custom kinds. The core kinds are always present and are not
              listed here — they are not editable.
            </EmptyRegion>
          ) : (
            <ul className="gov-rows">
              {items.map((def) => (
                <li key={def.id} className="gov-row" data-testid="existing-kind-row">
                  <div className="gov-row__head">
                    <span aria-hidden className="gov-row__glyph">
                      {def.icon || getKind(def.kind).chip.glyph}
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
      <div className="gov-fallback">
        <GovEyebrow>UNKNOWN KIND — FALLBACK</GovEyebrow>
        <p className="gov-prose gov-prose--quiet">
          A kind defined by a newer tm8 than this UI knows still opens: {getKind('c:unknown').chip.glyph}{' '}
          glyph, raw key:values, and the {getKind('c:unknown').panel.archetype} archetype. Open,
          discuss and link keep working — only typed rendering is missing, and the caption says so
          rather than hiding the fields.
        </p>
      </div>
    </GovCard>
  );
}
