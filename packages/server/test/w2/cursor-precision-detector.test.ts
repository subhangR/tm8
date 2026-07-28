import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A DETECTOR for the cursor-timestamp truncation class, plus its own negative
 * control.
 *
 * THE CLASS. Postgres `timestamptz` holds MICROSECONDS; a JavaScript `Date`
 * holds only MILLISECONDS. Any keyset cursor whose value passes through a
 * `Date` therefore encodes a value STRICTLY BEFORE the row it came from, and
 * the consequence depends on the keyset's direction:
 *
 *   ASC  (`created_at > cursor`)  re-admits the boundary row — LOOPS. Loud.
 *   DESC (`created_at < cursor`)  SKIPS every row sharing the lost
 *                                 millisecond — SILENT ROW LOSS.
 *
 * Rows written in ONE transaction share an identical `now()`, so batch-written
 * rows land exactly in the dropped window. That is why the DESC half is the
 * dangerous half and why a sequential fixture cannot reproduce it.
 *
 * THE TWO TELLS, both cheap and requiring no SQL to be read:
 *
 *   1. A `cursor_*` field whose TYPE ADMITS `Date`. A `to_char` column is TEXT
 *      and can only ever be a string. Admitting `Date` is the signature of a
 *      RAW `timestamptz` wearing the safe name — and it is precisely what lets
 *      `iso()` be applied to it without a type error. `messages-handoffs.ts`
 *      carried the defended NAME (`cursor_created_at`) with the undefended
 *      TYPE (`Date | string`) and a raw `h.created_at` behind it.
 *
 *   2. `encodeCursor([... iso(...) ...])`. `iso()` (entity-read.ts:179)
 *      truncates on BOTH branches — `new Date(value).toISOString()` destroys
 *      precision even when handed a correctly formatted STRING. So formatting
 *      microseconds in SQL is NOT sufficient if the value is then passed
 *      through `iso()`; a fix verified at the SELECT alone would look correct
 *      and change nothing.
 *
 * WHY THIS FILE HAS A NEGATIVE CONTROL, and it is the point of the exercise:
 * a detector that fires on EVERYTHING passes a mutation test exactly as well as
 * a correct one. Red-on-the-known-bad proves the detector RESPONDS; only
 * green-on-the-known-good proves it DISCRIMINATES. Both halves are asserted
 * below, and the discrimination case uses the three sites independently
 * confirmed as correctly defended.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FACADE = resolve(HERE, '../../src/facade');

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: 'cursor-field-admits-date' | 'encode-cursor-through-iso';
  readonly text: string;
}

/**
 * Pure over (file, source) so the suite can feed it BOTH the real tree and
 * synthetic known-bad text. A detector that can only be run against the live
 * tree cannot have a negative control written for it.
 */
