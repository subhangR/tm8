/**
 * THE STYLE EDITOR (styles spec v8 §9.2, phase 3). Opened from the picker:
 * a PERSONAL style opens editable (Basics / Variables / Advanced), a SPACE
 * style opens read-only with Pull, Use and its Versions (the push history).
 *
 * LIVE DRAFT, THIS TAB ONLY. Every edit goes to `applyDraft`, so the whole
 * tab — `data-theme`, terminals, the editor itself — repaints as you type.
 * Nothing is stored until Save (`styles.personal.update`, `expectedVersion`
 * guarded); closing or Revert drops the draft and the committed style paints
 * again. Previewing a space style's older version uses the same mechanism.
 *
 * WARNINGS NEVER BLOCK (§9.2 "warnings strip"). Contrast, clamped values and
 * dropped css are computed locally by the same resolver and sanitiser the
 * server runs, shown in one strip, and Save / Push stay enabled.
 *
 * CONFLICTS. A `personal_style.updated` for the open style from another tab
 * reloads silently when this one is clean; with unsaved edits it shows
 * "Updated elsewhere" and keeps the draft, and Save answers `version_conflict`
 * until reloaded. A push that loses a race (someone pushed since this
 * author's `publishedVersion`) offers Compare, Push over it and Pull first.
 *
 * WIDGETS (colour pickers, ANSI grid, font dropdown, xterm sample) are phase
 * 4; here a colour is a text field with a swatch.
 */
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BUILTIN_STYLES,
  STYLE_MAX_CSS_BYTES,
  STYLE_REGISTRY,
  STYLE_SCHEMA_VERSION,
  cssNumber,
  resolveStyle,
  sanitizeStyleCss,
  type ActorSummary,
  type BuiltinStyleId,
  type PersonalStyleView,
  type StyleDoc,
  type StyleGetResult,
  type StyleRef,
  type StyleRegistryEntry,
  type StyleVarGroup,
  type StyleWarning,
} from '@tm8/contract';

import type { Seam, StyleVersionsPage } from '../data/seam';
import { relTime } from '../kit/time';
import { applyDraft } from './style-store';
import { chooseStyle, knownStylePrefs, setStyleCssTrust, stylePrefsWritable } from './style-sync';
import { downloadStyle } from './style-io';
import './style-editor.css';

export type StyleEditorSeam = Partial<
  Pick<
    Seam,
    | 'style'
    | 'updatePersonalStyle'
    | 'deletePersonalStyle'
    | 'pushStyle'
    | 'pullStyle'
    | 'styleVersions'
    | 'onEvent'
  >
>;

/** What the picker asks the editor to open. */
export type StyleEditorTarget = { kind: 'personal'; id: string } | { kind: 'space'; id: string };

export interface StyleEditorProps {
  seam: StyleEditorSeam;
  target: StyleEditorTarget;
  spaceId: string | null;
  members: readonly ActorSummary[];
  /** Warnings to show on open (an import's parse warnings). */
  initialWarnings?: StyleWarning[];
  onClose: () => void;
  /** A write landed (save, push, pull, delete): the picker re-reads its lists. */
  onChanged?: () => void;
  /** Pull created a personal style: open it. */
  onOpen?: (target: StyleEditorTarget) => void;
}

type Tab = 'basics' | 'variables' | 'advanced' | 'versions';

interface Draft {
  title: string;
  tags: string;
  foundation: BuiltinStyleId;
  vars: Record<string, string>;
  css: string;
}

const ENTRIES = STYLE_REGISTRY.entries;
const BY_KEY = new Map(ENTRIES.map((e) => [e.key as string, e]));

const GROUP_LABEL: Record<StyleVarGroup, string> = {
  surface: 'Surface',
  status: 'Status',
  type: 'Type',
  'type-scale': 'Text sizes',
  spacing: 'Spacing',
  radius: 'Radius',
  elevation: 'Elevation',
  motion: 'Motion',
  'terminal-colour': 'Terminal colours',
  'terminal-option': 'Terminal options',
  extras: 'Extras',
};

/** Basics: the handful of keys most styles change (§9.2). */
const BASIC_COLOURS = ['--pn-brand', '--pn-paper', '--pn-surface', '--pn-card', '--pn-ink', '--pn-ink-2', '--pn-line'];
const STATUS_COLOURS = ['--pn-run', '--pn-wait', '--pn-block', '--pn-idle', '--pn-info'];
const TERMINAL_BASICS = ['--pn-term-font', '--pn-term-font-size', '--pn-term-cursor-style', '--pn-term-chrome'];

