import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type { LaunchContextRow } from '../domain/launch-selection';
import { Caret, LaunchCardShell, useLaunchCardMenu, type LaunchCardShellProps } from './LaunchCard';
import {
  IN_FULL_KINDS,
  NOT_IN_FULL_REASON,
  STRIP_KIND,
  STRIP_KINDS,
  stripChipTitle,
  type StripGroup,
  type StripKind,
  type StripRow,
} from './launch-strip';
import './launch-card-v3.css';

/**
 * THE LAUNCH CARD v3 (mock 01a0df08 rev 9; decisions 01a0df08-4fa0 and the
 * revisions after it on task 01a0dee8). The same shell as v2 — both bands'
 * pickers, the advanced drawer, the keyboard — around a new center:
 *
 *   TOP BAND   RUN / COORDINATE / DISPATCH — the KIND of session — then the
 *              v2 pickers.
 *   TITLE ROW  one line: [+] · the task (pinned) · entities sent IN FULL,
 *              scrolling sideways with "‹ N" / "+N more ›".
 *   NOTES      this launch only (`promptExtra`); never saved onto the task.
 *   STRIP      [📎 Attach] · type groups, files first · ✦ at the far right.
 *   BOTTOM     model · effort · access · Dispatch · Launch — in every mode.
 *
 * The card is a LAYER over the task: its title and description are read here
 * and edited on the task, never on the card.
 *
 * PROPS-ONLY like v2. Where the node can't do something yet, the control is
 * drawn and says why (`inFull.refusal`, `dispatch.refusal`, `jev.reason`) —
 * nothing is faked.
 */

export type LaunchVerb = 'worker' | 'coordinator' | 'dispatcher';

export const VERBS: readonly { id: LaunchVerb; badge: string; label: string; desc: string }[] = [
  { id: 'worker', badge: 'RUN', label: 'Run', desc: 'A worker — works the task itself.' },
  { id: 'coordinator', badge: 'COORDINATE', label: 'Coordinate', desc: 'A coordinator — spawns and directs its own workers.' },
  { id: 'dispatcher', badge: 'DISPATCH', label: 'Dispatch', desc: 'A dispatcher — routes work to teammates, never does it itself.' },
];

/** "a worker", "a coordinator", "a dispatcher". */
export function aKind(verb: LaunchVerb): string {
  return `a ${verb}`;
}

/** One entity sent in full on the title row. */
export interface InFullItem {
  id: string;
  kind: string;
  title: string;
  /** Bytes it adds whole; null: the node didn't say. */
  bytes: number | null;
  /** This chip is what pushes the row over its budget. */
  over: boolean;
}

/** Something the + or Attach search may offer. */
export interface LaunchCandidate {
  row: LaunchContextRow;
  kind: StripKind;
  /** Already in the launch — ticked in the strip or sent in full. */
  inLaunch: 'strip' | 'full' | null;
  /** Why it can't be added yet (teammates: no `selection.teammateIds`). */
  unsent?: string;
}

export interface LaunchUploadChip {
  key: string;
  name: string;
  status: 'uploading' | 'failed';
  error?: string;
}

export interface JevButton {
  /**
   * off: greyed with `reason`; ready: in colour; stale: ranked for another
   * teammate — ask again; busy: spinning; done: filled, opens the menu.
   */
  status: 'off' | 'ready' | 'stale' | 'busy' | 'done';
  reason: string | null;
  /** After a run: rows Jev ticked, and defaults it left out. */
  picked: number;
  leftOut: number;
  /** "a model": a suggestion waiting in its menu; null when none. */
  suggests: string | null;
  /** The teammate Jev applied (Undo reverts it); null when it didn't change it. */
  teammate: string | null;
  /** Other teammates Jev ranked for the context index — not sendable yet. */
  otherTeammates: number;
  /** The last run's cost, e.g. "1 call · $0.0004"; null before one. */
  cost: string | null;
  /** Groups that failed on the last ask, with Retry. */
  failures: readonly { group: string; reason: string; onRetry(): void }[];
  onAsk(): void;
  onAskAgain(): void;
  onUndo(): void;
  /** A greyed ✦ for a missing key: where the key is added. */
  onFixKey?(): void;
}

/** A dispatcher session in this space, as the card shows it. */
export interface DispatcherRow {
  id: string;
  name: string;
  /** What it is for — its session title. */
  title: string;
  alive: boolean;
  /** "idle", "2 queued", "stopped yesterday". */
  status: string;
  /** Why this row can't be picked while it is alive; null when it can. */
  unpickable: string | null;
}

export interface DispatchControl {
  /** Why Dispatch can't be pressed at all; null when it can. */
  refusal: string | null;
  /** The space's dispatchers; null: the node doesn't report them to the card. */
  dispatchers: readonly DispatcherRow[] | null;
  /** Opens the dispatch preview, aimed at a dispatcher (null: the node picks). */
  onDispatch(targetId: string | null): void;
}

export interface LaunchCardV3Props extends LaunchCardShellProps {
  connectors?: ReactNode;
  verb: LaunchVerb;
  onVerbChange(next: LaunchVerb): void;

  /* ---- title row ---- */
  subject: { title: string; kind?: string };
  /** True for a session subject: continued, never edited (migration 200). */
  continuing: boolean;
  /** The task's description for the read-only peek; null while it is read. */
  description: string | null;
  /** "Edit on the task ↗": the card closes onto the task underneath. */
  onEditSubject?(): void;
  inFull: {
    items: readonly InFullItem[];
    /** Why nothing can be sent in full yet; the + and every "↑ in full" say it. */
    refusal: string | null;
    onAdd(row: LaunchContextRow): void;
    onRemove(id: string): void;
    onToIndex(id: string): void;
  };