export function findTruncatingCursorSites(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split('\n');

  lines.forEach((raw, index) => {
    const text = raw.trim();
    if (text.startsWith('*') || text.startsWith('//')) return;

    // Tell 1 — a cursor field whose type admits Date.
    const field = /^(?:readonly\s+)?(cursor_[a-z_]+|__sort_cursor)\??\s*:\s*([^;]+);/.exec(text);
    if (field && /\bDate\b/.test(field[2]!)) {
      findings.push({ file, line: index + 1, rule: 'cursor-field-admits-date', text });
    }

    // Tell 2 — a cursor encoded through iso(), which truncates even a string.
    if (text.includes('encodeCursor(') && /\biso\(/.test(text)) {
      findings.push({ file, line: index + 1, rule: 'encode-cursor-through-iso', text });
    }

    // Tell 3 — a cursor encoded from a DTO's camelCase timestamp field.
    //
    // THE THIRD DISGUISE, and the one both tells above miss. `encodeCursor([fp,
    // last.createdAt, last.id])` contains no `iso(` and touches no `cursor_*`
    // field, so it reads as innocent — but `MessageView.createdAt` is built by
    // `iso(row.created_at)` a layer away, so the value arrives ALREADY
    // truncated. The encode site inherits a defect committed somewhere else.
    //
    // The rule is deliberately blunt: a keyset value must come from a column
    // the query rendered for that purpose, never from a projection built for
    // display. Display fields are ISO-for-humans; cursors are exact-for-
    // Postgres, and one is not a substitute for the other.
    if (text.includes('encodeCursor(') && /\b\w+\.(createdAt|updatedAt|activityAt)\b/.test(text)) {
      findings.push({ file, line: index + 1, rule: 'encode-cursor-from-dto-field', text });
    }
  });

  return findings;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function scanFacade(): Finding[] {
  return sourceFiles(FACADE).flatMap((file) =>
    findTruncatingCursorSites(relative(FACADE, file), readFileSync(file, 'utf8')),
  );
}

/**
 * The ONE known instance left in the tree, allowlisted with its reason rather
 * than silently tolerated.
 *
 * `handlers/activity.ts` truncates, but the independent gate DISPROVED that it
 * is reachable by any paging route: `entities.activity` is served by
 * `services/w2/entities-commands-tracking.ts`, and `loadActivity` is imported
 * only by `handlers/commands.ts` and `handlers/spaces.ts`, neither of which
 * pages. It is LATENT, not live, and was deliberately excluded from the sweep.
 * If a paging route ever reaches it, this entry must be removed and the site
 * fixed — the allowlist is the record of that decision, not a suppression.
 */
const ALLOWLISTED = new Map<string, string>([
  ['handlers/activity.ts', 'latent: no paging route reaches loadActivity (gate-disproved)'],
]);

describe('cursor timestamp truncation detector', () => {
  // -------------------------------------------------------------------------
  // RED HALF — it responds to the defect.
  // -------------------------------------------------------------------------

  it('flags a cursor field whose type admits Date', () => {
    // Verbatim shape of messages-handoffs.ts:140 BEFORE the fix: the defended
    // name, the undefended type.
    const findings = findTruncatingCursorSites('known-bad.ts', [
      'interface HandoffListRow {',
      '  readonly view: HandoffView;',
      '  readonly cursor_created_at?: Date | string;',
      '  readonly id?: string;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'cursor-field-admits-date', line: 3 });
  });

  it('flags a cursor encoded through iso(), even when the SQL formatted it correctly', () => {
    // The subtle one: the value arrived as correct microsecond text and is
    // destroyed downstream. A fix verified at the SELECT would miss this.
    const findings = findTruncatingCursorSites('known-bad.ts',
      '        ? encodeCursor([fp, iso(last.cursor_created_at), last.id])');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('encode-cursor-through-iso');
  });

  it('flags a cursor built from a DTO timestamp field, which the other two tells miss', () => {
    // THE THIRD DISGUISE, verbatim as it stood at feed-context.ts:1169 before
    // the fix. Note what makes it dangerous: there is no `iso(` on this line
    // and no `cursor_*` field anywhere near it, so tells 1 and 2 both pass it.
    // The truncation was committed in entity-read.ts, one layer away, and this
    // line merely inherited it.
    const line = "      cursors['messages'] = last ? encodeCursor([fingerprint, last.createdAt, last.id]) : null;";
    const findings = findTruncatingCursorSites('known-bad.ts', line);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('encode-cursor-from-dto-field');

    // And prove the OTHER two tells genuinely do not catch it, so this case is
    // not silently redundant with them.
    expect(findings.filter((f) => f.rule !== 'encode-cursor-from-dto-field')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // GREEN HALF — it discriminates. Without this the detector could be an alarm
  // stuck on, and would still pass every case above.
  // -------------------------------------------------------------------------

  it('does NOT flag a cursor built from a query-rendered value beside a DTO', () => {
    // The fixed form of the case above. `lastCursor` came from the query; only
    // `last.id` is read off the DTO, and an id carries no precision to lose.
    const findings = findTruncatingCursorSites('known-good.ts',
      "        ? encodeCursor([fingerprint, lastCursor, last.id])");
    expect(findings).toEqual([]);
  });

  it('does NOT flag a DTO timestamp used somewhere that is not a cursor', () => {
    // Narrowness: `iso()` on a display field is CORRECT and extremely common.
    // A detector that flagged every createdAt would be deleted within a day.
    const findings = findTruncatingCursorSites('known-good.ts', [
      '    createdAt: iso(row.created_at),',
      '    const shown = summary.createdAt;',
    ].join('\n'));
    expect(findings).toEqual([]);
  });

  it('does NOT flag the three independently confirmed DEFENDED sites', () => {
    // The negative control. These carry to_char microsecond text in required
    // string fields; a detector that flagged them would be indistinguishable
    // from one that flags every cursor field.
    for (const file of [
      'services/w2/edges-placements.ts',
      'services/w2/entities-commands-tracking.ts',
      'services/w2/feed-context.ts',
    ]) {
      const findings = findTruncatingCursorSites(
        file, readFileSync(join(FACADE, file), 'utf8'),
      );
      expect(findings, `${file} must not be flagged`).toEqual([]);
    }
  });

  it('does NOT flag a correctly defended field or encode', () => {
    const findings = findTruncatingCursorSites('known-good.ts', [
      '  readonly cursor_created_at: string;',
      '  cursor_updated_at: string;',
      '      ? encodeCursor([fingerprint, last.cursor_created_at, last.id])',
    ].join('\n'));
    expect(findings).toEqual([]);
  });

  it('does NOT flag a plain timestamp field that is not a cursor', () => {
    // Narrowness check: `created_at: Date | string` is normal and correct on a
    // row type. Only the CURSOR field is constrained.
    const findings = findTruncatingCursorSites('known-good.ts',
      '  created_at: Date | string;\n  updated_at: Date | string;');
    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE LIVE TREE
  // -------------------------------------------------------------------------

  it('finds nothing in the facade beyond the documented allowlist', () => {
    const unexpected = scanFacade().filter((f) => !ALLOWLISTED.has(f.file));
    expect(
      unexpected,
      `cursor truncation reintroduced:\n${unexpected.map((f) =>
        `  ${f.file}:${f.line} [${f.rule}] ${f.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('still sees the allowlisted site, so the allowlist is not hiding a fixed file', () => {
    // If activity.ts were fixed, this fails and the allowlist entry should be
    // deleted. An allowlist nobody revisits is how a suppression outlives its
    // reason.
    const found = scanFacade().filter((f) => ALLOWLISTED.has(f.file));
    expect(found.length, 'allowlisted site no longer truncates — remove its entry').toBeGreaterThan(0);
  });
});
