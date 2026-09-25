/**
 * #805 review: EVERY alternative in the redaction grammar, straddling EVERY
 * cut a header's text goes through, read by EVERY reader. The bar: no prefix
 * of the token of 4 or more characters survives anywhere.
 *
 * The cuts: derived text at 600 (SQL at 600 + REDACTION_MARGIN), a doc's
 * first paragraph at 400 (its head fetched at DOC_HEAD_CHARS with no margin),
 * authored whenToUse 400 / summary 600 / keyword 40 (#796, each fetched at
 * limit + margin), the index's 200 (#801), Jev's 600, a memory's 120-character
 * title, and the SQL fetch boundary itself. The Jev subject (the task Jev is
 * asked about) leaves the server whole, so it is redacted whole.
 *
 * And the grammar's SHAPE, which `safeText`'s boundary argument rests on:
 * every alternative's alphabet is inside TOKEN_CHAR_CLASS, and its shortest
 * match is shorter than REDACTION_MARGIN.
 */
import { AUTHORED_HEADER_LIMITS, type SelectionHeader } from '@tm8/contract';
import { redactSecretTokens, REDACTION_MARKER, SECRET_TOKEN_SOURCE, TOKEN_CHAR_CLASS } from '@tm8/execution';
import { clipIndexText, INDEX_DERIVED_HEADER_CHARS } from '@tm8/prompt';
import { describe, expect, it } from 'vitest';

import { clip, docSummary, DOC_PARAGRAPH_LIMIT, HEADER_TEXT_LIMIT } from '../../src/headers/derive.js';
import { jevText } from '../../src/headers/render.js';
import { clipAuthored, headerNameOf, REDACTION_MARGIN, safeText, type HeaderRow } from '../../src/headers/resolve.js';
import { redactSubject } from '../../src/jev/candidates.js';

/**
 * One token per literal prefix the grammar names, at its SHORTEST match (the
 * one most likely to fit inside a cut) and a realistic long one.
 */
const TOKENS = [
  `sk-${'a'.repeat(16)}`, `sk-ant-oat01-${'A'.repeat(95)}`, `sk-proj-${'b'.repeat(40)}`,
  ...['p', 'o', 'u', 's', 'r'].map((c) => `gh${c}_${'C'.repeat(20)}`), `ghp_${'D'.repeat(36)}`,
  `github_pat_${'e'.repeat(20)}`, `github_pat_11${'E'.repeat(20)}_${'f'.repeat(59)}`,
  ...['a', 'b', 'p', 'r'].map((c) => `xox${c}-${'1'.repeat(10)}`), `xoxb-${'2'.repeat(12)}-${'3'.repeat(13)}-abcdefgh`,
  ...['s', 'a', 'c', 'r'].map((c) => `tm8${c}_${'G'.repeat(20)}`), `tm8s_${'H'.repeat(43)}`,
];

/** Any prefix of 4 or more characters of `token` in `out`. */
const leaks = (out: string | null | undefined, token: string): boolean => (out ?? '').includes(token.slice(0, 4));

/** What SQL `left(text, n)` returns. */
const sqlLeft = (text: string, n: number): string => Array.from(text).slice(0, n).join('');

/** `token` starting at code point `start` (≥ 1) of an otherwise plain text. */
const at = (start: number, token: string): string => `${'x'.repeat(start - 1)} ${token} and the rest`;

/** Start positions from 40 before `cut` to 8 past `fetched`. */
function* straddles(cut: number, fetched = cut): Generator<number> {
  for (let start = Math.max(1, cut - 40); start <= fetched + 8; start += 1) yield start;
}

const derivedRead = (text: string): string | null => {
  const fetched = HEADER_TEXT_LIMIT + REDACTION_MARGIN;
  return safeText(sqlLeft(text, fetched), fetched);
};

const header = (extra: Partial<SelectionHeader>): SelectionHeader => ({
  entityId: 'id-1', kind: 'task', name: 'Task', whenToUse: null, summary: null, keywords: [],
  source: 'derived', stale: false, bytes: null, loadPointer: 'tm8 entity context id-1', ...extra,
});

describe('the tokens are real: every one is redacted whole (positive control)', () => {
  it.each(TOKENS)('%s', (token) => {
    expect(redactSecretTokens(` ${token} `)).toBe(` ${REDACTION_MARKER} `);
  });
});