  /* ---- notes ---- */
  notes: string;
  onNotesChange(next: string): void;
  notesPlaceholder: string;

  /* ---- the strip ---- */
  strip: readonly StripGroup[];
  /** Why the strip can't be edited (defaults unread, a locked group); null when it can. */
  stripRefusal: string | null;
  /** The strip's defaults are still being read. */
  stripLoading: boolean;
  onTick(row: StripRow): void;
  /** Adds several rows at once, each to its group; returns a refusal or null. */
  onAddRows(rows: readonly LaunchContextRow[]): string | null;
  /** Everything the + and Attach searches offer; undefined: never read into this client. */
  candidates: readonly LaunchCandidate[] | undefined;
  /** The Attach menu opened: a host may read its pool in now. */
  onAttachOpen?(): void;
  uploads: readonly LaunchUploadChip[];
  onDismissUpload(key: string): void;
  /** A failed upload tried again. */
  onRetryUpload(key: string): void;
  jev: JevButton;

  /* ---- bottom band ---- */
  dispatch: DispatchControl | null;
  /** Launch: opens the "What the agent gets" preview. */
  onLaunch(): void;
  /** An open preview, drawn over the card. */
  preview: ReactNode;
  /** Escape: closes the preview; returns whether one was open. */
  onClosePreview(): boolean;
  /** The node fixes the access mode for this verb, and why. */
  accessLock: string | null;
}

const NO_UPLOAD_REASON = 'This surface has no upload path, so files cannot be attached here.';

export function LaunchCardV3(props: LaunchCardV3Props) {
  const { verb, onVerbChange, preview, onClosePreview } = props;
  return (
    <LaunchCardShell
      {...props}
      className="lcd--v3"
      onSubmit={props.onLaunch}
      onEscapeFirst={onClosePreview}
      trapFocus
      overlay={preview}
      verb={<VerbSwitch verb={verb} onChange={onVerbChange} />}
      center={(
        <div className="lcd-center lcd3-center">
          <TitleRow {...props} />
          <textarea
            className="lcd-instr lcd3-notes"
            data-testid="lcd3-notes"
            value={props.notes}
            aria-label="Notes for this launch"
            aria-describedby={props.refusal || props.notice ? 'lcd-refusal' : undefined}
            disabled={props.busy}
            autoFocus
            placeholder={props.notesPlaceholder}
            onChange={(event) => props.onNotesChange(event.target.value)}
          />
          {props.connectors && <div className="mcp-launch-slot">{props.connectors}</div>}
          <Strip {...props} />
        </div>
      )}
      actions={<Actions {...props} />}
    />
  );
}

/* ================================================================ verb */

