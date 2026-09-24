/**
 * The pure half of the header module: per-kind fallbacks, the authored →
 * native → derived order, and `jevText` for the reference kinds. The golden
 * Jev parity and RLS live in `test/db/headers-jev-parity.pg.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { deriveHeader, docSummary, loadPointerFor } from '../../src/headers/derive.js';
import { jevText } from '../../src/headers/render.js';

const id = '01a0d3b2-0ac0-770d-9cb6-f76661b720af';

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
      { kind: 'team_member', role: 'PTY engineer', persona: 'Persona.', bytes: 8 },
      { whenToUse: 'Pick for terminal work', summary: null, keywords: ['pty'], stale: true },
    );
    expect(header).toMatchObject({ whenToUse: 'Pick for terminal work', summary: 'Persona.', keywords: ['pty'], source: 'authored', stale: true });
  });

  it('skills and memories ignore an authored header: their native field is the only source', () => {
    const header = deriveHeader(
      { id, name: 'deploy' },
      { kind: 'skill', description: 'Deploys', whenToUse: null, bytes: 1 },
      { whenToUse: 'nope', summary: 'nope', keywords: ['x'], stale: true },
    );
    expect(header).toMatchObject({ whenToUse: 'Deploys', summary: 'Deploys', keywords: [], source: 'native', stale: false });
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
    const collection = deriveHeader({ id, name: 'Runbooks' }, { kind: 'collection', description: 'Pick for prod', members: { doc: 2 } });
    expect(jevText(collection)).toBe('Runbooks: Pick for prod Contains 2 doc');
  });
});
