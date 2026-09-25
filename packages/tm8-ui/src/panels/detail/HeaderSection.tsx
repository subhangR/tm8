import { useEffect, useId, useState } from 'react';
import type { CommandResult, EntityDetail, EntityHeaderResult, EntityHeaderView, HeaderTextInput } from '@tm8/contract';
import { Eyebrow } from '../../kit';
import {
  HEADER_GUIDANCE,
  headerDraftHasText,
  headerDraftOf,
  headerDraftsEqual,
  headerInputOf,
  headerInputOfView,
  headerStaleness,
  parseKeywords,
  staleSentence,
  type HeaderDraft,
} from '../../domain';
import { classifyFailure, type HeaderCommands } from '../../authoring/commands';
import { formatSizeRow } from '../../files/model';
import { DisabledAction, type UnavailableReason } from '../honesty/DisabledWithReason';

/**
 * THE SELECTION HEADER — "when should an agent open this, and what does it
 * hold?" — read and written by a person (I9a). Until now only the CLI could
 * (`tm8 entity header set`, I4).
 *
 * It sits atop the Connections tab, beside a session's LAUNCH CONTEXT, because
 * both answer the same question from opposite ends: that section lists what a
 * launch picked, this one is what a launch reads when deciding whether to pick
 * THIS entity.
 *
 * WHAT A READ CARRIES. `entities.get` carries `header` ONLY when one is
 * authored (I4's rule), so default reads stay byte-identical. With none, this
 * section asks the opt-in `header=resolved` read (`commands.resolvedHeader`)
 * for the fallback launches read, and shows it labelled with its source
 * (`derived`). A host without that read gets the plain sentence.
 *
 * ITS OWN VERSION. `expectedVersion` is `header.version` (0 = none yet), never
 * the entity's, and a write never moves the entity's version — so no
 * `entity.upsert` echoes it. The result carries the entity with its header,
 * which the host ingests through `onSaved`; until it does, the result is shown.
 *
 * LENIENT (Subhang's ruling, msg 01a0d6f1; migration 223): length is
 * GUIDANCE — a live count against "aim for ≤ N" — and never disables Save.
 * The node normalises rather than refuses and says so in `warnings`, which
 * are shown as notes; anything it does refuse is shown in its own words.
 *
 * CLIPPED READS. Every reader — `entities.get/context` AND the header
 * commands' own result (#796) — cuts authored text to the guidance and names
 * the fields it cut (`header.clipped`); the full text lives only in
 * `entity_headers`. Re-saving what a clipped read showed would SHORTEN the
 * stored header, so Mark current refuses on a clipped header and the editor
 * says plainly that it holds the shortened text.
 *
 * UNTRUSTED TEXT. Header text is graph content anyone with edit rights wrote:
 * it renders as React text nodes only, never as HTML or markdown.
 */
