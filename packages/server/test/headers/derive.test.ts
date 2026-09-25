/**
 * The pure half of the header module: per-kind fallbacks, the authored →
 * native → derived order, and `jevText` for the reference kinds. The golden
 * Jev parity and RLS live in `test/db/headers-jev-parity.pg.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { deriveHeader, docSummary, loadPointerFor } from '../../src/headers/derive.js';
import { jevText } from '../../src/headers/render.js';

const id = '01a0d3b2-0ac0-770d-9cb6-f76661b720af';
/** Text a whenToUse may come from, as `resolveHeaders` hands it over (already backstopped). */
const t = (text: string | null, cut = false) => ({ text, cut });

describe('deriveHeader', () => {
  it('artifact: description is the summary, bundle bytes are the size', () => {
    expect(deriveHeader({ id, name: 'Dashboard' }, { kind: 'artifact', description: 'Live CI board', bytes: 4096 })).toEqual({
      entityId: id, kind: 'artifact', name: 'Dashboard', whenToUse: null, summary: 'Live CI board', keywords: [],
      source: 'derived', stale: false, bytes: 4096, loadPointer: `tm8 entity context ${id}`,
    });
  });

  it('an authored header wins field by field, and the other field still falls back', () => {
    const header = deriveHeader(
      { id, name: 'Draco' },
      { kind: 'team_member', role: t('PTY engineer'), persona: 'Persona.', bytes: 8 },
      { whenToUse: 'Pick for terminal work', summary: null, keywords: ['pty'], stale: true },
    );
    expect(header).toMatchObject({ whenToUse: 'Pick for terminal work', summary: 'Persona.', keywords: ['pty'], source: 'authored', stale: true });
  });

  it('skills and memories ignore an authored header: their native field is the only source', () => {
    const header = deriveHeader(
      { id, name: 'deploy' },
      { kind: 'skill', description: t('Deploys'), whenToUse: t(null), bytes: 1 },
      { whenToUse: 'nope', summary: 'nope', keywords: ['x'], stale: true },
    );
    expect(header).toMatchObject({ whenToUse: 'Deploys', summary: 'Deploys', keywords: [], source: 'native', stale: false });
  });

  it('never cuts a whenToUse (task 01a0da5a): a skill routes by its WHOLE description, its summary is cut at 600', () => {
    const long = 'd'.repeat(1500);
    const skill = deriveHeader({ id, name: 'deploy' }, { kind: 'skill', description: t(long), whenToUse: t(null), bytes: 1 });
    expect(skill.whenToUse).toBe(long);
    expect(skill.summary).toBe('d'.repeat(600));
    expect(skill.clipped).toBeUndefined();
    const memory = deriveHeader({ id, name: 'm' }, { kind: 'memory', statement: 's', subjectScope: t('w'.repeat(900)), bytes: 1 });
    expect(memory.whenToUse).toBe('w'.repeat(900));
    const collection = deriveHeader({ id, name: 'c' }, { kind: 'collection', description: t('c'.repeat(900)), members: {} });
    expect(collection.whenToUse).toBe('c'.repeat(900));
    const mate = deriveHeader({ id, name: 'Draco' }, { kind: 'team_member', role: t('r'.repeat(900)), persona: null, bytes: 1 });
    expect(mate.whenToUse).toBe('r'.repeat(900));
  });

  it('declares the backstop wherever it bit, and only a whenToUse that came from that field', () => {
    const cut = t(`${'b'.repeat(1999)}…`, true);
    expect(deriveHeader({ id, name: 's' }, { kind: 'skill', description: t('Deploys'), whenToUse: cut, bytes: 1 }).clipped).toEqual(['whenToUse']);
    expect(deriveHeader({ id, name: 'm' }, { kind: 'memory', statement: 's', subjectScope: cut, bytes: 1 }).clipped).toEqual(['whenToUse']);
    // An authored whenToUse replaces the cut one, so the kind's cut is not declared.
    const authored = deriveHeader({ id, name: 'c' }, { kind: 'collection', description: cut, members: {} },
      { whenToUse: 'Open for prod', summary: null, keywords: [], stale: false });
    expect(authored.clipped).toBeUndefined();
    // An authored backstop clip is carried as it was declared.
    const own = deriveHeader({ id, name: 'c' }, { kind: 'collection', description: t('x'), members: {} },
      { whenToUse: cut.text, summary: null, keywords: [], stale: false, clipped: ['whenToUse'] });
    expect(own.clipped).toEqual(['whenToUse']);
  });

  it('cuts at 600 code points, never inside a surrogate pair', () => {
    const header = deriveHeader({ id, name: 't' }, { kind: 'task', description: `${'a'.repeat(599)}😀😀`, bytes: 1 });
    expect(header.summary).toBe(`${'a'.repeat(599)}😀`);
  });

  it('doc summary: first non-heading paragraph (≤ 400) then the headings, within 600', () => {
    expect(docSummary(`# T\n\n${'w'.repeat(500)}`, ['T', 'Goals'])).toBe(`${'w'.repeat(400)} Sections: T · Goals`);
    expect(docSummary('', [])).toBeNull();
    expect([...docSummary('p', Array.from({ length: 200 }, (_, i) => `Heading ${i}`))!]).toHaveLength(600);
  });

  it('one pointer grammar for every kind', () => {
    expect(loadPointerFor('file', id)).toBe(`tm8 entity context ${id}`);
  });
});

describe('jevText for reference kinds', () => {
  it('name, then when, then what; a bare name when there is neither', () => {
    const doc = deriveHeader({ id, name: 'Design' }, { kind: 'doc', head: 'Intro.', headings: ['Goals'], bytes: 10 });
    expect(jevText(doc)).toBe('Design: Intro. Sections: Goals');
    const empty = deriveHeader({ id, name: 'Blank' }, { kind: 'task', description: '  ', bytes: 2 });
    expect(jevText(empty)).toBe('Blank');
    const collection = deriveHeader({ id, name: 'Runbooks' }, { kind: 'collection', description: t('Pick for prod'), members: { doc: 2 } });
    expect(jevText(collection)).toBe('Runbooks: Pick for prod Contains 2 doc');
  });

  it('shows a whenToUse whole and cuts only the summary (D4)', () => {
    const when = 'w'.repeat(900);
    const doc = { ...deriveHeader({ id, name: 'D' }, { kind: 'doc', head: 's'.repeat(700), headings: [], bytes: 1 }), whenToUse: when };
    expect(jevText(doc)).toBe(`D: ${when} ${'s'.repeat(400)}`);
    const skill = deriveHeader({ id, name: 'k' }, { kind: 'skill', description: t(null), whenToUse: t(when), bytes: 1 });
    expect(jevText(skill)).toBe(`k: ${when}`);
    // A skill with a description still reads "name: description", cut at 600, as before.
    const described = deriveHeader({ id, name: 'k' }, { kind: 'skill', description: t('d'.repeat(900)), whenToUse: t(null), bytes: 1 });
    expect(jevText(described)).toBe(`k: ${'d'.repeat(600)}`);
  });
});