describe('no prefix survives a cut, for every alternative', () => {
  it.each(TOKENS)('derived text (600, fetch 664), the index (200) and Jev (600): %s', (token) => {
    for (const start of straddles(HEADER_TEXT_LIMIT, HEADER_TEXT_LIMIT + REDACTION_MARGIN)) {
      const read = derivedRead(at(start, token));
      const summary = clip(read);
      expect(leaks(summary, token), `summary at ${start}`).toBe(false);
      expect(leaks(clipIndexText(redactSecretTokens(summary), INDEX_DERIVED_HEADER_CHARS), token), `index at ${start}`).toBe(false);
      expect(leaks(jevText(header({ summary })), token), `jev at ${start}`).toBe(false);
    }
    for (const start of straddles(INDEX_DERIVED_HEADER_CHARS)) {
      const summary = clip(derivedRead(at(start, token)));
      expect(leaks(clipIndexText(redactSecretTokens(summary), INDEX_DERIVED_HEADER_CHARS), token), `index at ${start}`).toBe(false);
    }
  });

  it.each(TOKENS)('a doc: the first paragraph (400), and a paragraph cut by the 4000-char head: %s', (token) => {
    const DOC_HEAD_CHARS = 4000;
    for (const start of straddles(DOC_PARAGRAPH_LIMIT)) {
      const head = safeText(sqlLeft(at(start, token), DOC_HEAD_CHARS), DOC_HEAD_CHARS);
      expect(leaks(docSummary(head, []), token), `paragraph at ${start}`).toBe(false);
    }
    // Headings fill the head until the paragraph starts ~200 before the head's cut.
    const headings = '# h\n\n'.repeat(Math.floor((DOC_HEAD_CHARS - 200) / 5));
    for (const offset of straddles(200)) {
      const body = `${headings}${at(offset, token)}`;
      const head = safeText(sqlLeft(body, DOC_HEAD_CHARS), DOC_HEAD_CHARS);
      expect(leaks(docSummary(head, [safeText(`h ${token}`)!]), token), `head cut at paragraph offset ${offset}`).toBe(false);
    }
  });

  it.each(TOKENS)('authored whenToUse (400), summary (600) and a keyword (40), each at its fetch: %s', (token) => {
    for (const max of [AUTHORED_HEADER_LIMITS.whenToUse, AUTHORED_HEADER_LIMITS.summary, AUTHORED_HEADER_LIMITS.keyword]) {
      const fetched = max + REDACTION_MARGIN;
      for (const start of straddles(max, fetched)) {
        const cut = clipAuthored(sqlLeft(at(start, token), fetched), fetched, max);
        expect(leaks(cut.text, token), `limit ${max} at ${start}`).toBe(false);
        expect(Array.from(cut.text ?? '').length).toBeLessThanOrEqual(max);
      }
    }
  });

  it.each(TOKENS)('a memory header\'s name, its statement cut to 120 (whitespace collapsed first): %s', (token) => {
    for (const start of straddles(120)) {
      for (const statement of [at(start, token), `${'x'.repeat(start - 1)}\n\n\t${token}`]) {
        const row = { kind: 'memory', memory_statement: sqlLeft(statement, HEADER_TEXT_LIMIT + REDACTION_MARGIN) } as HeaderRow;
        expect(leaks(headerNameOf(row), token), `name at ${start}`).toBe(false);
      }
    }
  });

  it.each(TOKENS)('the Jev subject, which leaves the server whole: %s', (token) => {
    const subject = redactSubject({ title: `Rotate ${token}`, description: at(700, token), parentTitle: `Parent ${token}` });
    expect(leaks(subject.title, token) || leaks(subject.description, token) || leaks(subject.parentTitle, token)).toBe(false);
  });
});

describe('names are redacted, and plain names are untouched', () => {
  it('every kind\'s name column; a memory title keeps its 120-char cut', () => {
    const token = TOKENS[1]!;
    expect(headerNameOf({ kind: 'task', task_title: `Deploy ${token}` } as unknown as HeaderRow)).toBe(`Deploy ${REDACTION_MARKER}`);
    expect(headerNameOf({ kind: 'task', task_title: 'Plain title' } as unknown as HeaderRow)).toBe('Plain title');
    const statement = `${'m'.repeat(80)}  and\nmore ${'n'.repeat(200)}`;
    expect(headerNameOf({ kind: 'memory', memory_statement: statement } as HeaderRow))
      .toBe(statement.replace(/\s+/g, ' ').slice(0, 120));
  });

  it('a plain Jev subject is byte-identical', () => {
    const plain = { title: 'T', description: 'd'.repeat(900), priority: 'high', parentTitle: 'P' };
    expect(redactSubject(plain)).toEqual(plain);
  });
});

describe('an authored clip is never silent, even when redaction shrinks what SQL read', () => {
  it('a long key early in a long summary: the field SQL cut is still declared clipped', () => {
    const key = TOKENS[1]!; // 108 characters, its marker 21
    const max = AUTHORED_HEADER_LIMITS.summary;
    const text = `use ${key} then ${'s'.repeat(2000)}`;
    const cut = clipAuthored(sqlLeft(text, max + REDACTION_MARGIN), max + REDACTION_MARGIN, max);
    expect(cut.clipped).toBe(true);
    expect(cut.text!.endsWith('…')).toBe(true);
    expect(leaks(cut.text, key)).toBe(false);
  });

  it('a field that fits after redaction and was never cut is not a clip, and plain fields are byte-identical', () => {
    const max = AUTHORED_HEADER_LIMITS.summary;
    const fetched = max + REDACTION_MARGIN;
    expect(clipAuthored(`use ${TOKENS[1]} ${'s'.repeat(550)}`, fetched, max)).toEqual({ text: `use ${REDACTION_MARKER} ${'s'.repeat(550)}`, clipped: false });
    expect(clipAuthored('s'.repeat(max), fetched, max)).toEqual({ text: 's'.repeat(max), clipped: false });
    expect(clipAuthored('s'.repeat(max + 1), fetched, max)).toEqual({ text: `${'s'.repeat(max - 1)}…`, clipped: true });
    expect(clipAuthored(null, fetched, max)).toEqual({ text: null, clipped: false });
  });
});

