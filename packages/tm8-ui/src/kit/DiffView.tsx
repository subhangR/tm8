import { useMemo, useRef, useState } from 'react';
import { Pill, type PillTone } from './Pill';
import {
  fileRowCount,
  parseUnifiedDiff,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from './diff-parse';
// Imported here rather than by the app bootstrap so any surface that mounts a
// diff gets its vocabulary with it, and none can end up half-styled.
import './diff.css';

/**
 * THE DIFF RENDERER — one implementation for every surface that shows a change.
 *
 * WHY IT IS BOUNDED BY CONSTRUCTION. A diff is the one payload in this product
 * with no natural size: `git diff` across a lockfile refresh is megabytes, and
 * a renderer that maps lines to DOM nodes one-for-one will happily build
 * 40,000 rows and take the tab with it. So the ceilings are not a defensive
 * afterthought, they are the component's contract — TWO of them, because a
 * diff is big in two independent ways:
 *
 *   · `maxLinesPerFile` — one pathological file cannot eat the whole view.
 *   · `maxTotalLines`   — ten thousand small files cannot either.
 *
 * Neither ceiling ever HIDES a change: every cut is replaced by a button that
 * says how many lines it is holding back, and pressing it renders that file in
 * full. The user is never told less than the truth about the size of what they
 * are looking at, which is the whole reason a cap is acceptable at all.
 *
 * STATUS IS COLOUR + SYMBOL. Every added row carries a literal `+` and every
 * removed row a literal `-` in its own column, so the diff still reads
 * correctly with the tone tokens stripped, in monochrome, or to a screen
 * reader — the package's §"never colour alone" law applied to a surface where
 * colour is the obvious shortcut.
 *
 * PARSING IS NOT COLOURING. See `diff-parse.ts`: `+++ b/x` is a header, `+x` is
 * an addition, and only position tells them apart.
 */

/**
 * PER-HUNK SELECTION, offered by the renderer rather than built beside it.
 *
 * A surface that wants "stage these three hunks" needs a checkbox sitting on
 * the `@@` line it governs — a reviewer ticking a box two panes away from the
 * lines it selects is choosing blind. The alternative was a second, smaller
 * diff renderer in the Changes surface, which is exactly the fork this
 * component exists to prevent.
 *
 * THE INDEX IS 1-BASED AND RUNS ACROSS THE WHOLE DIFF in git's own order, so
 * it matches what `execution.gitDiff` numbered for the same text. For the
 * single-path read the Changes surface always makes, per-file and whole-diff
 * numbering are the same sequence.
 *
 * A HUNK PAST THE LINE BUDGET HAS NO BOX until its file is expanded — the cap
 * is not suspended for selection. The count a caller shows must therefore come
 * from its own hunk list, not from the boxes on screen.
 */
export interface DiffHunkSelection {
  /** Currently ticked hunk indices. */
  selected: ReadonlySet<number>;
  onToggle: (index: number) => void;
  /** A mutation is in flight — the boxes are frozen, not hidden. */
  disabled?: boolean;
  /** Names what a box selects, for its accessible name. Default "hunk". */
  noun?: string;
}

export interface DiffViewProps {
  /** Raw unified diff text, as `git diff` emits it. */
  diff: string;
  /** Rows rendered for one file before the expander takes over. Default 300. */
  maxLinesPerFile?: number;
  /** Rows rendered across all files before later files collapse. Default 1500. */
  maxTotalLines?: number;
  className?: string;
  /** Turn every rendered `@@` line into a checkbox. Read-only when absent. */
  selection?: DiffHunkSelection;
}

const DEFAULT_MAX_LINES_PER_FILE = 300;
const DEFAULT_MAX_TOTAL_LINES = 1500;

const STATUS_TONE: Record<DiffFile['status'], PillTone> = {
  added: 'run',
  deleted: 'block',
  renamed: 'info',
  modified: 'idle',
};

type Row =
  | { kind: 'hunk'; hunk: DiffHunk; index: number }
  | { kind: 'line'; line: DiffLine };

/**
 * `base` is how many hunks the earlier files already spent, so `index` counts
 * from 1 across the whole diff rather than restarting per file.
 */
function rowsOf(file: DiffFile, base: number): Row[] {
  const out: Row[] = [];
  let index = base;
  for (const hunk of file.hunks) {
    index += 1;
    out.push({ kind: 'hunk', hunk, index });
    for (const line of hunk.lines) out.push({ kind: 'line', line });
  }
  return out;
}

const n = (value: number): string => value.toLocaleString('en-US');

/**
 * `@@ -10,3 +12,3 @@ function foo()` read aloud is "at at minus ten comma
 * three" — line arithmetic, not a place. The trailing text after the closing
 * `@@` is git's guess at the enclosing function and is the only part of the
 * header that tells a listener WHERE they are, so the accessible name is the
 * index plus that, and falls back to the index alone when git had no guess.
 */
function hunkLabel(header: string, index: number, noun: string): string {
  const close = header.indexOf('@@', 2);
  const heading = close === -1 ? '' : header.slice(close + 2).trim();
  return heading === '' ? `Select ${noun} ${index}` : `Select ${noun} ${index}: ${heading}`;
}

function FileRows({ rows, selection }: { rows: readonly Row[]; selection?: DiffHunkSelection }) {
  const noun = selection?.noun ?? 'hunk';
  return (
    <>
      {rows.map((row, i) =>
        row.kind === 'hunk' ? (
          <div key={i} className="kit-diff__hunk" data-hunk={row.index}>
            {selection ? (
              <input
                type="checkbox"
                className="kit-diff__hunk-check"
                checked={selection.selected.has(row.index)}
                disabled={selection.disabled === true}
                // The header text alone reads as "at at minus ten comma three"
                // to a screen reader, so the index and git's function guess
                // carry the meaning instead.
                aria-label={hunkLabel(row.hunk.header, row.index, noun)}
                data-testid="kit-diff-hunk-check"
                data-hunk={row.index}
                onChange={() => selection.onToggle(row.index)}
              />
            ) : null}
            {row.hunk.header}
          </div>
        ) : (
          <div key={i} className={`kit-diff__row kit-diff__row--${row.line.kind}`}>
            <span className="kit-diff__num" aria-hidden>
              {row.line.oldLine ?? ''}
            </span>
            <span className="kit-diff__num" aria-hidden>
              {row.line.newLine ?? ''}
            </span>
            <span className="kit-diff__marker">
              {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '-' : ' '}
            </span>
            <span className="kit-diff__code">{row.line.text || ' '}</span>
          </div>
        ),
      )}
    </>
  );
}

export function DiffView({
  diff,
  maxLinesPerFile = DEFAULT_MAX_LINES_PER_FILE,
  maxTotalLines = DEFAULT_MAX_TOTAL_LINES,
  className,
  selection,
}: DiffViewProps) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>());
  const bodies = useRef(new Map<number, HTMLDivElement | null>());

  const expand = (index: number): void =>
    setExpanded((prev) => new Set(prev).add(index));

  /**
   * The budget is spent in file order, so what you see first is the top of the
   * diff — the part a reviewer reads — rather than an arbitrary slice.
   */
  const limits = useMemo(() => {
    let left = maxTotalLines;
    return parsed.files.map((file) => {
      const total = fileRowCount(file);
      const allowed = Math.max(0, Math.min(total, maxLinesPerFile, left));
      left -= allowed;
      return allowed;
    });
  }, [parsed, maxLinesPerFile, maxTotalLines]);

  /** How many hunks the files BEFORE each one hold, so indices never restart. */
  const hunkBases = useMemo(() => {
    let base = 0;
    return parsed.files.map((file) => {
      const at = base;
      base += file.hunks.length;
      return at;
    });
  }, [parsed]);

  if (parsed.files.length === 0) {
    return (
      <div className={className ? `kit-diff ${className}` : 'kit-diff'} data-testid="kit-diff">
        <p className="kit-diff__empty">No changes.</p>
      </div>
    );
  }

  return (
    <div className={className ? `kit-diff ${className}` : 'kit-diff'} data-testid="kit-diff">
      <div className="kit-diff__summary" data-testid="kit-diff-summary">
        <span className="kit-diff__count">
          {n(parsed.files.length)} {parsed.files.length === 1 ? 'file' : 'files'} changed
        </span>
        <span className="kit-diff__add-total">+{n(parsed.additions)}</span>
        <span className="kit-diff__del-total">-{n(parsed.deletions)}</span>
      </div>

      {parsed.truncated ? (
        <p className="kit-diff__notice" data-testid="kit-diff-input-truncated">
          The diff was longer than this view parses; the tail is not shown.
        </p>
      ) : null}

      <ul className="kit-diff__files" data-testid="kit-diff-files">
        {parsed.files.map((file, i) => (
          <li key={`${file.path}-${i}`}>
            <button
              type="button"
              className="kit-diff__file-link"
              onClick={() => bodies.current.get(i)?.scrollIntoView({ block: 'start' })}
            >
              <span className="kit-diff__file-path">{file.path}</span>
              <span className="kit-diff__add-total">+{n(file.additions)}</span>
              <span className="kit-diff__del-total">-{n(file.deletions)}</span>
            </button>
          </li>
        ))}
      </ul>

      {parsed.files.map((file, i) => {
        const rows = rowsOf(file, hunkBases[i] ?? 0);
        const open = expanded.has(i);
        const shown = open ? rows.length : limits[i];
        const hidden = rows.length - shown;
        return (
          <div
            key={`${file.path}-${i}`}
            className="kit-diff__file"
            data-testid="kit-diff-file"
            data-path={file.path}
            ref={(el) => {
              bodies.current.set(i, el);
            }}
          >
            <div className="kit-diff__file-head">
              <span className="kit-diff__file-path">{file.path}</span>
              <Pill tone={STATUS_TONE[file.status]}>{file.status}</Pill>
              <span className="kit-diff__add-total">+{n(file.additions)}</span>
              <span className="kit-diff__del-total">-{n(file.deletions)}</span>
            </div>
            {file.binary ? (
              <p className="kit-diff__empty">Binary file — not shown.</p>
            ) : (
              <div className="kit-diff__body">
                <FileRows rows={shown === rows.length ? rows : rows.slice(0, shown)} selection={selection} />
                {hidden > 0 ? (
                  <button
                    type="button"
                    className="kit-diff__more"
                    data-testid="kit-diff-more"
                    onClick={() => expand(i)}
                  >
                    Show {n(hidden)} more {hidden === 1 ? 'line' : 'lines'}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
