/**
 * HUNKS — the unit `git add -p` works in, made addressable.
 *
 * Phase 1 of the Changes screen could stage a FILE. A reviewer reading an
 * agent's turn rarely wants a whole file: the agent fixed the bug in one hunk
 * and reformatted three others, and "stage the file" forces those into one
 * commit. This module is the parsing half of staging a SUBSET.
 *
 * WHY THE CLIENT NEVER SENDS PATCH TEXT. The obvious API — client posts the
 * patch it wants applied — hands an arbitrary, attacker-controlled patch to
 * `git apply --cached` and lets it write any path in the tree. So the wire
 * carries INDICES ONLY. The server re-derives the diff from the worktree it
 * already trusts, and reconstructs the patch from its own bytes. A client can
 * choose among the hunks that genuinely exist; it can never author one.
 *
 * WHY A DIGEST RIDES ALONG. Indices are positional, and the worktree is live —
 * an agent writing to the same file between the read and the click would
 * silently re-aim "hunk 2" at different lines. That is the same class of bug
 * as committing a file the reviewer never looked at, which the commit verb
 * already refuses by name. So the client echoes a digest of the hunks it SAW
 * and a mismatch is a refusal, not a best-effort apply.
 */
import { createHash } from 'node:crypto';

import { WorktreeError } from './git-invoker.js';

export interface Hunk {
  /** 1-based, and stable only for the diff it was parsed from. */
  index: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The `@@ -a,b +c,d @@ trailing` line, verbatim. */
  heading: string;
  /** Body lines (context/+/-/`\ No newline`), WITHOUT the heading. */
  body: string[];
  /** Heading + body, newline-joined and newline-terminated. */
  text: string;
}

export interface ParsedDiff {
  /** Everything before the first `@@` — `diff --git`, mode bits, ---/+++. */
  preamble: string[];
  hunks: Hunk[];
  /**
   * A binary diff carries no hunks and cannot be split. Named rather than
   * returned as "zero hunks", because those two facts want different words on
   * screen: "nothing to stage" vs "this file cannot be staged by hunk".
   */
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse ONE file's unified diff. Multi-file input is refused rather than
 * silently reading the first file: the caller asked about a path, and a
 * surface that quietly answers about a different one is the lie this whole
 * screen is written to avoid.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  // A trailing newline yields a final '' that is not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const preamble: string[] = [];
  const hunks: Hunk[] = [];
  let binary = false;
  let current: Hunk | undefined;
  let seenDiffHeader = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (seenDiffHeader) {
        // A DIRECTORY-SCOPED READ LANDS HERE, and it is a normal request, not
        // a bug: `gitDiff` with `path: "src"` produces a multi-file diff. This
        // threw a PLAIN Error, which `readHunks`'s WorktreeError-only catch
        // re-threw past an un-try/catch'd facade splice — so asking for the
        // diff of a directory answered 503, where the same read without hunk
        // support had answered a valid multi-file diff. It is a WorktreeError
        // so the read side can recognise it and answer `hunks: null` (there is
        // no single file for indices to index into) and the STAGE side can
        // refuse it as `invalid_input` instead of crashing.
        throw new WorktreeError(
          'parseUnifiedDiff expects a single file diff, got more than one',
          'invalid_input',
          'not_a_single_file',
          { hint: 'hunk indices are per-file; name one file, not a directory' },
        );
      }
      seenDiffHeader = true;
    }
    // Git says this INSTEAD of hunks, so it can only appear pre-hunk.
    if (current === undefined && line.startsWith('Binary files ')) binary = true;

    const m = HUNK_RE.exec(line);
    if (m !== null) {
      current = {
        index: hunks.length + 1,
        oldStart: Number(m[1]),
        // An omitted count means 1 — `@@ -5 +5 @@`. Defaulting to 0 here would
        // silently drop single-line hunks from every recomputed offset.
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        heading: line,
        body: [],
        text: '',
      };
      hunks.push(current);
      continue;
    }
    if (current === undefined) {
      preamble.push(line);
      continue;
    }
    current.body.push(line);
  }

  for (const h of hunks) h.text = [h.heading, ...h.body].join('\n') + '\n';
  return { preamble, hunks, binary };
}

