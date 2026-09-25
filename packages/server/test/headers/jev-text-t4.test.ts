/**
 * Headers T4 (integrated design 01a0d348 §8 I7): what Ask Jev is shown gains
 * a memory's `subject_scope` and an authored header's keywords, and both go
 * through the same redact-before-cut rule as every other field (#805).
 */
import type { SelectionHeader } from '@tm8/contract';
import { REDACTION_MARKER } from '@tm8/execution';
import { describe, expect, it } from 'vitest';

import { HEADER_TEXT_LIMIT } from '../../src/headers/derive.js';
import { jevText } from '../../src/headers/render.js';

const header = (over: Partial<SelectionHeader>): SelectionHeader => ({
  entityId: '00000000-0000-4000-8000-000000000001', kind: 'memory', name: 'n', whenToUse: null, summary: null,
  keywords: [], source: 'native', stale: false, bytes: null, loadPointer: 'tm8 entity context x', ...over,
});

const KEY = `ghp_${'C'.repeat(36)}`;

describe('jevText — memories carry their scope (T4)', () => {
  it('appends the subject_scope after the statement', () => {
    expect(jevText(header({ summary: 'Deploys go through utho.', whenToUse: 'prod deploys' }))).toBe('Deploys go through utho. (scope: prod deploys)');
  });

  it('a memory with no scope (or a blank one) is its statement, as before T4', () => {
    expect(jevText(header({ summary: 'claim' }))).toBe('claim');
    expect(jevText(header({ summary: 'claim', whenToUse: '   ' }))).toBe('claim');
  });

  it('cuts each field on its own at the limit, redacting before the cut', () => {
    const scope = `${'s'.repeat(HEADER_TEXT_LIMIT - 10)} ${KEY}`;
    const out = jevText(header({ summary: 'claim', whenToUse: scope }));
    expect(out.startsWith('claim (scope: ')).toBe(true);
    expect(out).not.toContain('ghp_');
    // The key straddled the cut: redacted first, so not even its prefix survives.
    expect(out).toContain(REDACTION_MARKER.slice(0, 3));
  });
});

describe('jevText — an authored header\'s keywords join the text (T4)', () => {
  it('a teammate: after the persona', () => {
    const teammate = header({ kind: 'team_member', name: 'Draco', whenToUse: 'terminal work', summary: 'Owns the PTY seam.', keywords: ['pty', 'xterm'], source: 'authored' });
    expect(jevText(teammate, { equippedSkills: ['deploy'] })).toBe('Draco — terminal work. Equipped with: deploy. Owns the PTY seam. Keywords: pty, xterm.');
  });

  it('a reference: after when and what', () => {
    const doc = header({ kind: 'doc', name: 'Runbook', whenToUse: 'when deploying', summary: 'Steps.', keywords: ['deploy'], source: 'authored' });
    expect(jevText(doc)).toBe('Runbook: when deploying Steps. Keywords: deploy.');
  });

  it('no keywords, no part: a derived header reads as before', () => {
    expect(jevText(header({ kind: 'doc', name: 'Runbook', summary: 'Steps.', source: 'derived' }))).toBe('Runbook: Steps.');
  });

  it('a credential in a keyword is redacted, never shipped', () => {
    const out = jevText(header({ kind: 'doc', name: 'R', summary: 'S', keywords: [KEY], source: 'authored' }));
    expect(out).not.toContain('ghp_');
  });
});
