/**
 * Redact BEFORE every header cut (follow-up to #796 / #801).
 *
 * A cut through a credential leaves a prefix too short for any pattern, and
 * nothing downstream can recognise it again: the manifest-wide redaction runs
 * on already-cut text, and Jev's candidate text leaves the server. So
 * `resolveHeaders` fetches `REDACTION_MARGIN` past each SQL cut, drops a
 * short partial token at the fetch boundary, redacts, and only then cuts;
 * `jevText` redacts before its own per-field cut and redacts its whole output.
 *
 * Tokens are built like packages/execution/test/secret-redaction.test.ts.
 */
import type { SelectionHeader } from '@tm8/contract';
import { REDACTION_MARKER, SECRET_TOKEN_SOURCE } from '@tm8/execution';
import { describe, expect, it } from 'vitest';

import { clip, HEADER_TEXT_LIMIT } from '../../src/headers/derive.js';
import { jevText } from '../../src/headers/render.js';
import { REDACTION_MARGIN, safeText } from '../../src/headers/resolve.js';

const TOKENS = [
  `sk-ant-oat01-${'A'.repeat(80)}`,
  `sk-proj-${'b'.repeat(40)}`,
  `ghp_${'C'.repeat(36)}`,
  `github_pat_${'e'.repeat(60)}`,
  `xoxb-${'1'.repeat(12)}-abcdef`,
  `tm8s_${'F'.repeat(43)}`,
];

/** What SQL `left(text, n)` returns: the first n code points. */
const sqlLeft = (text: string, n: number): string => Array.from(text).slice(0, n).join('');

/** A resolveHeaders read of a derived field: SQL cut at limit + margin, safeText, then derive's cut. */
function readThenCut(text: string, limit = HEADER_TEXT_LIMIT): string {
  const fetched = limit + REDACTION_MARGIN;
  return clip(safeText(sqlLeft(text, fetched), fetched), limit);
}

/** No byte of the token's identifying prefix survived. */
function leaks(out: string, token: string): boolean {
  return out.includes(token.slice(0, 5));
}

describe('REDACTION_MARGIN', () => {
  it('is longer than the shortest string any alternative in SECRET_TOKEN_SOURCE matches', () => {
    const alternatives = SECRET_TOKEN_SOURCE.replace(/^\(|\)$/g, '').split('|');
    expect(alternatives.length).toBeGreaterThanOrEqual(5);
    const minimum = (alt: string): number => {
      const m = alt.match(/^(.*)\[[^\]]+\]\{(\d+),\}$/);
      if (!m) throw new Error(`unparsed alternative: ${alt}`);
      return m[1]!.replace(/\[[^\]]+\]/g, 'x').length + Number(m[2]);
    };
    const longest = Math.max(...alternatives.map(minimum));
    expect(longest).toBe(31); // github_pat_ + 20
    expect(REDACTION_MARGIN).toBeGreaterThan(longest);
  });

  it('keeps ordinary text byte-identical: a word straddling the limit, and text that is one long run', () => {
    for (let start = HEADER_TEXT_LIMIT - 20; start <= HEADER_TEXT_LIMIT; start += 1) {
      const text = `${'p'.repeat(start - 1)} straddlingword and more words after it ${'q'.repeat(200)}`;
      expect(readThenCut(text), `word at ${start}`).toBe(sqlLeft(text, HEADER_TEXT_LIMIT));
    }
    const run = 'x'.repeat(5000);
    expect(readThenCut(run)).toBe('x'.repeat(HEADER_TEXT_LIMIT));
  });
});

describe('a credential straddling a cut never leaves a prefix', () => {
  it('derived text: every token kind, starting anywhere from 40 before the limit to the end of the fetch', () => {
    for (const token of TOKENS) {
      for (let start = HEADER_TEXT_LIMIT - 40; start < HEADER_TEXT_LIMIT + REDACTION_MARGIN; start += 1) {
        const text = `${'x'.repeat(start - 1)} ${token} and the rest of the body`;
        const out = readThenCut(text);
        expect(leaks(out, token), `${token.slice(0, 8)} at ${start}`).toBe(false);
        expect(Array.from(out).length).toBeLessThanOrEqual(HEADER_TEXT_LIMIT);
      }
    }
  });

  it('a redaction earlier in the text cannot pull a partial token at the fetch boundary back under the limit', () => {
    const early = TOKENS[0]!; // 93 chars; its marker is 21, so the text shrinks by 72
    const late = TOKENS[2]!;
    // The late token starts 14 characters before the fetch boundary: SQL keeps `ghp_CCCCCCCCCC`.
    const lateStart = HEADER_TEXT_LIMIT + REDACTION_MARGIN - 14;
    const text = `a ${early} ${'y'.repeat(lateStart - early.length - 4)} ${late} tail`;
    expect(text.indexOf(late)).toBe(lateStart);
    const out = readThenCut(text);
    expect(out).toContain(REDACTION_MARKER);
    expect(leaks(out, early)).toBe(false);
    expect(leaks(out, late)).toBe(false);
  });

  it('text SQL did not cut keeps its last word; text it cut loses the partial one', () => {
    expect(safeText('ends with word', 100)).toBe('ends with word');
    expect(safeText(`${'z'.repeat(9)} partia`, 16)).toBe(`${'z'.repeat(9)} `);
    expect(safeText('y'.repeat(80), 80)).toBe('y'.repeat(80));
    expect(safeText(null)).toBeNull();
    expect(safeText(`key ${TOKENS[2]}`)).toBe(`key ${REDACTION_MARKER}`);
  });
});

describe('jevText: the text that leaves the server', () => {
  const header = (extra: Partial<SelectionHeader>): SelectionHeader => ({
    entityId: 'id-1', kind: 'task', name: 'Task', whenToUse: null, summary: null, keywords: [],
    source: 'derived', stale: false, bytes: null, loadPointer: 'tm8 entity context id-1', ...extra,
  });

  it('redacts before its own per-field cut, so a token straddling 600 leaves no prefix', () => {
    for (const token of TOKENS) {
      const summary = `${'w'.repeat(HEADER_TEXT_LIMIT - 8)} ${token}`;
      const out = jevText(header({ summary }));
      expect(leaks(out, token), token.slice(0, 8)).toBe(false);
    }
  });

  it('redacts text it never cuts: names and a teammate\'s role', () => {
    const token = TOKENS[1]!;
    expect(jevText(header({ name: `Deploy with ${token}` }))).not.toContain(token);
    const mate = jevText(header({ kind: 'team_member', name: 'Mate', whenToUse: `uses ${token}` }));
    expect(mate).not.toContain(token);
    expect(mate).toContain(REDACTION_MARKER);
  });

  it('text with no credential is byte-identical to before', () => {
    const plain = header({ whenToUse: 'Open when X', summary: 's'.repeat(700) });
    expect(jevText(plain)).toBe(`Task: Open when X ${'s'.repeat(600)}`);
  });
});