/** Macros: many keys from one factor, off the FOUNDATION's values (§9.2). */
const MACROS: { id: string; label: string; keys: string[] }[] = [
  { id: 'text', label: 'Text size ×', keys: ENTRIES.filter((e) => e.group === 'type-scale').map((e) => e.key) },
  {
    id: 'spacing',
    label: 'Spacing ×',
    keys: ENTRIES.filter((e) => e.group === 'spacing' && e.key.startsWith('--pn-space-')).map((e) => e.key),
  },
  { id: 'radius', label: 'Radius ×', keys: ['--pn-r-xs', '--pn-r-sm', '--pn-r-md', '--pn-r-lg'] },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function draftOf(view: PersonalStyleView): Draft {
  return {
    title: view.title,
    tags: view.tags.join(', '),
    foundation: view.doc.foundation,
    vars: { ...view.doc.vars },
    css: view.doc.css ?? '',
  };
}

function docOf(draft: Draft): StyleDoc {
  return {
    schemaVersion: STYLE_SCHEMA_VERSION,
    foundation: draft.foundation,
    vars: draft.vars,
    css: draft.css.trim() ? draft.css : null,
  };
}

function tagsOf(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))];
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `14px` → [14, 'px']; null for anything not a plain number with a unit. */
function splitLength(value: string | undefined): [number, string] | null {
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec((value ?? '').trim());
  return m ? [Number(m[1]), m[2] ?? ''] : null;
}

function isHex(value: string | undefined): boolean {
  return /^#[0-9a-f]{6}$/i.test((value ?? '').trim());
}

/**
 * The space-style version this author last pushed (`publishedVersion`, added
 * to `PersonalStyleView` by #1002 for §9.2), or null on a first push / a node
 * that predates the field.
 */
function publishedVersionOf(view: PersonalStyleView): number | null {
  const v = (view as PersonalStyleView & { publishedVersion?: number | null }).publishedVersion;
  return typeof v === 'number' && v > 0 ? v : null;
}

/** A space style's doc out of an `entities.versions` snapshot (the `styles` detail row). */
function snapshotDoc(snapshot: Record<string, unknown> | null): StyleDoc | null {
  if (!snapshot) return null;
  const candidates = [snapshot, snapshot.content, snapshot.doc, snapshot.state] as unknown[];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.foundation === 'string' && o.foundation in BUILTIN_STYLES) {
      return {
        schemaVersion: STYLE_SCHEMA_VERSION,
        foundation: o.foundation as BuiltinStyleId,
        vars: o.vars && typeof o.vars === 'object' ? (o.vars as Record<string, string>) : {},
        css: typeof o.css === 'string' ? o.css : null,
      };
    }
  }
  return null;
}

