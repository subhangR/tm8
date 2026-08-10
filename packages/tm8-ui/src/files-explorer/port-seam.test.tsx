// @vitest-environment jsdom
/**
 * `filesExplorerPortFromSeam` against a REAL `createFixtureSeam()` —
 * assertions on what comes BACK, never on what was called (the four-links
 * lesson `files/port-seam.test.tsx` records).
 */
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data';
import { EXPLORER_REASONS, LIBRARY_ROOT_ID, filesExplorerPortFromSeam } from './port';

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

  it('declares upload; folder capabilities follow the SEAM, not wishful thinking', async () => {
    const { port } = await portAndSpace();
    expect(port.upload).toBeDefined();
    expect(port.upload!.preservesPaths).toBe(false);
    // The fixture seam has no filesystem, so it carries neither
    // `projectFolderUploads` nor `projectSetup` — and the port must answer
    // that truth with an ABSENT capability (disabled-with-reason render),
    // not a member that would light controls this seam cannot honour.
    expect(port.importFolder).toBeUndefined();
    expect(port.createFolder).toBeUndefined();
    expect(port.move).toBeUndefined();
  });

  it('a resolved NON-ADMIN viewer withholds importFolder with the truthful reason — only when the seam serves the ops', async () => {
    const { seam, spaceId } = await portAndSpace();

    // Ops absent (this fixture): absence keeps the not-served reason path;
    // the role reason would be a lie about what this node can do.
    const withoutOps = filesExplorerPortFromSeam(seam, spaceId, false);
    expect(withoutOps.importFolder).toBeUndefined();
    expect(withoutOps.importFolderBlockedReason).toBeUndefined();

    const served = {
      ...seam,
      projectFolderUploads: {
        init: async () => {
          throw new Error('unused');
        },
        complete: async () => {
          throw new Error('unused');
        },
        abort: async () => {
          throw new Error('unused');
        },
      },
      projectSetup: {
        directories: async () => {
          throw new Error('unused');
        },
        createSpace: async () => {
          throw new Error('unused');
        },
        createProject: async () => {
          throw new Error('unused');
        },
        linkProject: async () => {
          throw new Error('unused');
        },
      },
    };

    // Ops present + viewer known non-admin: withheld UP FRONT with the
    // truthful copy — never an enabled picker that refuses after selection.
    const blocked = filesExplorerPortFromSeam(served as never, spaceId, false);
    expect(blocked.importFolder).toBeUndefined();
    expect(blocked.importFolderBlockedReason).toBe(EXPLORER_REASONS.FOLDER_IMPORT_FORBIDDEN);

    // Ops present + admin, or an UNRESOLVED viewer: capability stays, and
    // the in-flow authorize remains the server-truth backstop.
    const admin = filesExplorerPortFromSeam(served as never, spaceId, true);
    expect(admin.importFolder).toBeDefined();
    expect(admin.importFolderBlockedReason).toBeUndefined();
    const unknown = filesExplorerPortFromSeam(served as never, spaceId, null);
    expect(unknown.importFolder).toBeDefined();
    expect(unknown.importFolderBlockedReason).toBeUndefined();
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
