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

export interface DiffViewProps {
  /** Raw unified diff text, as `git diff` emits it. */
  diff: string;
  /** Rows rendered for one file before the expander takes over. Default 300. */
  maxLinesPerFile?: number;
  /** Rows rendered across all files before later files collapse. Default 1500. */
  maxTotalLines?: number;
  className?: string;
}

const DEFAULT_MAX_LINES_PER_FILE = 300;
const DEFAULT_MAX_TOTAL_LINES = 1500;

const STATUS_TONE: Record<DiffFile['status'], PillTone> = {
  added: 'run',
  deleted: 'block',
  renamed: 'info',
  modified: 'idle',
};

type Row = { kind: 'hunk'; hunk: DiffHunk } | { kind: 'line'; line: DiffLine };

function rowsOf(file: DiffFile): Row[] {
  const out: Row[] = [];
  for (const hunk of file.hunks) {
    out.push({ kind: 'hunk', hunk });
    for (const line of hunk.lines) out.push({ kind: 'line', line });
  }
  return out;
}

const n = (value: number): string => value.toLocaleString('en-US');

function FileRows({ rows }: { rows: readonly Row[] }) {
  return (
    <>
      {rows.map((row, i) =>
        row.kind === 'hunk' ? (
          <div key={i} className="kit-diff__hunk">
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
        const rows = rowsOf(file);
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
                <FileRows rows={shown === rows.length ? rows : rows.slice(0, shown)} />
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