/** Every local warning for a doc: resolver (contrast, clamped, invalid) + css sanitiser, de-duplicated. */
function localWarnings(doc: StyleDoc): StyleWarning[] {
  const resolved = resolveStyle(doc);
  const seen = new Set<string>();
  const out: StyleWarning[] = [];
  for (const w of [...resolved.warnings, ...sanitizeStyleCss(doc.css).warnings]) {
    const k = `${w.code}|${w.key}|${w.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

function memberName(members: readonly ActorSummary[], id: string | null | undefined): string | null {
  if (!id) return null;
  const a = members.find((m) => m.id === id);
  if (!a) return null;
  return a.isAgent ? `${a.displayName} (agent)` : a.displayName;
}

export function StyleEditor(props: StyleEditorProps) {
  const { onClose } = props;
  /* Leaving the editor, by any path, drops the preview. */
  useEffect(() => () => applyDraft(null), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const body =
    props.target.kind === 'personal' ? (
      <PersonalEditor {...props} id={props.target.id} />
    ) : (
      <SpaceStyleView {...props} id={props.target.id} />
    );
  const overlay = (
    <div className="cv2-root styleed__scrim" data-testid="style-editor">
      <div className="styleed" role="dialog" aria-modal="true" aria-label="Style editor">
        {body}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}

// ── personal: editable ─────────────────────────────────────────────────────

function PersonalEditor({
  seam,
  id,
  spaceId,
  members,
  initialWarnings,
  onClose,
  onChanged,
  onOpen,
}: StyleEditorProps & { id: string }) {
  const [saved, setSaved] = useState<PersonalStyleView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab>('basics');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverWarnings, setServerWarnings] = useState<StyleWarning[]>(initialWarnings ?? []);
  const [elsewhere, setElsewhere] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /* §9.2: a push that lost the race — the space style as it stands now. */
  const [pushConflict, setPushConflict] = useState<StyleGetResult | null>(null);
  const [comparing, setComparing] = useState(false);

  const load = useCallback(async () => {
    if (!seam.style) throw new Error('This server cannot read styles.');
    const got: StyleGetResult = await seam.style(`personal:${id}`);
    if (!got.personal) throw new Error('Not a personal style.');
    setSaved(got.personal);
    setDraft(draftOf(got.personal));
    setElsewhere(false);
  }, [seam, id]);

  useEffect(() => {
    load().catch((e: unknown) => setError(messageOf(e)));
  }, [load]);

  const dirty = !!saved && !!draft && !sameDraft(draftOf(saved), draft);

  /* Another tab saved this style (§9.2 conflict handling). */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const versionRef = useRef<number | null>(null);
  versionRef.current = saved?.version ?? null;
  useEffect(() => {
    if (!seam.onEvent) return undefined;
    return seam.onEvent((event) => {
      if (event.type !== 'personal_style.updated' || event.id !== id) return;
      if (versionRef.current !== null && event.version <= versionRef.current) return;
      if (event.deleted) {
        setError('This style was deleted in another tab.');
        return;
      }
      if (dirtyRef.current) setElsewhere(true);
      else void load().catch((e: unknown) => setError(messageOf(e)));
    });
  }, [seam, id, load]);

  const doc = useMemo(() => (draft ? docOf(draft) : null), [draft]);
  useEffect(() => {
    if (doc) applyDraft(doc);
  }, [doc]);
  const warnings = useMemo(() => {
    const local = doc ? localWarnings(doc) : [];
    const keys = new Set(local.map((w) => `${w.code}|${w.key}`));
    return [...local, ...serverWarnings.filter((w) => !keys.has(`${w.code}|${w.key}`))];
  }, [doc, serverWarnings]);
  const foundationTokens = draft ? BUILTIN_STYLES[draft.foundation]?.tokens ?? {} : {};

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const setVar = useCallback((key: string, value: string | null) => {
    setDraft((d) => {
      if (!d) return d;
      const vars = { ...d.vars };
      if (value === null || value.trim() === '') delete vars[key];
      else vars[key] = value;
      return { ...d, vars };
    });
  }, []);

  const save = () =>
    run('save', async () => {
      if (!saved || !draft || !seam.updatePersonalStyle) return;
      try {
        const res = await seam.updatePersonalStyle(saved.id, {
          expectedVersion: saved.version,
          title: draft.title.trim() || saved.title,
          tags: tagsOf(draft.tags),
          foundation: draft.foundation,
          varsReplace: draft.vars,
          css: docOf(draft).css,
        });
        setSaved(res.style);
        setDraft(draftOf(res.style));
        setServerWarnings(res.warnings);
        setElsewhere(false);
        setNotice(res.clamped.length ? `Saved; ${res.clamped.length} value(s) were clamped.` : 'Saved.');
        onChanged?.();
      } catch (e) {
        if (errorCode(e) === 'version_conflict') {
          setElsewhere(true);
          throw new Error('Updated elsewhere since you opened it: reload, or keep editing and copy your changes over.');
        }
        throw e;
      }
    });

  /**
   * PUSH (§1.4, §9.2). Re-pushing guards on the version this author last
   * pushed (`publishedVersion`), so a member who pushed in between is not
   * silently overwritten: the server answers `version_conflict` and the
   * editor offers Compare, Push over it, or Pull first. `overVersion` is the
   * explicit "push over it" — the version the author has now seen.
   */
  const pushTo = async (overVersion?: number) => {
    if (!saved || !seam.pushStyle || !spaceId) return;
    if (dirty) throw new Error('Save first: Push sends the saved version.');
    const lastPushed = publishedVersionOf(saved);
    const expectedVersion = overVersion ?? lastPushed ?? undefined;
    try {
      const res = await seam.pushStyle({
        personalStyleId: saved.id,
        spaceId,
        ...(saved.publishedAs ? { targetStyleId: saved.publishedAs } : {}),
        ...(saved.publishedAs && expectedVersion !== undefined ? { expectedVersion } : {}),
      });
      setPushConflict(null);
      setComparing(false);
      setServerWarnings(res.warnings);
      setNotice(`Pushed as ${res.style.title} v${res.style.version}. Everyone using it sees this now.`);
      await load();
      onChanged?.();
    } catch (e) {
      if (errorCode(e) === 'version_conflict' && saved.publishedAs && seam.style) {
        setPushConflict(await seam.style(`space:${saved.publishedAs}`));
        return;
      }
      throw e;
    }
  };

  const push = () => run('push', () => pushTo());
  const pushOver = () => run('push', () => pushTo(pushConflict?.version));
  const pullFirst = () =>
    run('pull', async () => {
      if (!saved?.publishedAs || !seam.pullStyle) return;
      const res = await seam.pullStyle(`space:${saved.publishedAs}`);
      setPushConflict(null);
      onChanged?.();
      if (onOpen) onOpen({ kind: 'personal', id: res.style.id });
      else setNotice(`Pulled into “${res.style.title}”.`);
    });

  const use = () =>
    run('use', async () => {
      if (!saved) return;
      await chooseStyle(saved.ref as StyleRef);
      setNotice('Now using this style.');
    });

  const remove = () =>
    run('delete', async () => {
      if (!saved || !seam.deletePersonalStyle) return;
      await seam.deletePersonalStyle(saved.id, saved.version);
      onChanged?.();
      onClose();
    });

  if (!saved || !draft || !doc) {
    return (
      <>
        <Header title="Style" onClose={onClose} />
        <p className={error ? 'styleed__error' : 'styleed__note'} role={error ? 'alert' : undefined}>
          {error ?? 'Loading…'}
        </p>
      </>
    );
  }

  const exportBtns = (
    <ExportButtons doc={dirty ? doc : saved.doc} title={draft.title || saved.title} disabled={busy !== null} />
  );

  return (
    <>
      <Header
        title={draft.title || 'Untitled style'}
        meta={[
          `personal · v${saved.version}`,
          saved.publishedAs ? 'pushed to a space' : null,
          saved.pulledFrom ? `pulled from v${saved.pulledFrom.version}` : null,
          dirty ? 'unsaved changes' : null,
        ]}
        onClose={onClose}
      >
        <button type="button" className="styleed__btn" disabled={busy !== null} onClick={() => void use()}>
          Use
        </button>
        {seam.pushStyle && spaceId ? (
          <button
            type="button"
            className="styleed__btn"
            disabled={busy !== null}
            title={saved.publishedAs ? 'Push a new version of the space style' : 'Share this style with the space'}
            onClick={() => void push()}
          >
            Push
          </button>
        ) : null}
        {exportBtns}
        {seam.deletePersonalStyle ? (
          confirmDelete ? (
            <button
              type="button"
              className="styleed__btn styleed__btn--danger"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              Confirm delete
            </button>
          ) : (
            <button type="button" className="styleed__btn" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )
        ) : null}
      </Header>

      {elsewhere ? (
        <p className="styleed__banner" role="status">
          Updated elsewhere: reload or keep editing.
          <button type="button" className="styleed__link" onClick={() => void run('reload', load)}>
            Reload
          </button>
        </p>
      ) : null}
      {error ? (
        <p className="styleed__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="styleed__note">{notice}</p> : null}
      {pushConflict ? (
        <div className="styleed__banner styleed__banner--block" role="alert" data-testid="style-push-conflict">
          <span>
            v{pushConflict.version} was pushed by{' '}
            {memberName(members, pushConflict.space?.pushedBy) ?? 'another member'} since your last push: compare,
            then push over it or pull first.
          </span>
          <span className="styleed__actions">
            <button type="button" className="styleed__btn" aria-pressed={comparing} onClick={() => setComparing((v) => !v)}>
              Compare
            </button>
            <button type="button" className="styleed__btn" disabled={busy !== null} onClick={() => void pushOver()}>
              Push over it
            </button>
            {seam.pullStyle ? (
              <button type="button" className="styleed__btn" disabled={busy !== null} onClick={() => void pullFirst()}>
                Pull first
              </button>
            ) : null}
          </span>
          {comparing ? <StyleDiff mine={doc} theirs={pushConflict.doc} theirLabel={`v${pushConflict.version}`} /> : null}
        </div>
      ) : null}

      <div className="styleed__meta">
        <label className="styleed__field">
          <span>Title</span>
          <input
            value={draft.title}
            maxLength={200}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label className="styleed__field">
          <span>Foundation</span>
          <select
            value={draft.foundation}
            onChange={(e) => setDraft({ ...draft, foundation: e.target.value as BuiltinStyleId })}
          >
            {Object.values(BUILTIN_STYLES).map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
        </label>
        <label className="styleed__field">
          <span>Tags</span>
          <input
            value={draft.tags}
            placeholder="dark, blue"
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
        </label>
      </div>

      <Tabs tab={tab} onTab={setTab} tabs={['basics', 'variables', 'advanced']} />

      <div className="styleed__body">
        {tab === 'basics' ? (
          <Basics draft={draft} foundationTokens={foundationTokens} setVar={setVar} setDraft={setDraft} />
        ) : tab === 'variables' ? (
          <VariablesTable vars={draft.vars} foundationTokens={foundationTokens} setVar={setVar} />
        ) : (
          <Advanced
            draft={draft}
            doc={doc}
            onCss={(css) => setDraft({ ...draft, css })}
            note={
              <p className="styleed__optin" role="note">
                Custom CSS always runs for you. If you push this style, other members see its CSS only after
                they choose <strong>Allow</strong> for it; until then they get the variables alone. Rules that could
                hide or overlay controls are removed (see warnings).
              </p>
            }
          />
        )}
      </div>

      <WarningsStrip warnings={warnings} />

      <footer className="styleed__foot">
        <button
          type="button"
          className="styleed__btn"
          disabled={!dirty || busy !== null}
          onClick={() => {
            setDraft(draftOf(saved));
            setServerWarnings([]);
          }}
        >
          Revert
        </button>
        <span className="styleed__spacer" />
        <button
          type="button"
          className="styleed__btn styleed__btn--primary"
          disabled={!dirty || busy !== null || !seam.updatePersonalStyle}
          onClick={() => void save()}
          data-testid="style-editor-save"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </>
  );
}

// ── space: read-only, Pull + Versions ──────────────────────────────────────

function SpaceStyleView({
  seam,
  id,
  members,
  onClose,
  onChanged,
  onOpen,
}: StyleEditorProps & { id: string }) {
  const [style, setStyle] = useState<StyleGetResult | null>(null);
  const [tab, setTab] = useState<Tab>('variables');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const ref = `space:${id}`;

  const load = useCallback(async () => {
    if (!seam.style) throw new Error('This server cannot read styles.');
    setStyle(await seam.style(ref));
  }, [seam, ref]);

  useEffect(() => {
    load().catch((e: unknown) =>
      setError(errorCode(e) === 'not_found' ? 'This style was removed from the space.' : messageOf(e)),
    );
  }, [load]);

  /* A push lands as `entity.upsert` of this style: re-read so the view is current. */
  useEffect(() => {
    if (!seam.onEvent) return undefined;
    return seam.onEvent((event) => {
      if (event.type === 'entity.upsert' && event.entity.id === id) void load().catch(() => {});
    });
  }, [seam, id, load]);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const prefs = knownStylePrefs();
  const trusted = !!prefs?.trustedCss.includes(id);
  const space = style?.space;

  if (!style) {
    return (
      <>
        <Header title="Style" onClose={onClose} />
        <p className={error ? 'styleed__error' : 'styleed__note'} role={error ? 'alert' : undefined}>
          {error ?? 'Loading…'}
        </p>
      </>
    );
  }

  const hasCss = !!style.doc.css;
  const foundationTokens = BUILTIN_STYLES[style.doc.foundation]?.tokens ?? {};

  return (
    <>
      <Header
        title={style.title}
        meta={[
          `space style · v${style.version}`,
          space ? `pushed by ${memberName(members, space.pushedBy) ?? 'a member'}` : null,
          space ? relTime(space.pushedAt, Date.now()) : null,
          'read-only',
        ]}
        onClose={onClose}
      >
        <button
          type="button"
          className="styleed__btn"
          disabled={busy !== null}
          onClick={() =>
            void run('use', async () => {
              await chooseStyle(ref as StyleRef);
              setNotice('Now using this style. New pushes reach you live.');
            })
          }
        >
          Use
        </button>
        {seam.pullStyle ? (
          <button
            type="button"
            className="styleed__btn styleed__btn--primary"
            disabled={busy !== null}
            title="Copy into a personal style you can edit"
            onClick={() =>
              void run('pull', async () => {
                const res = await seam.pullStyle!(ref);
                onChanged?.();
                if (onOpen) onOpen({ kind: 'personal', id: res.style.id });
                else setNotice(`Pulled into “${res.style.title}”.`);
              })
            }
          >
            Pull
          </button>
        ) : null}
        <ExportButtons doc={style.doc} title={style.title} disabled={busy !== null} />
      </Header>

      {error ? (
        <p className="styleed__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="styleed__note">{notice}</p> : null}
      {previewing !== null ? (
        <p className="styleed__banner" role="status">
          Previewing v{previewing} in this tab only.
          <button
            type="button"
            className="styleed__link"
            onClick={() => {
              applyDraft(null);
              setPreviewing(null);
            }}
          >
            Stop preview
          </button>
        </p>
      ) : null}

      {hasCss ? (
        <CssTrustNotice
          trusted={trusted}
          busy={busy !== null}
          onToggle={() => void run('trust', () => setStyleCssTrust(id, !trusted))}
        />
      ) : null}

      <Tabs tab={tab} onTab={setTab} tabs={['variables', 'advanced', 'versions']} />

      <div className="styleed__body">
        {tab === 'variables' ? (
          <VariablesTable vars={style.doc.vars} foundationTokens={foundationTokens} readOnly />
        ) : tab === 'advanced' ? (
          <Advanced doc={style.doc} />
        ) : (
          <VersionsList
            seam={seam}
            entityId={id}
            members={members}
            current={style.version}
            previewing={previewing}
            onPreview={(version, doc) => {
              applyDraft(doc);
              setPreviewing(version);
            }}
          />
        )}
      </div>

      <WarningsStrip warnings={style.warnings} />
    </>
  );
}

function CssTrustNotice({ trusted, busy, onToggle }: { trusted: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <div className="styleed__optin" role="note" data-testid="style-css-optin">
      <span>
        {trusted
          ? 'This style’s custom CSS runs for you.'
          : 'This style contains custom CSS. It does not run for you until you allow it; you get its variables only.'}{' '}
        The CSS is sanitised either way: it cannot load anything, run script or hide controls.
      </span>
      {stylePrefsWritable() ? (
        <button type="button" className="styleed__btn" disabled={busy} onClick={onToggle}>
          {trusted ? 'Revoke' : 'Allow'}
        </button>
      ) : null}
    </div>
  );
}

function VersionsList({
  seam,
  entityId,
  members,
  current,
  previewing,
  onPreview,
}: {
  seam: StyleEditorSeam;
  entityId: string;
  members: readonly ActorSummary[];
  current: number;
  previewing: number | null;
  onPreview: (version: number, doc: StyleDoc) => void;
}) {
  const [items, setItems] = useState<StyleVersionsPage['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchPage = useCallback(
    async (after: string | null) => {
      if (!seam.styleVersions) return;
      setLoading(true);
      try {
        const page = await seam.styleVersions(entityId, after);
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setLoading(false);
      }
    },
    [seam, entityId],
  );

  useEffect(() => {
    void fetchPage(null);
  }, [fetchPage, current]);

  if (!seam.styleVersions) return <p className="styleed__note">This server does not list versions.</p>;
  const now = Date.now();
  return (
    <div className="styleed__versions" data-testid="style-versions">
      {error ? (
        <p className="styleed__error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="styleed__vlist">
        {items.map((v) => {
          const doc = snapshotDoc(v.snapshot);
          const who = v.changedBy
            ? memberName(members, v.changedBy.id) ?? v.changedBy.displayName
            : null;
          return (
            <li key={v.version} className="styleed__vrow">
              <span className="styleed__vnum">v{v.version}</span>
              <span className="styleed__vmeta">
                {[who ? `by ${who}` : null, relTime(v.changedAt, now), doc ? `${Object.keys(doc.vars).length} vars` : null]
                  .filter(Boolean)
                  .join(' · ')}
                {v.version === current ? ' · current' : ''}
              </span>
              {doc ? (
                <button
                  type="button"
                  className="styleed__btn"
                  aria-pressed={previewing === v.version}
                  onClick={() => onPreview(v.version, doc)}
                >
                  Preview
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!loading && items.length === 0 && !error ? <p className="styleed__note">No versions yet.</p> : null}
      {cursor ? (
        <button type="button" className="styleed__btn" disabled={loading} onClick={() => void fetchPage(cursor)}>
          {loading ? 'Loading…' : 'Older versions'}
        </button>
      ) : null}
    </div>
  );
}

// ── tabs ───────────────────────────────────────────────────────────────────

function Basics({
  draft,
  foundationTokens,
  setVar,
  setDraft,
}: {
  draft: Draft;
  foundationTokens: Record<string, string>;
  setVar: (key: string, value: string | null) => void;
  setDraft: (d: Draft) => void;
}) {
  const applyMacro = (keys: string[], factor: number) => {
    const vars = { ...draft.vars };
    for (const key of keys) {
      const base = splitLength(foundationTokens[key]);
      if (!base) continue;
      if (factor === 1) delete vars[key];
      else vars[key] = `${cssNumber(Math.round(base[0] * factor * 100) / 100)}${base[1]}`;
    }
    setDraft({ ...draft, vars });
  };
  /* The factor a macro currently reads as: the first key's set value over its foundation value. */
  const factorOf = (keys: string[]): number => {
    const key = keys[0];
    if (!key) return 1;
    const base = splitLength(foundationTokens[key]);
    const set = splitLength(draft.vars[key]);
    if (!base || !set || base[0] === 0) return 1;
    return Math.round((set[0] / base[0]) * 100) / 100;
  };

  return (
    <div className="styleed__basics">
      <section>
        <h4 className="styleed__h">Colours</h4>
        {BASIC_COLOURS.map((k) => (
          <VarRow key={k} entry={BY_KEY.get(k)} vars={draft.vars} foundationTokens={foundationTokens} setVar={setVar} />
        ))}
      </section>
      <section>
        <h4 className="styleed__h">Status</h4>
        {STATUS_COLOURS.map((k) => (
          <VarRow key={k} entry={BY_KEY.get(k)} vars={draft.vars} foundationTokens={foundationTokens} setVar={setVar} />
        ))}
      </section>
      <section>
        <h4 className="styleed__h">Size</h4>
        {MACROS.map((m) => {
          const factor = factorOf(m.keys);
          return (
            <label key={m.id} className="styleed__macro">
              <span>{m.label}</span>
              <input
                type="range"
                min={0.75}
                max={1.5}
                step={0.05}
                value={factor}
                onChange={(e) => applyMacro(m.keys, Number(e.target.value))}
              />
              <output>{factor.toFixed(2)}</output>
            </label>
          );
        })}
      </section>
      <section>
        <h4 className="styleed__h">Terminal</h4>
        {TERMINAL_BASICS.map((k) => (
          <VarRow key={k} entry={BY_KEY.get(k)} vars={draft.vars} foundationTokens={foundationTokens} setVar={setVar} />
        ))}
      </section>
    </div>
  );
}

function VariablesTable({
  vars,
  foundationTokens,
  setVar,
  readOnly,
}: {
  vars: Record<string, string>;
  foundationTokens: Record<string, string>;
  setVar?: (key: string, value: string | null) => void;
  readOnly?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [onlySet, setOnlySet] = useState(!!readOnly);
  const q = query.trim().toLowerCase();
  const groups = new Map<StyleVarGroup, StyleRegistryEntry[]>();
  for (const e of ENTRIES) {
    if (onlySet && vars[e.key] === undefined) continue;
    if (q && !e.key.includes(q) && !e.label.toLowerCase().includes(q)) continue;
    const list = groups.get(e.group) ?? [];
    list.push(e);
    groups.set(e.group, list);
  }
  const setCount = Object.keys(vars).length;
  return (
    <div className="styleed__vars">
      <div className="styleed__varsbar">
        <input
          type="search"
          className="styleed__search"
          placeholder="Search variables"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="search variables"
        />
        <label className="styleed__check">
          <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />
          Only set ({setCount})
        </label>
      </div>
      {[...groups].map(([group, entries]) => (
        <section key={group}>
          <h4 className="styleed__h">{GROUP_LABEL[group]}</h4>
          {entries.map((e) => (
            <VarRow
              key={e.key}
              entry={e}
              vars={vars}
              foundationTokens={foundationTokens}
              {...(setVar && !readOnly ? { setVar } : {})}
              showKey
            />
          ))}
        </section>
      ))}
      {groups.size === 0 ? <p className="styleed__note">No variables match.</p> : null}
    </div>
  );
}

function VarRow({
  entry,
  vars,
  foundationTokens,
  setVar,
  showKey,
}: {
  entry: StyleRegistryEntry | undefined;
  vars: Record<string, string>;
  foundationTokens: Record<string, string>;
  setVar?: (key: string, value: string | null) => void;
  showKey?: boolean;
}) {
  if (!entry) return null;
  const key = entry.key;
  const value = vars[key];
  const inherited = foundationTokens[key] ?? '';
  const isSet = value !== undefined;
  const shown = value ?? inherited;
  const colour = entry.kind === 'colour';
  const enumValues = entry.kind === 'enum' ? entry.values ?? [] : null;
  return (
    <div className={`styleed__var${isSet ? ' styleed__var--set' : ''}`} data-key={key}>
      <span className="styleed__varlabel">
        {entry.label}
        {showKey ? <code className="styleed__varkey">{key}</code> : null}
      </span>
      {colour ? <span className="styleed__swatch" style={{ background: shown }} aria-hidden /> : null}
      {!setVar ? (
        <code className="styleed__varval">{shown}</code>
      ) : enumValues ? (
        <select
          className="styleed__input"
          value={shown}
          aria-label={key}
          onChange={(e) => setVar(key, e.target.value === inherited ? null : e.target.value)}
        >
          {enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <>
          {colour && isHex(shown) ? (
            <input
              type="color"
              className="styleed__colour"
              value={shown}
              aria-label={`${key} picker`}
              onChange={(e) => setVar(key, e.target.value)}
            />
          ) : null}
          <input
            className="styleed__input"
            value={value ?? ''}
            placeholder={inherited}
            aria-label={key}
            spellCheck={false}
            onChange={(e) => setVar(key, e.target.value === '' ? null : e.target.value)}
          />
        </>
      )}
      <span className={`styleed__badge${isSet ? ' styleed__badge--set' : ''}`}>{isSet ? 'set' : 'inherited'}</span>
      {setVar && isSet ? (
        <button type="button" className="styleed__link" title="Back to the foundation's value" onClick={() => setVar(key, null)}>
          Reset
        </button>
      ) : null}
    </div>
  );
}

function Advanced({
  draft,
  doc,
  onCss,
  note,
}: {
  draft?: Draft;
  doc: StyleDoc;
  onCss?: (css: string) => void;
  note?: ReactNode;
}) {
  const css = draft ? draft.css : doc.css ?? '';
  const bytes = new TextEncoder().encode(css).length;
  const sanitized = useMemo(() => sanitizeStyleCss(css || null), [css]);
  return (
    <div className="styleed__advanced">
      <h4 className="styleed__h">Custom CSS</h4>
      {note}
      {onCss ? (
        <textarea
          className="styleed__css"
          value={css}
          spellCheck={false}
          rows={10}
          placeholder=".pn-card { border-radius: var(--pn-r-lg); }"
          aria-label="custom css"
          onChange={(e) => onCss(e.target.value)}
        />
      ) : (
        <pre className="styleed__code">{css || '(none)'}</pre>
      )}
      <p className="styleed__fine">
        {bytes} / {STYLE_MAX_CSS_BYTES} bytes · scoped under .cv2-root
        {sanitized.warnings.length ? ` · ${sanitized.warnings.length} part(s) will be dropped` : ''}
      </p>
      {sanitized.warnings.length ? (
        <ul className="styleed__inline-warn">
          {sanitized.warnings.map((w, i) => (
            <li key={i}>{w.message}</li>
          ))}
        </ul>
      ) : null}
      <h4 className="styleed__h">Document (JSON)</h4>
      <pre className="styleed__code">{JSON.stringify(doc, null, 2)}</pre>
    </div>
  );
}

/** Key-by-key difference between two docs (foundation, vars, css): the §9.2 Compare. */
function StyleDiff({ mine, theirs, theirLabel }: { mine: StyleDoc; theirs: StyleDoc; theirLabel: string }) {
  const rows: { key: string; mine: string; theirs: string }[] = [];
  if (mine.foundation !== theirs.foundation) {
    rows.push({ key: 'foundation', mine: mine.foundation, theirs: theirs.foundation });
  }
  const keys = [...new Set([...Object.keys(mine.vars), ...Object.keys(theirs.vars)])].sort();
  for (const key of keys) {
    const a = mine.vars[key];
    const b = theirs.vars[key];
    if (a !== b) rows.push({ key, mine: a ?? '(inherited)', theirs: b ?? '(inherited)' });
  }
  if ((mine.css ?? '') !== (theirs.css ?? '')) {
    rows.push({ key: 'css', mine: mine.css ? `${mine.css.length} chars` : '(none)', theirs: theirs.css ? `${theirs.css.length} chars` : '(none)' });
  }
  if (rows.length === 0) return <p className="styleed__note">No differences: pushing over it changes nothing.</p>;
  return (
    <table className="styleed__diff" data-testid="style-diff">
      <thead>
        <tr>
          <th>Key</th>
          <th>Yours</th>
          <th>{theirLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <code>{r.key}</code>
            </td>
            <td>
              <code>{r.mine}</code>
            </td>
            <td>
              <code>{r.theirs}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── chrome ─────────────────────────────────────────────────────────────────

function Header({
  title,
  meta,
  onClose,
  children,
}: {
  title: string;
  meta?: (string | null)[];
  onClose: () => void;
  children?: ReactNode;
}) {
  const bits = (meta ?? []).filter(Boolean);
  return (
    <header className="styleed__head">
      <div className="styleed__titles">
        <h3 className="styleed__title">{title}</h3>
        {bits.length ? <span className="styleed__sub">{bits.join(' · ')}</span> : null}
      </div>
      <div className="styleed__actions">{children}</div>
      <button type="button" className="styleed__close" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </header>
  );
}

const TAB_LABEL: Record<Tab, string> = {
  basics: 'Basics',
  variables: 'Variables',
  advanced: 'Advanced',
  versions: 'Versions',
};

function Tabs({ tab, onTab, tabs }: { tab: Tab; onTab: (t: Tab) => void; tabs: Tab[] }) {
  return (
    <div className="styleed__tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          className="styleed__tab"
          onClick={() => onTab(t)}
        >
          {TAB_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

function ExportButtons({ doc, title, disabled }: { doc: StyleDoc; title: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="styleed__btn" disabled={disabled} onClick={() => setOpen(true)}>
        Export
      </button>
    );
  }
  const pick = (format: 'css' | 'json', only: 'set' | 'all') => {
    downloadStyle(doc, title, format, only);
    setOpen(false);
  };
  return (
    <span className="styleed__export" role="group" aria-label="export">
      <button type="button" className="styleed__btn" onClick={() => pick('json', 'set')}>
        .tm8style.json
      </button>
      <button type="button" className="styleed__btn" onClick={() => pick('css', 'set')}>
        CSS (set)
      </button>
      <button type="button" className="styleed__btn" onClick={() => pick('css', 'all')}>
        CSS (all)
      </button>
    </span>
  );
}

function WarningsStrip({ warnings }: { warnings: StyleWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <details className="styleed__warnings" data-testid="style-warnings">
      <summary>
        {warnings.length} warning{warnings.length === 1 ? '' : 's'} — Save and Push still work
      </summary>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>
            <span className="styleed__wcode">{w.code}</span> {w.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