export function HeaderSection({
  detail,
  commands,
  onSaved,
}: {
  detail: EntityDetail;
  commands?: Partial<HeaderCommands> | null;
  onSaved?: (result: CommandResult) => void;
}) {
  // The last write's answer, held against the detail it was made over: once
  // the host hands in a newer detail (ingested result, or a refetch), the
  // detail is the authority again.
  const [written, setWritten] = useState<{ base: EntityDetail; header: EntityHeaderView | undefined } | null>(null);
  const header = written && written.base === detail ? written.header : detail.header;
  const authored = header && header.version > 0 ? header : undefined;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HeaderDraft>(() => headerDraftOf(authored));
  const [busy, setBusy] = useState<'save' | 'clear' | 'mark' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // THE DERIVED PREVIEW (I9a follow-up). With no authored header, ask the
  // opt-in `header=resolved` read what launches fall back to. Only a version-0
  // answer is a fallback: a version > 0 means this detail is behind an
  // authored header, and that is the detail's to show, not this preview's.
  const readResolved = commands?.resolvedHeader;
  const hasAuthored = authored !== undefined;
  const [fallback, setFallback] = useState<{ id: string; header: EntityHeaderView | undefined } | null>(null);
  useEffect(() => {
    if (hasAuthored || !readResolved) return;
    let live = true;
    const id = detail.id;
    readResolved(id).then(
      (h) => { if (live) setFallback({ id, header: h && h.version === 0 ? h : undefined }); },
      // A failed preview is not an error to report: the sentence below is
      // still true, it just cannot quote the text.
      () => { if (live) setFallback({ id, header: undefined }); },
    );
    return () => { live = false; };
  }, [hasAuthored, readResolved, detail.id, detail.version]);
  const derived = !authored && fallback?.id === detail.id && fallback.header
    && (fallback.header.whenToUse !== null || fallback.header.summary !== null)
    ? fallback.header
    : undefined;

  // A different entity in the same panel instance starts clean.
  useEffect(() => {
    setWritten(null);
    setEditing(false);
    setError(null);
    setNotice(null);
    setBusy(null);
  }, [detail.id]);

  const set = commands?.setEntityHeader;
  const clear = commands?.clearEntityHeader;
  const unavailable: UnavailableReason | null = !detail.capabilities.canEdit
    ? { cause: 'You cannot edit this entity', remedy: 'its header is written by someone with edit rights' }
    : !set || !clear
      ? { cause: 'Header writes are not wired here', remedy: 'this surface was mounted without the header commands' }
      : null;

  const stale = authored ? headerStaleness(authored, detail.version) : null;
  const clipped = authored?.clipped ?? [];

  async function run(kind: 'save' | 'clear' | 'mark', op: () => Promise<EntityHeaderResult>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const result = await op();
      // No `header` ⇒ the node stored none for this kind (`header_not_stored`).
      setWritten({ base: detail, header: result.header && result.header.version > 0 ? result.header : undefined });
      const warnings = result.warnings ?? [];
      if (warnings.length > 0) setNotice(warnings.map((w) => w.message).join(' '));
      setEditing(false);
      onSaved?.(result);
    } catch (e) {
      const failure = classifyFailure(e, kind === 'clear' ? 'clear' : 'save');
      setError(`${failure.cause}: ${failure.detail}`);
    } finally {
      setBusy(null);
    }
  }

  const save = (text: HeaderTextInput, kind: 'save' | 'mark') =>
    set && run(kind, () => set(detail.id, { ...text, expectedVersion: authored?.version ?? 0 }));

  const startEdit = () => {
    setDraft(headerDraftOf(authored));
    setError(null);
    setEditing(true);
  };

  const badges = (
    <div className="pn-header__badges">
      <span className="pn-header__badge" data-source={authored ? 'authored' : derived ? derived.source : 'none'} data-testid="header-source">
        {authored ? 'authored' : derived ? derived.source : 'not authored'}
      </span>
      {stale ? (
        <span className="pn-header__badge pn-header__badge--stale" data-testid="header-stale" title="Mark current re-pins it to the body as it is now">
          {`stale · ${staleSentence(stale)}`}
        </span>
      ) : null}
      {authored && authored.bytes !== null ? (
        <span className="pn-header__badge pn-header__badge--quiet" data-testid="header-bytes" title="Size of the body a load brings in">
          {`body ${formatSizeRow(authored.bytes)}`}
        </span>
      ) : null}
    </div>
  );

  if (editing) {
    const hasText = headerDraftHasText(draft);
    const changed = !headerDraftsEqual(draft, headerDraftOf(authored));
    return (
      <section className="pn-section pn-header" data-testid="header-section">
        <Eyebrow faint>HEADER</Eyebrow>
        {badges}
        <HeaderFields draft={draft} onChange={setDraft} disabled={busy !== null} />
        {clipped.length > 0 ? (
          <p className="pn-launch__note pn-header__clip-note" data-testid="header-clipped-note">
            {`This read showed ${clipped.join(', ')} shortened. Saving writes exactly what is in these fields, so restore anything the stored text had beyond it.`}
          </p>
        ) : null}
        {hasText || !authored ? null : (
          <p className="pn-launch__note" data-testid="header-blank-note">
            Every field is empty, so saving changes nothing. To remove the header, use Clear.
          </p>
        )}
        {error ? <p className="pn-header__error" role="alert" data-testid="header-error">{error}</p> : null}
        <div className="pn-header__actions">
          {/* NEVER DISABLED FOR CONTENT — not for length, not for blanks: the
              node decides, and its refusal lands in the alert above. */}
          <button
            type="button"
            className="pn-btn pn-btn--primary"
            aria-busy={busy === 'save'}
            onClick={() => void save(headerInputOf(draft), 'save')}
            data-testid="header-save"
          >
            {/* Unchanged over a CLIPPED read is not a re-pin: it writes the
                shortened text over the longer stored one, so it says so. */}
            {busy === 'save' ? 'Saving…' : changed || !authored ? 'Save header' : clipped.length > 0 ? 'Save shortened text' : 'Save (re-pin)'}
          </button>
          <button type="button" className="pn-btn pn-btn--quiet" onClick={() => { setEditing(false); setError(null); }}>
            Cancel
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="pn-section pn-header" data-testid="header-section">
      <Eyebrow faint>HEADER</Eyebrow>
      {badges}
      {authored ? (
        <dl className="pn-header__view">
          <HeaderField label="When to open" value={authored.whenToUse} testId="header-when" />
          <HeaderField label="What it holds" value={authored.summary} testId="header-summary" />
          {authored.keywords.length > 0 ? (
            <div className="pn-header__row">
              <dt>Keywords</dt>
              <dd className="pn-header__keywords" data-testid="header-keywords">
                {authored.keywords.map((k) => <span className="pn-header__chip" key={k}>{k}</span>)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : derived ? (
        <>
          <p className="pn-launch__note" data-testid="header-none">
            {`No authored header: launches read this ${derived.source} one.`}
          </p>
          <dl className="pn-header__view pn-header__view--derived" data-testid="header-derived">
            <HeaderField label="When to open" value={derived.whenToUse} testId="header-derived-when" />
            <HeaderField label="What it holds" value={derived.summary} testId="header-derived-summary" />
          </dl>
        </>
      ) : (
        <p className="pn-launch__note" data-testid="header-none">
          No header: later launches see its derived summary.
        </p>
      )}
      {clipped.length > 0 ? (
        <p className="pn-launch__note" data-testid="header-clipped">
          {`Shown shortened (${clipped.join(', ')}): the stored header is longer.`}
        </p>
      ) : null}
      {notice ? <p className="pn-launch__note" role="status" data-testid="header-notice">{notice}</p> : null}
      {error ? <p className="pn-header__error" role="alert" data-testid="header-error">{error}</p> : null}
      <div className="pn-header__actions">
        {unavailable ? (
          <DisabledAction reason={unavailable} label={authored ? 'Edit header' : 'Write header'}>
            {authored ? 'Edit' : 'Write header'}
          </DisabledAction>
        ) : (
          <>
            <button type="button" className="pn-btn" onClick={startEdit} data-testid="header-edit">
              {authored ? 'Edit' : 'Write header'}
            </button>
            {authored && stale && clipped.length > 0 ? (
              <DisabledAction
                reason={{ cause: 'This read shows the header shortened', remedy: 're-saving it would cut the stored text; use Edit instead' }}
                label="Mark current"
              >
                Mark current
              </DisabledAction>
            ) : authored && stale ? (
              <button
                type="button"
                className="pn-btn"
                aria-busy={busy === 'mark'}
                onClick={() => void save(headerInputOfView(authored), 'mark')}
                data-testid="header-mark-current"
                title="Re-save the same text; it re-pins the header to the body as it is now"
              >
                {busy === 'mark' ? 'Marking…' : 'Mark current'}
              </button>
            ) : null}
            {authored && clear ? (
              <button
                type="button"
                className="pn-btn pn-btn--quiet"
                aria-busy={busy === 'clear'}
                onClick={() => void run('clear', () => clear(detail.id, { expectedVersion: authored.version }))}
                data-testid="header-clear"
              >
                {busy === 'clear' ? 'Clearing…' : 'Clear'}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function HeaderField({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  if (value === null) return null;
  return (
    <div className="pn-header__row">
      <dt>{label}</dt>
      <dd className="pn-header__text" data-testid={testId}>{value}</dd>
    </div>
  );
}

/**
 * The two text fields and the keyword line — shared by this section's editor
 * and the header-carrying create form, so both speak the same guidance.
 */
export function HeaderFields({
  draft,
  onChange,
  disabled = false,
}: {
  draft: HeaderDraft;
  onChange: (next: HeaderDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className="pn-header__fields">
      <GuidedText
        label="When should an agent open this?"
        value={draft.whenToUse}
        aim={HEADER_GUIDANCE.whenToUse}
        onChange={(whenToUse) => onChange({ ...draft, whenToUse })}
        disabled={disabled}
        testId="header-input-when"
      />
      <GuidedText
        label="What does it hold?"
        value={draft.summary}
        aim={HEADER_GUIDANCE.summary}
        onChange={(summary) => onChange({ ...draft, summary })}
        disabled={disabled}
        testId="header-input-summary"
      />
      <label className="pn-header__field">
        <span className="pn-header__label">
          Keywords <em className="pn-header__hint">comma-separated · optional · {parseKeywords(draft.keywords).length}</em>
        </span>
        <input
          className="pn-header__input"
          value={draft.keywords}
          onChange={(e) => onChange({ ...draft, keywords: e.target.value })}
          disabled={disabled}
          data-testid="header-input-keywords"
        />
      </label>
    </div>
  );
}

function GuidedText({
  label,
  value,
  aim,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  aim: number;
  onChange: (value: string) => void;
  disabled: boolean;
  testId: string;
}) {
  const countId = useId();
  const count = value.trim().length;
  const over = count > aim;
  return (
    <label className="pn-header__field">
      <span className="pn-header__label">
        {label}{' '}
        <em
          className={over ? 'pn-header__hint pn-header__hint--over' : 'pn-header__hint'}
          id={countId}
          data-testid={`${testId}-count`}
        >
          {`${count} · aim for ≤ ${aim}`}
        </em>
      </span>
      <textarea
        className="pn-header__input"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-describedby={countId}
        data-testid={testId}
      />
    </label>
  );
}