// ---------------------------------------------------------------------------
// The grammar's shape
// ---------------------------------------------------------------------------

/** The characters a regex class body like `A-Za-z0-9_-` admits. Throws on anything but ranges and plain characters. */
function expandClass(body: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c === '\\' || c === '^' && i === 0) throw new Error(`unsupported class syntax in [${body}]`);
    if (body[i + 1] === '-' && i + 2 < body.length) {
      for (let code = c.charCodeAt(0); code <= body.charCodeAt(i + 2); code += 1) out.add(String.fromCharCode(code));
      i += 2;
    } else {
      out.add(c);
    }
  }
  return out;
}

/**
 * One alternative's alphabet and shortest match. Understands literals,
 * `[class]` and `{n}` / `{n,}` / `{n,m}`, and nothing else: a new alternative
 * with other syntax fails here until someone re-checks `safeText`'s argument.
 */
function shapeOf(alternative: string): { alphabet: Set<string>; minimum: number } {
  const alphabet = new Set<string>();
  let minimum = 0;
  let i = 0;
  while (i < alternative.length) {
    let atom: Set<string>;
    if (alternative[i] === '[') {
      const end = alternative.indexOf(']', i);
      atom = expandClass(alternative.slice(i + 1, end));
      i = end + 1;
    } else if (/[A-Za-z0-9_-]/.test(alternative[i]!)) {
      atom = new Set([alternative[i]!]);
      i += 1;
    } else {
      throw new Error(`unsupported syntax ${JSON.stringify(alternative[i])} in ${alternative}`);
    }
    let times = 1;
    const quantifier = /^\{(\d+)(,(\d*))?\}/.exec(alternative.slice(i));
    if (quantifier) {
      times = Number(quantifier[1]);
      i += quantifier[0].length;
    } else if (/^[*+?]/.test(alternative.slice(i))) {
      throw new Error(`unsupported quantifier in ${alternative}`);
    }
    for (const c of atom) alphabet.add(c);
    minimum += times;
  }
  return { alphabet, minimum };
}

/** What `safeText`'s argument needs of a grammar; the violations, empty when it holds. */
function grammarViolations(source: string): string[] {
  const inner = source.replace(/^\(|\)$/g, '');
  const tokenChars = expandClass(TOKEN_CHAR_CLASS);
  return inner.split('|').flatMap((alternative) => {
    try {
      const { alphabet, minimum } = shapeOf(alternative);
      const outside = [...alphabet].filter((c) => !tokenChars.has(c));
      return [
        ...(outside.length > 0 ? [`${alternative}: ${outside.join('')} is outside TOKEN_CHAR_CLASS`] : []),
        ...(minimum >= REDACTION_MARGIN ? [`${alternative}: shortest match ${minimum} ≥ REDACTION_MARGIN`] : []),
      ];
    } catch (error) {
      return [(error as Error).message];
    }
  });
}

describe('the grammar keeps safeText\'s boundary argument true', () => {
  it('every alternative\'s alphabet is inside TOKEN_CHAR_CLASS and its shortest match is under REDACTION_MARGIN', () => {
    expect(SECRET_TOKEN_SOURCE.replace(/^\(|\)$/g, '').split('|')).toHaveLength(5);
    expect(grammarViolations(SECRET_TOKEN_SOURCE)).toEqual([]);
    expect(Math.max(...SECRET_TOKEN_SOURCE.replace(/^\(|\)$/g, '').split('|').map((a) => shapeOf(a).minimum))).toBe(31);
  });

  it('NEGATIVE CONTROL: a JWT, base64, a URL credential, a long prefix or unknown syntax is caught', () => {
    const add = (alternative: string): string => SECRET_TOKEN_SOURCE.replace(/\)$/, `|${alternative})`);
    expect(grammarViolations(add('eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}'))).toHaveLength(1);
    expect(grammarViolations(add('AKIA[A-Za-z0-9+/=]{16,}'))).toEqual(['AKIA[A-Za-z0-9+/=]{16,}: +/= is outside TOKEN_CHAR_CLASS']);
    expect(grammarViolations(add('https://[^@]+@'))).toHaveLength(1);
    expect(grammarViolations(add('sk-ant-[A-Za-z0-9_-]{90,}'))).toEqual(['sk-ant-[A-Za-z0-9_-]{90,}: shortest match 97 ≥ REDACTION_MARGIN']);
    expect(grammarViolations(add('(?:ab)+'))).toHaveLength(1);
  });
});