function VerbSwitch({ verb, onChange }: { verb: LaunchVerb; onChange(next: LaunchVerb): void }) {
  const { open, toggle, close, menuProps, stop } = useLaunchCardMenu();
  const current = VERBS.find((v) => v.id === verb) ?? VERBS[0]!;
  return (
    <div className="lcd-anchor">
      <button
        type="button"
        className={`lcd3-verb lcd3-verb--${current.id}`}
        data-testid="lcd-verb"
        aria-haspopup="menu"
        aria-expanded={open === 'verb'}
        title={`${current.desc} · click to change`}
        onClick={stop(() => toggle('verb'))}
      >
        {current.badge} <Caret />
      </button>
      {open === 'verb' ? (
        <div {...menuProps('verb', 'lcd-menu--down lcd3-verbmenu')} role="menu" data-testid="lcd-verb-menu">
          {VERBS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitemradio"
              aria-checked={v.id === verb}
              className="lcd-mi"
              data-testid={`lcd-verb-${v.id}`}
              onClick={stop(() => { onChange(v.id); close(); })}
            >
              <span className={`lcd3-verb lcd3-verb--${v.id} lcd3-verb--sm`}>{v.badge}</span>
              <span className="lcd-mi__body">{v.label}<span className="lcd-mi__sub lcd3-wrap">{v.desc}</span></span>
              <span className="lcd-ck" aria-hidden="true">{v.id === verb ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ====================================================== search + type */

interface TypeOption { kind: StripKind; count: number }

/**
 * THE SEARCH BOX WITH ITS TYPE FILTER (rev 3, reused by Attach in rev 9):
 * "All ▾" sits at the input's right end; opening it REPLACES the results with
 * the type list, and picking a type puts the results back, filtered, with the
 * search running inside that type.
 */
function useTypedSearch() {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<StripKind | 'all'>('all');
  const [typeOpen, setTypeOpen] = useState(false);
  const reset = useCallback(() => { setQuery(''); setType('all'); setTypeOpen(false); }, []);
  return { query, setQuery, type, setType, typeOpen, setTypeOpen, reset };
}

type TypedSearch = ReturnType<typeof useTypedSearch>;

const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function SearchBox({ search, types, testId, allPlaceholder }: {
  search: TypedSearch;
  types: readonly TypeOption[];
  testId: string;
  allPlaceholder: string;
}) {
  const { stop } = useLaunchCardMenu();
  const label = search.type === 'all' ? 'All' : cap(STRIP_KIND[search.type].many);
  return (
    <>
      <div className="lcd3-searchbox">
        <input
          className="lcd-search"
          data-testid={`${testId}-search`}
          aria-label={allPlaceholder}
          placeholder={search.type === 'all' ? allPlaceholder : `Search ${STRIP_KIND[search.type].many}…`}
          value={search.query}
          autoFocus
          onChange={(event) => search.setQuery(event.target.value)}
        />
        <button
          type="button"
          className="lcd3-typebtn"
          data-testid={`${testId}-type`}
          data-on={search.type !== 'all' || undefined}
          aria-expanded={search.typeOpen}
          title="Filter by type"
          onClick={stop(() => search.setTypeOpen(!search.typeOpen))}
        >
          {label} <Caret up={search.typeOpen} />
        </button>
      </div>
      {search.typeOpen ? (
        <div className="lcd3-list" role="listbox" aria-label="Types" data-testid={`${testId}-types`}>
          {[{ kind: 'all' as const, count: -1 }, ...types].map((t) => (
            <button
              key={t.kind}
              type="button"
              role="option"
              aria-selected={t.kind === search.type}
              className="lcd-mi"
              data-testid={`${testId}-type-${t.kind}`}
              onClick={stop(() => { search.setType(t.kind); search.setTypeOpen(false); })}
            >
              <span className="lcd-kind" aria-hidden="true">{t.kind === 'all' ? '•' : STRIP_KIND[t.kind].glyph}</span>
              <span className="lcd-mi__body lcd-mi__body--plain">{t.kind === 'all' ? 'All' : cap(STRIP_KIND[t.kind].many)}</span>
              <span className="lcd-mi__r">{t.count >= 0 ? t.count : ''}{t.kind === search.type ? ' ✓' : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function filterCandidates(pool: readonly LaunchCandidate[], search: TypedSearch, kinds: readonly StripKind[]) {
  const needle = search.query.trim().toLowerCase();
  return pool.filter((c) => kinds.includes(c.kind)
    && (search.type === 'all' || c.kind === search.type)
    && (!needle || c.row.title.toLowerCase().includes(needle)));
}

function typeCounts(pool: readonly LaunchCandidate[], kinds: readonly StripKind[]): TypeOption[] {
  return kinds.map((kind) => ({ kind, count: pool.filter((c) => c.kind === kind).length }));
}

/* ========================================================== title row */

/** "‹ N" / "+N more ›" for a sideways-scrolling lane, from layout offsets (zoom-proof). */
function useLaneCounts(lane: React.RefObject<HTMLDivElement | null>, deps: readonly unknown[]) {
  const [counts, setCounts] = useState({ left: 0, right: 0 });
  const sync = useCallback(() => {
    const l = lane.current;
    if (!l) return;
    const kids = [...l.children] as HTMLElement[];
    const right = kids.filter((c) => c.offsetLeft + c.offsetWidth > l.scrollLeft + l.clientWidth + 1).length;
    const left = kids.filter((c) => c.offsetLeft < l.scrollLeft - 1).length;
    setCounts((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, [lane]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(sync, [sync, ...deps]);
  useEffect(() => {
    const l = lane.current;
    if (!l || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(l);
    return () => observer.disconnect();
  }, [lane, sync]);
  return { ...counts, sync };
}

/**
 * A menu for an item inside a scrolling lane opens OUTSIDE the lane (the lane
 * clips), placed under or over its item by layout offsets — CSS pixels in the
 * card's own space, so `.cv2-root`'s zoom can't skew it. The wrapper is the
 * menu's anchor, so the shell's fit-inside still works on it.
 */
function FloatAnchor({ lane, itemId, children, up }: {
  lane: React.RefObject<HTMLDivElement | null>;
  itemId: string;
  children: ReactNode;
  up?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const l = lane.current;
    const el = ref.current;
    const item = l ? ([...l.children] as HTMLElement[]).find((c) => c.dataset.item === itemId) : undefined;
    if (!l || !el || !item) return;
    el.style.left = `${String(l.offsetLeft + item.offsetLeft - l.scrollLeft)}px`;
    el.style.top = up ? `${String(l.offsetTop)}px` : `${String(l.offsetTop + item.offsetTop + item.offsetHeight)}px`;
  }, [lane, itemId, up]);
  return <div ref={ref} className="lcd3-float">{children}</div>;
}

function TitleRow(props: LaunchCardV3Props) {
  const { subject, continuing, description, onEditSubject, inFull, candidates } = props;
  const { open, toggle, close, menuProps, stop } = useLaunchCardMenu();
  const lane = useRef<HTMLDivElement | null>(null);
  const counts = useLaneCounts(lane, [inFull.items]);
  const search = useTypedSearch();
  const openChip = open?.startsWith('full:') ? open.slice(5) : null;
  const chip = openChip ? inFull.items.find((i) => i.id === openChip) ?? null : null;

  const pool = (candidates ?? []).filter((c) => c.inLaunch !== 'full');
  const shown = filterCandidates(pool, search, IN_FULL_KINDS);

  return (
    <div className="lcd3-titlerow" onClick={(event) => event.stopPropagation()}>
      <div className="lcd3-titleline">
        <div className="lcd-anchor">
          <button
            type="button"
            className="lcd3-addfull"
            data-testid="lcd3-add-full"
            aria-haspopup="menu"
            aria-expanded={open === 'fulladd'}
            aria-disabled={Boolean(inFull.refusal) || undefined}
            title={inFull.refusal ?? 'Add something to send in full'}
            onClick={stop(() => { search.reset(); toggle('fulladd'); })}
          >
            +
          </button>
          {open === 'fulladd' ? (
            <div {...menuProps('fulladd', 'lcd-menu--down lcd3-menu')} role="menu" data-testid="lcd3-full-menu">
              {inFull.refusal ? <div className="lcd-note lcd3-refused" role="status">{inFull.refusal}</div> : null}
              <SearchBox search={search} types={typeCounts(pool, IN_FULL_KINDS)} testId="lcd3-full" allPlaceholder="Search tasks, docs, memories, skills…" />
              {search.typeOpen ? null : (
                <div className="lcd3-list">
                  {candidates === undefined ? (
                    <div className="lcd-note" role="status">Nothing has been read into this client to offer. This is unknown, not empty.</div>
                  ) : shown.length === 0 ? (
                    <div className="lcd-note">{search.query.trim() ? `Nothing matches “${search.query.trim()}”.` : 'Nothing left to add.'}</div>
                  ) : shown.slice(0, 60).map((c) => (
                    <button
                      key={c.row.id}
                      type="button"
                      role="menuitem"
                      className="lcd-mi"
                      aria-disabled={Boolean(inFull.refusal) || undefined}
                      data-testid={`lcd3-full-add-${c.row.id}`}
                      onClick={stop(() => { if (!inFull.refusal) { inFull.onAdd(c.row); close(); } })}
                    >
                      <span className="lcd-kind" aria-hidden="true">{STRIP_KIND[c.kind].glyph}</span>
                      <span className="lcd-mi__body lcd-mi__body--plain">{c.row.title}</span>
                      <span className="lcd-mi__r">{c.inLaunch === 'strip' ? 'moves up from the strip' : STRIP_KIND[c.kind].one}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="lcd-foot">Sent in full, read only. Files, artifacts and drawings can’t be inlined — they stay in the strip.</div>
            </div>
          ) : null}
        </div>

        <div className="lcd-anchor lcd3-subject-slot">
          <button
            type="button"
            className="lcd3-subject"
            data-testid="lcd3-subject"
            aria-haspopup="dialog"
            aria-expanded={open === 'subject'}
            title={continuing ? 'The session this launch continues' : 'The task this session works on — sent in full'}
            onClick={stop(() => toggle('subject'))}
          >
            <span className="lcd3-subject__k" aria-hidden="true">{continuing ? '◉' : '▣'}</span>
            <span className="lcd3-subject__t">{subject.title}</span>
            <Caret />
          </button>
          {open === 'subject' ? (
            <div
              {...menuProps('subject', 'lcd-menu--down lcd3-peek')}
              role="dialog"
              aria-label={continuing ? 'The session being continued' : 'Task description'}
              data-testid="lcd3-subject-peek"
            >
              {continuing ? (
                <div className="lcd-foot">
                  This launch continues “{subject.title}”: the new session reads its transcript first. Nothing here is loaded
                  from it or saved onto it — your notes are for the new session.
                </div>
              ) : (
                <>
                  <div className="lcd-grp">Task description <span>read-only here · sent in full</span></div>
                  <p className="lcd3-peek__body" data-testid="lcd3-description">
                    {description === null ? 'Reading the task…' : description.trim() || 'No description yet.'}
                  </p>
                  {onEditSubject ? (
                    <button type="button" className="lcd3-link" data-testid="lcd3-edit-subject" onClick={stop(onEditSubject)}>
                      Edit on the task ↗
                    </button>
                  ) : <div className="lcd-foot">The task is edited on the task itself, never on this card.</div>}
                </>
              )}
            </div>
          ) : null}
        </div>

        {counts.left > 0 ? (
          <button
            type="button"
            className="lcd-more"
            data-testid="lcd3-full-less"
            title="Show the earlier ones"
            onClick={stop(() => lane.current?.scrollTo({ left: 0, behavior: 'smooth' }))}
          >
            ‹ {counts.left}
          </button>
        ) : null}
        <div
          className="lcd3-lane"
          ref={lane}
          onScroll={counts.sync}
          data-more={counts.right > 0 || undefined}
          data-less={counts.left > 0 || undefined}
          data-testid="lcd3-full-lane"
        >
          {inFull.items.map((item) => {
            const kind = STRIP_KIND[item.kind as StripKind] ?? STRIP_KIND.doc;
            return (
              <button
                key={item.id}
                type="button"
                className="lcd3-fullchip"
                data-item={item.id}
                data-over={item.over || undefined}
                data-testid={`lcd3-full-chip-${item.id}`}
                aria-expanded={openChip === item.id}
                title={item.over ? 'Over the in-full budget — move it to the index' : 'Sent in full · click for options'}
                onClick={stop(() => toggle(`full:${item.id}`))}
              >
                <span className="lcd-kind" aria-hidden="true">{kind.glyph}</span>
                <span className="lcd3-fullchip__t">{item.title}</span>
                {item.bytes !== null ? <span className="lcd3-fullchip__kb">{kb(item.bytes)}</span> : null}
              </button>
            );
          })}
        </div>
        {counts.right > 0 ? (
          <button
            type="button"
            className="lcd-more"
            data-testid="lcd3-full-more"
            title="Show the rest"
            onClick={stop(() => lane.current?.scrollTo({ left: lane.current.scrollWidth, behavior: 'smooth' }))}
          >
            +{counts.right} more ›
          </button>
        ) : null}
      </div>
      {chip ? (
        <FloatAnchor lane={lane} itemId={chip.id}>
          <div {...menuProps(`full:${chip.id}`, 'lcd-menu--down lcd-menu--narrow')} role="menu" data-testid="lcd3-full-chip-menu">
            <button type="button" role="menuitem" className="lcd-mi" data-testid="lcd3-to-index" onClick={stop(() => { inFull.onToIndex(chip.id); close(); })}>
              <span className="lcd-mi__body lcd-mi__body--plain">↓ Move to index</span>
            </button>
            <button type="button" role="menuitem" className="lcd-mi" data-testid="lcd3-unfull" onClick={stop(() => { inFull.onRemove(chip.id); close(); })}>
              <span className="lcd-mi__body lcd-mi__body--plain">Remove from this launch</span>
            </button>
          </div>
        </FloatAnchor>
      ) : null}
    </div>
  );
}

/* ============================================================== strip */

function Strip(props: LaunchCardV3Props) {
  const { strip, stripRefusal, stripLoading, candidates, onAddRows, onAttachOpen, onFiles, uploads, onDismissUpload, onRetryUpload, jev } = props;
  const { open, toggle, close, menuProps, stop } = useLaunchCardMenu();
  const lane = useRef<HTMLDivElement | null>(null);
  const counts = useLaneCounts(lane, [strip, uploads]);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const search = useTypedSearch();
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const openGroup = open?.startsWith('group:') ? open.slice(6) as StripKind : null;
  const group = openGroup ? strip.find((g) => g.def.kind === openGroup) ?? null : null;

  const pool = candidates ?? [];
  /* Under DISPATCH a dispatcher gets the whole roster, so Attach offers no
     Teammates type at all (coordinator ruling, mock rev 18). */
  const allKinds = STRIP_KINDS.map((d) => d.kind).filter((k) => !(k === 'teammate' && props.verb === 'dispatcher'));
  const shown = filterCandidates(pool, search, allKinds);

  const addPicked = () => {
    const rows = pool.filter((c) => picked.includes(c.row.id)).map((c) => c.row);
    if (rows.length === 0) return;
    const refused = onAddRows(rows);
    setNotice(refused);
    if (!refused) { setPicked([]); close(); }
  };

  return (
    <div className="lcd3-strip" aria-label="Context for this launch" onClick={(event) => event.stopPropagation()}>
      <div className="lcd-anchor">
        <button
          type="button"
          className="lcd-attbtn lcd3-attach"
          data-testid="lcd3-attach"
          aria-haspopup="menu"
          aria-expanded={open === 'attach'}
          title="Attach files or anything in this space"
          onClick={stop(() => {
            search.reset();
            setPicked([]);
            setNotice(null);
            if (open !== 'attach') onAttachOpen?.();
            toggle('attach');
          })}
        >
          📎<span className="lcd-attbtn__label"> Attach</span> <Caret up />
        </button>
        {open === 'attach' ? (
          <div {...menuProps('attach', 'lcd-menu--up lcd-menu--wide lcd3-menu')} role="menu" data-testid="lcd3-attach-menu">
            <SearchBox search={search} types={typeCounts(pool, allKinds)} testId="lcd3-attach" allPlaceholder="Search files, memories, skills, tasks, docs…" />
            {search.typeOpen ? (
              picked.length ? <div className="lcd-foot">{picked.length} selected — kept while you switch type</div> : null
            ) : (
              <>
                {search.type === 'all' || search.type === 'file' ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="lcd-mi"
                    data-testid="lcd3-attach-files"
                    aria-disabled={!onFiles || undefined}
                    title={onFiles ? undefined : NO_UPLOAD_REASON}
                    onClick={stop(() => { if (onFiles) fileInput.current?.click(); })}
                  >
                    <span className="lcd-ck" aria-hidden="true">⤒</span>
                    <span className="lcd-mi__body">
                      Files from this computer…
                      <span className={onFiles ? 'lcd-mi__sub' : 'lcd-mi__why'}>{onFiles ? 'or drop them anywhere on the card' : NO_UPLOAD_REASON}</span>
                    </span>
                  </button>
                ) : null}
                {stripRefusal ? <div className="lcd-note lcd3-refused" role="status">{stripRefusal}</div> : null}
                <div className="lcd3-list">
                  {candidates === undefined ? (
                    <div className="lcd-note" role="status">
                      Nothing attachable has been read into this client, so none can be offered. This is unknown, not empty.
                    </div>
                  ) : shown.length === 0 ? (
                    <div className="lcd-note">{search.query.trim() ? `Nothing matches “${search.query.trim()}”.` : 'Nothing in this space to attach.'}</div>
                  ) : shown.slice(0, 80).map((c) => {
                    const on = picked.includes(c.row.id);
                    return (
                      <button
                        key={c.row.id}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={Boolean(c.inLaunch) || on}
                        aria-disabled={Boolean(c.inLaunch) || Boolean(stripRefusal) || Boolean(c.unsent) || undefined}
                        className="lcd-mi"
                        data-testid={`lcd3-attach-row-${c.row.id}`}
                        title={c.inLaunch ? 'Already in this launch' : c.unsent}
                        onClick={stop(() => {
                          if (c.inLaunch || stripRefusal) return;
                          if (c.unsent) { setNotice(c.unsent); return; }
                          setPicked((now) => (now.includes(c.row.id) ? now.filter((id) => id !== c.row.id) : [...now, c.row.id]));
                        })}
                      >
                        <span className="lcd3-box" data-on={Boolean(c.inLaunch) || on || undefined} aria-hidden="true">{c.inLaunch || on ? '✓' : ''}</span>
                        <span className="lcd-kind" aria-hidden="true">{STRIP_KIND[c.kind].glyph}</span>
                        <span className="lcd-mi__body lcd-mi__body--plain">{c.row.title}</span>
                        <span className="lcd-mi__r">{c.inLaunch === 'full' ? 'in full' : c.inLaunch ? 'in launch' : c.unsent ? 'not sent yet' : STRIP_KIND[c.kind].one}</span>
                      </button>
                    );
                  })}
                </div>
                {notice ? <div className="lcd-note lcd3-refused" role="status">{notice}</div> : null}
                <div className="lcd-foot">
                  <span>{picked.length ? `${String(picked.length)} selected` : 'Tick several — each lands in its group'}</span>
                  <span className="lcd-spacer" />
                  <button
                    type="button"
                    className="lcd-btn lcd-btn--go lcd3-small"
                    data-testid="lcd3-attach-add"
                    aria-disabled={picked.length === 0}
                    onClick={stop(addPicked)}
                  >
                    Add{picked.length ? ` ${String(picked.length)}` : ''}
                  </button>
                </div>
                <div className="lcd-note">The task itself never appears here. Sessions can’t be attached.</div>
              </>
            )}
          </div>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="lcd3-file-input"
          onChange={(event) => {
            const list = event.target.files;
            if (list && list.length && onFiles) onFiles([...list]);
            event.target.value = '';
            close();
          }}
        />
      </div>

      <div className="lcd3-lane lcd3-lane--strip" ref={lane} onScroll={counts.sync} data-more={counts.right > 0 || undefined} data-testid="lcd3-strip">
        {uploads.map((u) => (
          <span
            key={u.key}
            className="lcd3-grp lcd3-grp--upload"
            data-item={u.key}
            data-status={u.status}
            data-testid={`lcd3-upload-${u.key}`}
            title={u.status === 'failed' ? `Upload failed: ${u.error ?? 'no reason given'}` : `Uploading ${u.name} — Launch waits for it`}
          >
            <span className="lcd-kind" aria-hidden="true">⎘</span>
            <span className="lcd3-grp__name">{u.name}</span>
            {u.status === 'uploading' ? <span className="lcd3-grp__meta">uploading…</span> : (
              <>
                <span className="lcd3-grp__meta lcd3-grp__meta--bad">failed</span>
                <button type="button" className="lcd3-mini" data-testid={`lcd3-upload-retry-${u.key}`} aria-label={`Retry ${u.name}`} onClick={stop(() => onRetryUpload(u.key))}>↻</button>
              </>
            )}
            <button type="button" className="lcd3-mini" data-testid={`lcd3-upload-remove-${u.key}`} aria-label={`Remove ${u.name}`} onClick={stop(() => onDismissUpload(u.key))}>×</button>
          </span>
        ))}
        {strip.map((g) => (
          <button
            key={g.def.kind}
            type="button"
            className="lcd3-grp"
            data-item={g.def.kind}
            data-edited={g.edited || undefined}
            data-jev={(!g.edited && g.jev > 0) || undefined}
            data-unsent={g.rows.some((r) => r.unsent) || undefined}
            data-testid={`lcd3-group-${g.def.kind}`}
            aria-expanded={openGroup === g.def.kind}
            title={stripChipTitle(g)}
            onClick={stop(() => toggle(`group:${g.def.kind}`))}
          >
            <span className="lcd-kind" aria-hidden="true">{g.def.glyph}</span>
            {g.yours ? <b>{g.yours}</b> : null}
            {g.jev ? <span className="lcd3-jevn">✦ {g.jev}</span> : null}
            {' '}{g.yours + g.jev === 1 ? g.def.one : g.def.many}
            <Caret up />
          </button>
        ))}
        {strip.length === 0 && uploads.length === 0 ? (
          <span className="lcd-empty" data-testid="lcd3-strip-empty">
            {stripLoading ? 'Reading what this launch starts with…' : 'Nothing attached — Attach, drop files, or ✦'}
          </span>
        ) : null}
      </div>
      {counts.right > 0 ? (
        <button
          type="button"
          className="lcd-more"
          data-testid="lcd3-strip-more"
          title="Show the rest"
          onClick={stop(() => lane.current?.scrollTo({ left: lane.current.scrollWidth, behavior: 'smooth' }))}
        >
          +{counts.right} more ›
        </button>
      ) : null}
      {group ? (
        <FloatAnchor lane={lane} itemId={group.def.kind} up>
          <GroupMenu {...props} group={group} menuProps={menuProps('group', 'lcd-menu--up lcd-menu--wide lcd3-menu')} />
        </FloatAnchor>
      ) : null}
      <JevControl jev={jev} />
    </div>
  );
}

function GroupMenu(props: LaunchCardV3Props & { group: StripGroup; menuProps: ReturnType<ReturnType<typeof useLaunchCardMenu>['menuProps']> }) {
  const { group, menuProps, candidates, onTick, onAddRows, stripRefusal, inFull, onFiles } = props;
  const { stop } = useLaunchCardMenu();
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const kind = group.def.kind;
  const ticked = group.rows.filter((r) => r.ticked).length;
  const known = new Set(group.rows.map((r) => r.id));
  const needle = query.trim().toLowerCase();
  const addable = (candidates ?? []).filter((c) => c.kind === kind && !c.inLaunch && !known.has(c.row.id)
    && (!needle || c.row.title.toLowerCase().includes(needle)));
  const fullWhy = NOT_IN_FULL_REASON[kind] ?? inFull.refusal;

  return (
    <div {...menuProps} role="menu" data-testid="lcd3-group-menu">
      <div className="lcd-grp">
        {group.def.many} · {ticked}
        <span>{kind === 'file' ? 'go in as file references' : kind === 'teammate' ? 'roster entries the agent can ask' : 'go in as context index entries'}</span>
      </div>
      {stripRefusal ? <div className="lcd-note lcd3-refused" role="status">{stripRefusal}</div> : null}
      {group.rows[0]?.unsent ? <div className="lcd-note lcd3-refused" role="status" data-testid="lcd3-group-unsent">{group.rows[0].unsent}</div> : null}
      <div className="lcd3-list">
        {group.rows.map((r) => (
          <div key={r.id} className="lcd-mi lcd3-row" data-testid={`lcd3-row-${r.id}`}>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={r.ticked}
              aria-disabled={Boolean(stripRefusal) || undefined}
              className="lcd3-rowtick"
              title={r.jevWhy ? `Jev: ${r.jevWhy}` : undefined}
              onClick={stop(() => { if (!stripRefusal) onTick(r); })}
            >
              <span className="lcd3-box" data-on={r.ticked || undefined} aria-hidden="true">{r.ticked ? '✓' : ''}</span>
              <span className="lcd-mi__body lcd-mi__body--plain" data-off={!r.ticked || undefined}>{r.title}</span>
            </button>
            <SourceTag row={r} />
            <button
              type="button"
              className="lcd3-rowact"
              data-testid={`lcd3-row-full-${r.id}`}
              aria-disabled={Boolean(fullWhy) || undefined}
              title={fullWhy ?? 'Send in full'}
              onClick={stop(() => {
                if (fullWhy) { setNotice(fullWhy); return; }
                inFull.onAdd({ id: r.id, kind: r.kind, title: r.title, text: null, derived: false, via: null });
              })}
            >
              ↑ in full
            </button>
          </div>
        ))}
      </div>
      {notice ? <div className="lcd-note lcd3-refused" role="status">{notice}</div> : null}
      <div className="lcd3-groupfoot">
        {kind === 'file' ? (
          <div className="lcd-note">{onFiles ? 'Drop files anywhere on the card, or use 📎 Attach → Files from this computer.' : NO_UPLOAD_REASON}</div>
        ) : null}
        <input
          className="lcd-search"
          data-testid="lcd3-group-add"
          aria-label={`Add ${group.def.one}`}
          placeholder={`+ Add ${group.def.one}…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {candidates === undefined ? (
          <div className="lcd-note">Nothing has been read into this client to add. This is unknown, not empty.</div>
        ) : addable.length === 0 ? (
          <div className="lcd-note">No other {group.def.many}{needle ? ' match' : ' in this space'}.</div>
        ) : addable.slice(0, 5).map((c) => (
          <button
            key={c.row.id}
            type="button"
            role="menuitem"
            className="lcd-mi"
            aria-disabled={Boolean(stripRefusal) || undefined}
            data-testid={`lcd3-group-add-${c.row.id}`}
            onClick={stop(() => { if (!stripRefusal) { setNotice(onAddRows([c.row])); setQuery(''); } })}
          >
            <span className="lcd-kind" aria-hidden="true">+</span>
            <span className="lcd-mi__body lcd-mi__body--plain">{c.row.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SourceTag({ row }: { row: StripRow }) {
  if (row.jev === 'picked') return <span className="lcd3-tag lcd3-tag--jev" title={row.jevWhy ? `Jev: ${row.jevWhy}` : undefined}>✦ Jev</span>;
  if (row.jev === 'left-out') return <span className="lcd3-tag lcd3-tag--jev" title={row.jevWhy ? `Jev: ${row.jevWhy}` : undefined}>✦ left out</span>;
  if (row.source === 'added') return <span className="lcd3-tag lcd3-tag--added">added</span>;
  return <span className="lcd3-tag">{row.via ?? 'default'}</span>;
}

/* ================================================================ jev */

function JevControl({ jev }: { jev: JevButton }) {
  const { open, toggle, close, menuProps, stop } = useLaunchCardMenu();
  const title = jev.status === 'off'
    ? jev.reason ?? 'Jev is off.'
    : jev.status === 'busy'
      ? 'Asking Jev…'
      : jev.status === 'done'
        ? `Jev selected ${String(jev.picked)}, left out ${String(jev.leftOut)} — marked ✦ in the groups${jev.teammate ? ` · picked ${jev.teammate}` : ''}${jev.suggests ? ` · suggests ${jev.suggests} (in its menu)` : ''}${jev.cost ? ` · ${jev.cost}` : ''} · click for options`
        : jev.status === 'stale'
          ? 'Jev’s picks were for the previous teammate and were cleared — ask again'
          : 'Ask Jev — ranks what this launch should start with · one call';
  return (
    <div className="lcd-anchor">
      <button
        type="button"
        className="lcd3-jev"
        data-testid="lcd3-jev"
        data-status={jev.status}
        aria-label="Ask Jev"
        aria-disabled={jev.status === 'off' || jev.status === 'busy' || undefined}
        aria-expanded={jev.status === 'done' ? open === 'jev' : undefined}
        title={title}
        onClick={stop(() => {
          if (jev.status === 'off') { jev.onFixKey?.(); return; }
          if (jev.status === 'busy') return;
          if (jev.status === 'done') { toggle('jev'); return; }
          jev.onAsk();
        })}
      >
        ✦
      </button>
      {open === 'jev' && jev.status === 'done' ? (
        <div {...menuProps('jev', 'lcd-menu--up lcd-menu--narrow lcd3-jevmenu')} role="menu" data-testid="lcd3-jev-menu">
          <div className="lcd-grp">Jev <span>{jev.picked} selected · {jev.leftOut} left out{jev.cost ? ` · ${jev.cost}` : ''}</span></div>
          {jev.teammate ? <div className="lcd-note" data-testid="lcd3-jev-teammate-applied">Picked the teammate: {jev.teammate}.</div> : null}
          {jev.suggests ? <div className="lcd-note" data-testid="lcd3-jev-suggests">Suggests {jev.suggests} — in its menu.</div> : null}
          {jev.otherTeammates > 0 ? (
            <div className="lcd-note lcd3-refused" data-testid="lcd3-jev-teammates-unsent">
              Also ranked {jev.otherTeammates} other teammate{jev.otherTeammates === 1 ? '' : 's'} for the context index — not sent: the node can’t take teammates in a launch’s selection yet.
            </div>
          ) : null}
          {jev.failures.map((f) => (
            <button key={f.group} type="button" role="menuitem" className="lcd-mi" data-testid={`lcd3-jev-retry-${f.group}`} onClick={stop(() => { close(); f.onRetry(); })}>
              <span className="lcd-mi__body lcd-mi__body--plain">{f.group}: <span className="lcd3-bad">{f.reason}</span></span>
              <span className="lcd-mi__r">Retry</span>
            </button>
          ))}
          <button type="button" role="menuitem" className="lcd-mi" data-testid="lcd3-jev-again" onClick={stop(() => { close(); jev.onAskAgain(); })}>
            <span className="lcd-mi__body lcd-mi__body--plain">✦ Ask again</span><span className="lcd-mi__r">one call</span>
          </button>
          <button type="button" role="menuitem" className="lcd-mi" data-testid="lcd3-jev-undo" onClick={stop(() => { close(); jev.onUndo(); })}>
            <span className="lcd-mi__body lcd-mi__body--plain">Undo Jev’s changes</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================ actions */

/** The Dispatch tooltip (rev 8): who chooses what, plus the dispatchers' state. */
export function dispatchTitle(verb: LaunchVerb, control: DispatchControl): string {
  if (control.refusal) return control.refusal;
  const what = `the ${verb}`;
  const all = control.dispatchers;
  const alive = all?.filter((d) => d.alive) ?? [];
  const status = all === null
    ? 'This node doesn’t report its dispatchers to the card, so whether one is running is unknown — Dispatch uses the running one, or starts one first.'
    : alive.length === 0
      ? (all.length ? 'No dispatcher is running — dispatching starts one first, so it takes longer.' : 'No dispatcher in this space yet — dispatching starts one.')
      : alive.length === 1 ? `${alive[0]!.name} is running.` : `${String(alive.length)} dispatchers are running — pick one.`;
  return `A dispatcher chooses ${what} — teammate, model, place and context — and spawns it. ${status}`;
}

function Actions(props: LaunchCardV3Props) {
  const { verb, dispatch, onLaunch, busy, refusal } = props;
  const { open, toggle, close, menuProps, stop } = useLaunchCardMenu();
  const blocked = busy || Boolean(refusal);
  const alive = dispatch?.dispatchers?.filter((d) => d.alive) ?? [];
  const live = alive.length > 0;
  const many = alive.length > 1;
  return (
    <>
      {dispatch ? (
        <div className="lcd-anchor">
          <button
            type="button"
            className="lcd-btn lcd3-dispatch"
            data-testid="launch-dispatch"
            data-live={(live && !dispatch.refusal) || undefined}
            aria-disabled={Boolean(dispatch.refusal) || busy || undefined}
            aria-haspopup={many ? 'menu' : undefined}
            aria-expanded={many ? open === 'dispatch' : undefined}
            title={dispatchTitle(verb, dispatch)}
            onClick={stop(() => {
              if (dispatch.refusal || busy) return;
              if (many) { toggle('dispatch'); return; }
              dispatch.onDispatch(alive[0]?.id ?? null);
            })}
          >
            <span className="lcd3-ddot" data-on={live || undefined} data-unknown={dispatch.dispatchers === null || undefined} aria-hidden="true" />
            <span className="lcd-btn__label">Dispatch</span>{many ? <Caret up /> : ' ⇥'}
          </button>
          {open === 'dispatch' && many ? (
            <div {...menuProps('dispatch', 'lcd-menu--up lcd-menu--wide lcd3-dispmenu')} role="menu" data-testid="lcd3-dispatch-menu">
              <div className="lcd-grp">Dispatch to <span>it chooses the {verb}</span></div>
              {(dispatch.dispatchers ?? []).map((d) => {
                const why = d.alive ? d.unpickable : 'Not running — pick a running one.';
                return (
                  <button
                    key={d.id}
                    type="button"
                    role="menuitem"
                    className="lcd-mi"
                    data-testid={`lcd3-dispatcher-${d.id}`}
                    aria-disabled={Boolean(why) || undefined}
                    title={why ?? d.title}
                    onClick={stop(() => { if (!why) { close(); dispatch.onDispatch(d.id); } })}
                  >
                    <span className="lcd3-ddot" data-on={d.alive || undefined} aria-hidden="true" />
                    <span className="lcd-mi__body">{d.name}<span className={why && d.alive ? 'lcd-mi__why' : 'lcd-mi__sub'}>{why && d.alive ? why : d.title}</span></span>
                    <span className="lcd-mi__r">{d.status}</span>
                  </button>
                );
              })}
              <div className="lcd-foot lcd3-wrap">
                Your teammate, model, place and context picks are not sent — only the task, your note, and that it should be {aKind(verb)}.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="lcd-btn lcd-btn--go"
        data-testid="nsx-send"
        aria-disabled={blocked}
        title={refusal ?? `Launch ${aKind(verb)} yourself, exactly as set up on this card`}
        onClick={stop(() => { if (!blocked) onLaunch(); })}
      >
        {busy ? 'Launching…' : 'Launch'} <span className="lcd-kbd" aria-hidden="true">⌘↵</span>
      </button>
    </>
  );
}

export const kb = (n: number) => (n < 1024 ? `${String(n)} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
