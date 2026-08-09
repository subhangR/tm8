// @vitest-environment jsdom
/**
 * `filesExplorerPortFromSeam` against a REAL `createFixtureSeam()` —
 * assertions on what comes BACK, never on what was called (the four-links
 * lesson `files/port-seam.test.tsx` records).
 */
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data';
import { LIBRARY_ROOT_ID, filesExplorerPortFromSeam } from './port';

async function portAndSpace() {
  const seam = createFixtureSeam();
  const spaces = await seam.spaces();
  expect(spaces.length).toBeGreaterThan(0);
  const spaceId = spaces[0]!.id;
  return { seam, port: filesExplorerPortFromSeam(seam, spaceId), spaceId };
}

describe('the explorer port over a real fixture seam', () => {
  it('always answers a writable Library root first', async () => {
    const { port } = await portAndSpace();
    const roots = await port.roots();
    expect(roots[0]).toMatchObject({ id: LIBRARY_ROOT_ID, kind: 'library', writable: true });
  });

  it('lists REAL file entities under the Library root, with entity ids and versions', async () => {
    const { port } = await portAndSpace();
    const roots = await port.roots();
    const listing = await port.list(roots[0]!, '');
    // A green empty here would prove the function runs and nothing else.
    expect(listing.entries.length).toBeGreaterThan(0);
    for (const entry of listing.entries) {
      expect(entry.type).toBe('file');
      expect(entry.entityId).not.toBeNull();
      expect(entry.trashed).toBe(false);
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it('answers a download href for a library entry and null for an entity-less one', async () => {
    const { port } = await portAndSpace();
    const roots = await port.roots();
    const listing = await port.list(roots[0]!, '');
    const entry = listing.entries[0]!;
    expect(port.downloadHref(entry)).toBeTruthy();
    expect(port.downloadHref({ ...entry, entityId: null })).toBeNull();
  });

  it('declares upload but NOT the unpublished folder capabilities — the R7 posture', async () => {
    const { port } = await portAndSpace();
    expect(port.upload).toBeDefined();
    expect(port.upload!.preservesPaths).toBe(false);
    // Bind these ONLY when the backend lane publishes its operations; a
    // defined member here would light controls no node can honour.
    expect(port.importFolder).toBeUndefined();
    expect(port.createFolder).toBeUndefined();
    expect(port.move).toBeUndefined();
  });

  it('project roots surface when the seam lists projects; each is read-only', async () => {
    const { port } = await portAndSpace();
    const roots = await port.roots();
    for (const root of roots.slice(1)) {
      expect(root.kind).toBe('project');
      expect(root.writable).toBe(false);
    }
  });
});
