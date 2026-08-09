import { describe, expect, it } from 'vitest';

import {
  SpaceFolderCreateInputSchema,
  SpaceFolderIngestInputSchema,
} from '../src/schemas.js';

const UPLOAD_ID = '11111111-2222-4333-8444-555555555555';

function ingest(extra: Record<string, unknown>) {
  return SpaceFolderIngestInputSchema.safeParse({
    clientMutationId: 'cmid-1',
    uploadId: UPLOAD_ID,
    ...extra,
  });
}

describe('SpaceFolderCreateInput', () => {
  it('accepts a user-chosen name and trims it', () => {
    const parsed = SpaceFolderCreateInputSchema.safeParse({ name: '  Design docs  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe('Design docs');
  });

  it('refuses a name that is only whitespace', () => {
    expect(SpaceFolderCreateInputSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('refuses a name past 200 characters', () => {
    expect(SpaceFolderCreateInputSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('SpaceFolderIngestInput destPath', () => {
  it('accepts an omitted destPath — the folder root', () => {
    expect(ingest({}).success).toBe(true);
  });

  it("accepts the empty string, which names the folder root explicitly", () => {
    expect(ingest({ destPath: '' }).success).toBe(true);
  });

  it('accepts a normalised nested path', () => {
    expect(ingest({ destPath: 'src/components' }).success).toBe(true);
  });

  // The nine adversarial path shapes the ingest validator must also refuse BY
  // NAME. Here they are refused at the WIRE, before a handler ever runs — this
  // is the shape gate, not the per-member validator, and the two are
  // deliberately separate: a bad destPath fails the whole request, while a bad
  // MEMBER is reported in `skipped[]` and the rest of the archive still lands.
  const refused: Array<[string, string]> = [
    ['a parent traversal segment', 'src/../../etc/passwd'],
    ['a bare parent segment', '..'],
    ['a current-directory segment', 'src/./lib'],
    ['an absolute path', '/etc/passwd'],
    ['a trailing slash', 'src/'],
    ['a doubled separator', 'src//lib'],
    ['a backslash-encoded traversal', 'src\\..\\..\\windows'],
    ['a NUL byte', 'src/evil\u0000.txt'],
    ['an over-long path', `${'a'.repeat(1025)}`],
  ];

  for (const [label, value] of refused) {
    it(`refuses ${label}`, () => {
      expect(ingest({ destPath: value }).success).toBe(false);
    });
  }

  it('refuses an uploadId that is not a uuid', () => {
    expect(SpaceFolderIngestInputSchema.safeParse({
      clientMutationId: 'cmid-1',
      uploadId: 'not-a-uuid',
    }).success).toBe(false);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(ingest({ folderId: 'smuggled' }).success).toBe(false);
  });
});
