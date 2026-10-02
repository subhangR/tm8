/**
 * THE STYLE PICKER — the account menu's Appearance, grown from light/dark into
 * styles (styles spec v8 §9.1). Desktop menu and phone sheet both mount it;
 * the host hands it in as a slot so neither menu learns about the seam.
 *
 * WHAT IT OFFERS. Three groups — Mine (personal styles), Space (styles pushed
 * to this space, "v3 · pushed by Sam · 2m ago"), Built-in — each row a USE
 * (writes `identity.stylePrefs.set`; other tabs follow by event) and, for a
 * space style, a PULL into a personal copy. Then Follow OS with its dark
 * style, and the kill switch "Reset to Atelier Light" (§6.8 item 6).
 *
 * EDIT, VIEW, NEW, IMPORT (phase 3). A personal row's Edit and a space row's
 * View open the editor (`StyleEditorHost`, mounted by the shell — the menu
 * closing must not close it); Push lives in the editor, next to Save, so a
 * push always sends what the author just looked at. New style… duplicates the
 * built-in the viewer is closest to; Import… reads a `.tm8style.json` or an
 * exported `.css` into a new personal style. No hover preview: the list rows
 * carry no document, and a preview that has to fetch first is not one.
 *
 * COLLAPSED BY DEFAULT. The light/dark toggle above it stays exactly where it
 * was; this is one disclosure row beneath it, so the menu a viewer opens
 * looks the way it did until they ask for more.
 */
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  BUILTIN_STYLES,
  BUILTIN_STYLE_IDS,
  importStyle,
  parseStyleRef,
  type ActorSummary,
  type PersonalStyleSummary,
  type StyleListRow,
  type StyleRef,
} from '@tm8/contract';

import type { Seam } from '../data/seam';
import { relTime } from '../kit/time';
import { getStyleState, subscribeStyle, type StyleEntry } from './style-store';
import {
  chooseStyle,
  knownSpaceDefault,
  knownStylePrefs,
  setStyleCssTrust,
  setStyleFollowOs,
  stylePrefsWritable,
  subscribeStyleCatalog,
} from './style-sync';
import { openStyleEditor } from './StyleEditorHost';
import { pickStyleFile, titleFromFileName } from './style-io';
import './style-picker.css';

export type StylePickerSeam = Partial<Pick<Seam, 'styles' | 'personalStyles' | 'pullStyle' | 'createPersonalStyle'>>;

export interface StylePickerProps {
  seam: StylePickerSeam | null;
  spaceId: string | null;
  /** The space's members, to name who pushed a version. */
  members: readonly ActorSummary[];
  /** `menu`: inside the desktop account popover; `sheet`: the phone sheet. */
  variant?: 'menu' | 'sheet';
}

interface Lists {
  mine: PersonalStyleSummary[];
  space: StyleListRow[];
}

const EMPTY_LISTS: Lists = { mine: [], space: [] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useStyleState() {
  return useSyncExternalStore(subscribeStyle, getStyleState, getStyleState);
}

/** Re-read the lists while open, at most once a second, when a style event lands. */
function useCatalogLists(seam: StylePickerSeam | null, spaceId: string | null, open: boolean) {
  const [lists, setLists] = useState<Lists>(EMPTY_LISTS);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeStyleCatalog(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setTick((n) => n + 1);
      }, 1000);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !seam) return undefined;
    let alive = true;
    const mine = seam.personalStyles ? seam.personalStyles().then((r) => r.items) : Promise.resolve([]);
    const space = seam.styles && spaceId ? seam.styles(spaceId).then((r) => r.items) : Promise.resolve([]);
    Promise.all([mine, space]).then(
      ([m, s]) => {
        if (!alive) return;
        setLists({ mine: m, space: s.filter((row) => row.origin === 'space') });
        setError(null);
      },
      (e: unknown) => alive && setError(messageOf(e)),
    );
    return () => {
      alive = false;
    };
  }, [seam, spaceId, open, tick]);

  return { lists, error, reload: () => setTick((n) => n + 1) };
}

function pusherName(members: readonly ActorSummary[], memberId: string | null): string | null {
  if (!memberId) return null;
  const actor = members.find((m) => m.id === memberId);
  if (!actor) return null;
  return actor.isAgent ? `${actor.displayName} (agent)` : actor.displayName;
}

function entryLabel(entry: StyleEntry): string {
  return entry.title ?? BUILTIN_STYLES[entry.ref]?.title ?? entry.ref;
}

interface RowProps {
  title: string;
  meta?: string | null;
  inUse: boolean;
  busy: boolean;
  onUse: () => void;
  children?: ReactNode;
  testId?: string;
}

