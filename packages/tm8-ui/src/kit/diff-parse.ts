/**
 * UNIFIED DIFF PARSER — text in, a structure the renderer can bound.
 *
 * WHY A PARSER AT ALL, rather than colouring lines on the fly. A diff is not a
 * line stream: `+++ b/x` is a header and `+foo` is an addition, and the two are
 * told apart only by WHERE they sit. Renderers that colour by first character
 * paint the file headers green and red, which is the bug this exists to avoid.
 *
 * WHY IT COUNTS BEFORE IT RENDERS. The per-file add/del counts and the total
 * line count are what let the view decide to CAP: you cannot say "1,240 more
 * lines" from a stream you are still consuming. Parsing is O(lines) and the
 * result is cheap to keep; rendering a megabyte of DOM is what is not.
 *
 * SCOPE. Unified diffs as `git diff` emits them (with or without the
 * `diff --git` extended header), plus plain `diff -u` output. Combined merge
 * diffs (`@@@`) are NOT decoded into columns — they are kept as a file entry
 * whose hunks read as context so nothing is silently dropped or miscoloured.
 */

export type DiffLineKind = 'add' | 'del' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content WITHOUT the leading +/-/space marker. */
  text: string;
  /** 1-based line number in the pre-image, or null for an addition. */
  oldLine: number | null;
  /** 1-based line number in the post-image, or null for a deletion. */
  newLine: number | null;
  /** True when the source carried `\ No newline at end of file` after it. */
  noNewline?: boolean;
}

export interface DiffHunk {
  /** The literal `@@ -a,b +c,d @@ section` line, shown as the hunk header. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffFile {
  /** Path to show: the post-image path, falling back to the pre-image one. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  /** True when git refused to text-diff it; `hunks` is then empty. */
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** True when `maxLines` cut the input short; the tail was not parsed. */
  truncated: boolean;
}

export interface ParseUnifiedDiffOptions {
  /**
   * Hard ceiling on input lines consumed. The guard of last resort: a runaway
   * `git diff` of a vendored tree is megabytes, and parsing all of it to then
   * render 200 lines is work nobody asked for. Default 50_000.
   */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 50_000;

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Git quotes paths that contain specials with C-style escapes; unquote those,
 * and strip the conventional a// b/ prefix. `/dev/null` stays literal — it is
 * the marker for add/delete, not a path.
 */
function cleanPath(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = p
      .slice(1, -1)
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  // `--- a/x` / `+++ b/x` may carry a trailing tab-separated timestamp.
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  if (p === '/dev/null') return null;
  if (/^[ab]\//.test(p)) p = p.slice(2);
  return p;
}

function blankFile(): DiffFile {
  return {
    path: '',
    oldPath: null,
    newPath: null,
    status: 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
}

/** Post-image path wins because that is the name the file has now. */
function settle(file: DiffFile): DiffFile {
  file.path = file.newPath ?? file.oldPath ?? '';
  if (file.status === 'modified') {
    if (file.oldPath === null && file.newPath !== null) file.status = 'added';
    else if (file.newPath === null && file.oldPath !== null) file.status = 'deleted';
    else if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath)
      file.status = 'renamed';
  }
  return file;
}

export function parseUnifiedDiff(text: string, options: ParseUnifiedDiffOptions = {}): ParsedDiff {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const all = text.length === 0 ? [] : text.split('\n');
  const truncated = all.length > maxLines;
  const lines = truncated ? all.slice(0, maxLines) : all;

  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = (): void => {
    if (file) files.push(settle(file));
    file = null;
    hunk = null;
  };
  /** A `---`/`+++` pair with no `diff --git` above it still starts a file. */
  const ensureFile = (): DiffFile => {
    if (!file) file = blankFile();
    return file;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      pushFile();
      file = blankFile();
      // `a/<old> b/<new>`; both halves carry the prefix, so split on ` b/`.
      const rest = line.slice('diff --git '.length);
      const at = rest.lastIndexOf(' b/');
      if (at > 0) {
        file.oldPath = cleanPath(rest.slice(0, at));
        file.newPath = cleanPath(rest.slice(at + 1));
      }
      continue;
    }

    if (line.startsWith('--- ') && !hunk) {
      ensureFile().oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ') && !hunk) {
      ensureFile().newPath = cleanPath(line.slice(4));
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      const f = ensureFile();
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      f.hunks.push(hunk);
      continue;
    }

    if (!file) continue;

    if (!hunk) {
      // Extended headers, only the ones that change what we SHOW.
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) file.oldPath = cleanPath(line.slice(12));
      else if (line.startsWith('rename to ')) file.newPath = cleanPath(line.slice(10));
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
        file.binary = true;
      continue;
    }

    if (line.startsWith('\\')) {
      // `\ No newline at end of file` annotates the line before it.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const marker = line[0];
    const body = line.slice(1);
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: body, oldLine: null, newLine: newNo++ });
      file.additions += 1;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: body, oldLine: oldNo++, newLine: null });
      file.deletions += 1;
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text: body, oldLine: oldNo++, newLine: newNo++ });
    } else if (line === '') {
      // A blank CONTEXT line is `" "` in real git output, but tools that strip
      // trailing whitespace turn it into `""` — so an empty line inside a hunk
      // is context. The FINAL empty line is different: it is the artefact of
      // splitting text that ends in a newline, and counting it as a row is how
      // every file silently gains one line it does not have.
      if (i < lines.length - 1) {
        hunk.lines.push({ kind: 'context', text: '', oldLine: oldNo++, newLine: newNo++ });
      }
    } else {
      // Anything else at hunk level ends the hunk (e.g. `-- ` mail signature,
      // or trailing prose). Stop consuming rather than mis-colour it.
      hunk = null;
    }
  }
  pushFile();

  return {
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated,
  };
}

/** Total rendered rows a file costs: every hunk header plus every line. */
export function fileRowCount(file: DiffFile): number {
  return file.hunks.reduce((n, h) => n + 1 + h.lines.length, 0);
}