/**
 * The identity of a hunk SELECTION, for the exact-state check.
 *
 * Over the hunk TEXT, not its index or its line numbers: an edit elsewhere in
 * the file shifts every later hunk's `@@` header without changing the change
 * the reviewer approved, and refusing that would make the feature unusable in
 * exactly the situation it exists for — a live lane with an agent still in it.
 * The bytes being staged are what must not move.
 */
export function digestHunks(hunks: readonly Hunk[]): string {
  const h = createHash('sha256');
  for (const hunk of hunks) {
    h.update(hunk.body.join('\n'));
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

/** Select by 1-based index, refusing out-of-range rather than clamping. */
export function selectHunks(parsed: ParsedDiff, indices: readonly number[]): Hunk[] {
  if (indices.length === 0) {
    throw new WorktreeError('no hunks selected', 'invalid_input', 'no_hunks_selected');
  }
  const seen = new Set<number>();
  const out: Hunk[] = [];
  // Sorted so the rebuilt patch is in file order no matter what order the
  // reviewer ticked the boxes in; git applies a patch top-down.
  for (const i of [...indices].sort((a, b) => a - b)) {
    if (!Number.isInteger(i) || i < 1 || i > parsed.hunks.length) {
      // The contract promises "out of range is a refusal — never a clamp,
      // never a partial apply". A 503 is not a refusal: it tells the caller
      // the server broke AND invites a retry that can never succeed. Named,
      // `liftWorktreeError` turns it into a 400 that carries the index and the
      // range the client needs to re-read the diff.
      throw new WorktreeError(
        `hunk index ${i} is out of range (1..${parsed.hunks.length})`,
        'invalid_input',
        'hunk_index_out_of_range',
        { index: i, count: parsed.hunks.length },
      );
    }
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(parsed.hunks[i - 1]!);
  }
  return out;
}

/**
 * Rebuild a well-formed patch containing ONLY the selected hunks.
 *
 * THE OFFSET TRAP. A hunk header is `@@ -oldStart,oldCount +newStart,newCount @@`.
 * The OLD side stays true for any subset — it describes the pre-image, which
 * is the index, which the selection does not change. The NEW side does not:
 * `newStart` was computed with every earlier hunk applied, so dropping hunk 1
 * leaves hunk 2 claiming a post-image line number that will not exist. Git is
 * often forgiving here and that is precisely the danger — "often" is not a
 * contract, and the failure mode is a patch that applies at the wrong offset.
 *
 * NOTE (measured): `git apply` does not check this — it reads the OLD side to
 * locate a hunk and ignores the new-side start. Getting it wrong still applies
 * correctly today. It is recomputed anyway because the patch we emit is a real
 * unified diff that other readers (a human, `patch`, a future `--recount`-free
 * consumer) are entitled to trust, and because a header that lies is a trap
 * for whoever touches this next. The unit tests are its only enforcement.
 *
 * So the new side is RECOMPUTED from the cumulative delta of the hunks
 * actually included, and the emitted patch is correct by construction rather
 * than by git's tolerance.
 */
export function buildSubsetPatch(parsed: ParsedDiff, selected: readonly Hunk[]): string {
  if (parsed.binary) {
    throw new WorktreeError(
      'a binary diff cannot be staged by hunk',
      'invalid_input',
      'binary_file',
      { hint: 'stage or unstage the whole file' },
    );
  }
  if (selected.length === 0) {
    throw new WorktreeError('no hunks selected', 'invalid_input', 'no_hunks_selected');
  }

  const parts: string[] = [...parsed.preamble];
  let delta = 0;
  for (const h of selected) {
    const newStart = h.oldStart + delta;
    // `@@ -a,b +c,d @@` — counts of 1 are still written explicitly. Git accepts
    // both spellings, and the explicit one is what `git diff` itself emits for
    // multi-line hunks, so a round-trip through here reads like git's output.
    const heading = `@@ -${h.oldStart},${h.oldCount} +${newStart},${h.newCount} @@`;
    // Preserve the function-context suffix git puts after the closing `@@`.
    const suffix = h.heading.slice(h.heading.indexOf(' @@') + 3);
    parts.push(heading + suffix, ...h.body);
    delta += h.newCount - h.oldCount;
  }
  return parts.join('\n') + '\n';
}