function Row({ title, meta, inUse, busy, onUse, children, testId }: RowProps) {
  return (
    <li className="stylepick__item">
      <button
        type="button"
        className="stylepick__use"
        aria-pressed={inUse}
        disabled={busy}
        onClick={onUse}
        data-testid={testId}
      >
        <span className="stylepick__mark" aria-hidden>
          {inUse ? '●' : '○'}
        </span>
        <span className="stylepick__text">
          <span className="stylepick__title">{title}</span>
          {meta ? <span className="stylepick__meta">{meta}</span> : null}
        </span>
      </button>
      {children}
    </li>
  );
}

export function StylePicker({ seam, spaceId, members, variant = 'menu' }: StylePickerProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const style = useStyleState();
  const { lists, error: listError, reload } = useCatalogLists(seam, spaceId, open);

  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const use = useCallback((ref: StyleRef) => run(ref, () => chooseStyle(ref)), [run]);

  const prefs = knownStylePrefs();
  const trusted = useMemo(() => new Set(prefs?.trustedCss ?? []), [prefs]);
  const now = Date.now();
  const current = style.current;
  const inUse = (ref: string) => current.ref === ref;
  const spaceDefault = knownSpaceDefault();
  const listed = new Set<string>([...lists.mine.map((m) => m.ref), ...lists.space.map((s) => s.ref)]);
  const currentKind = parseStyleRef(current.ref)?.kind;
  const currentOrphan = currentKind !== 'builtin' && open && !listed.has(current.ref);

  /* Candidates for the follow-OS dark half: anything this picker can name. */
  const darkOptions: { ref: string; title: string }[] = [
    ...Object.values(BUILTIN_STYLES).map((b) => ({ ref: b.id as string, title: b.title })),
    ...lists.mine.map((m) => ({ ref: m.ref, title: m.title })),
    ...lists.space.map((s) => ({ ref: s.ref, title: s.title })),
  ];
  const darkRef = style.dark?.ref ?? BUILTIN_STYLE_IDS.dark;
  if (!darkOptions.some((o) => o.ref === darkRef) && style.dark) {
    darkOptions.push({ ref: darkRef, title: entryLabel(style.dark) });
  }

  const statusNote =
    current.status === 'removed'
      ? 'removed from the space — showing your saved copy'
      : current.status === 'detached'
        ? 'no longer readable — showing your saved copy'
        : null;

  return (
    <div className={`stylepick stylepick--${variant}`} data-testid="style-picker">
      <button
        type="button"
        className="stylepick__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="style-picker-toggle"
      >
        <span className="stylepick__caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        Styles
        <span className="stylepick__spacer" />
        <span className="stylepick__current">{entryLabel(current)}</span>
      </button>

      {open ? (
        <div className="stylepick__panel">
          {actionError || listError ? (
            <p className="stylepick__error" role="alert">
              {actionError ?? listError}
            </p>
          ) : null}
          {!stylePrefsWritable() ? (
            <p className="stylepick__note">This server does not store styles yet — choices stay on this device.</p>
          ) : null}

          {currentOrphan ? (
            <section className="stylepick__group" aria-label="current style">
              <ul className="stylepick__list">
                <Row title={entryLabel(current)} meta={statusNote} inUse busy={busy !== null} onUse={() => {}} />
              </ul>
            </section>
          ) : null}

          {lists.mine.length > 0 ? (
            <section className="stylepick__group" aria-label="my styles">
              <h4 className="stylepick__head">Mine</h4>
              <ul className="stylepick__list">
                {lists.mine.map((m) => {
                  const bits = [`edited ${relTime(m.updatedAt, now)}`];
                  if (m.publishedAs) bits.push('pushed to a space');
                  if (m.pulledFrom?.upstreamVersion && m.pulledFrom.upstreamVersion > m.pulledFrom.version) {
                    bits.push(`upstream v${m.pulledFrom.upstreamVersion} available`);
                  }
                  if (inUse(m.ref) && statusNote) bits.push(statusNote);
                  return (
                    <Row
                      key={m.id}
                      title={m.title}
                      meta={bits.join(' · ')}
                      inUse={inUse(m.ref)}
                      busy={busy !== null}
                      onUse={() => void use(m.ref as StyleRef)}
                    >
                      <span className="stylepick__actions">
                        <button
                          type="button"
                          className="stylepick__action"
                          disabled={busy !== null}
                          onClick={() => openStyleEditor({ kind: 'personal', id: m.id })}
                          data-testid={`style-edit-${m.id}`}
                        >
                          Edit
                        </button>
                      </span>
                    </Row>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {lists.space.length > 0 ? (
            <section className="stylepick__group" aria-label="space styles">
              <h4 className="stylepick__head">Space</h4>
              <ul className="stylepick__list">
                {lists.space.map((s) => {
                  const who = pusherName(members, s.pushedBy);
                  const bits = [`v${s.version}`];
                  if (who) bits.push(`pushed by ${who}`);
                  if (s.pushedAt) bits.push(relTime(s.pushedAt, now));
                  if (s.isDefault || spaceDefault?.defaultStyle === s.ref) bits.push('space default');
                  const cssBlocked = s.hasCss && !trusted.has(s.id);
                  if (s.hasCss) bits.push(cssBlocked ? 'contains custom CSS' : 'custom CSS allowed');
                  return (
                    <Row
                      key={s.id}
                      title={s.title}
                      meta={bits.join(' · ')}
                      inUse={inUse(s.ref)}
                      busy={busy !== null}
                      onUse={() => void use(s.ref as StyleRef)}
                      testId={`style-row-${s.id}`}
                    >
                      <span className="stylepick__actions">
                        <button
                          type="button"
                          className="stylepick__action"
                          disabled={busy !== null}
                          title="Variables, custom CSS and versions (read-only)"
                          onClick={() => openStyleEditor({ kind: 'space', id: s.id })}
                        >
                          View
                        </button>
                        {s.hasCss && stylePrefsWritable() ? (
                          <button
                            type="button"
                            className="stylepick__action"
                            disabled={busy !== null}
                            title={cssBlocked ? 'Run this style’s custom CSS for you' : 'Stop running its custom CSS'}
                            onClick={() =>
                              void run(`trust:${s.id}`, () => setStyleCssTrust(s.id, cssBlocked))
                            }
                          >
                            {cssBlocked ? 'Allow' : 'Revoke'}
                          </button>
                        ) : null}
                        {seam?.pullStyle ? (
                          <button
                            type="button"
                            className="stylepick__action"
                            disabled={busy !== null}
                            title="Copy into a personal style you can edit"
                            onClick={() =>
                              void run(`pull:${s.id}`, async () => {
                                await seam.pullStyle!(s.ref);
                                reload();
                              })
                            }
                          >
                            Pull
                          </button>
                        ) : null}
                      </span>
                    </Row>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section className="stylepick__group" aria-label="built-in styles">
            <h4 className="stylepick__head">Built-in</h4>
            <ul className="stylepick__list">
              {Object.values(BUILTIN_STYLES).map((b) => (
                <Row
                  key={b.id}
                  title={b.title}
                  inUse={inUse(b.id)}
                  busy={busy !== null}
                  onUse={() => void use(b.id)}
                />
              ))}
            </ul>
          </section>

          <section className="stylepick__group stylepick__group--foot" aria-label="follow the OS">
            <label className="stylepick__follow">
              <input
                type="checkbox"
                checked={style.followOs && !!style.dark}
                disabled={busy !== null}
                onChange={(e) => void run('follow', () => setStyleFollowOs(e.target.checked))}
              />
              Follow OS: use
              <select
                className="stylepick__select"
                value={darkRef}
                disabled={busy !== null}
                aria-label="style when the OS is dark"
                onChange={(e) => void run('follow', () => setStyleFollowOs(true, e.target.value as StyleRef))}
              >
                {darkOptions.map((o) => (
                  <option key={o.ref} value={o.ref}>
                    {o.title}
                  </option>
                ))}
              </select>
              when dark
            </label>
            {seam?.createPersonalStyle ? (
              <span className="stylepick__create">
                <button
                  type="button"
                  className="stylepick__action"
                  disabled={busy !== null}
                  title="A personal copy of the built-in closest to what you see now"
                  onClick={() =>
                    void run('new', async () => {
                      const from = style.active.darkish ? BUILTIN_STYLE_IDS.dark : BUILTIN_STYLE_IDS.light;
                      const res = await seam.createPersonalStyle!({ from, title: 'New style' });
                      reload();
                      openStyleEditor({ kind: 'personal', id: res.style.id }, res.warnings);
                    })
                  }
                  data-testid="style-new"
                >
                  New style…
                </button>
                <button
                  type="button"
                  className="stylepick__action"
                  disabled={busy !== null}
                  title="A .tm8style.json or an exported .css file"
                  onClick={() =>
                    void run('import', async () => {
                      const file = await pickStyleFile();
                      if (!file) return;
                      const imported = importStyle(file.text);
                      const res = await seam.createPersonalStyle!({
                        title: titleFromFileName(file.name),
                        foundation: imported.doc.foundation,
                        vars: imported.doc.vars,
                        css: imported.doc.css,
                      });
                      reload();
                      openStyleEditor({ kind: 'personal', id: res.style.id }, [...imported.warnings, ...res.warnings]);
                    })
                  }
                  data-testid="style-import"
                >
                  Import…
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="stylepick__reset"
              disabled={busy !== null}
              onClick={() => void use(BUILTIN_STYLE_IDS.light)}
              data-testid="style-reset"
            >
              Reset to {BUILTIN_STYLES[BUILTIN_STYLE_IDS.light]?.title ?? 'Atelier Light'}
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
