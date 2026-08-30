// @vitest-environment jsdom
/**
 * THE STAGED CREATE DOOR, DRIVEN AS AN ACTION.
 *
 * `file-upload-create.test.tsx` next door proves the BUTTON never commits an
 * entity before the bytes exist. This file proves the same of the action the
 * root headers run, because the button is not what the headers call — the
 * defect (Tarkesh 01a04730) was precisely that a surface which could not host
 * the button therefore ran the generic create instead, and made eleven file
 * rows with `size_bytes 0` and a `storage_path` no blob was written to.
 *
 * Two properties, and both are negative:
 *   - a kind that declares `createForm: 'file-upload'` NEVER reaches the
 *     generic immediate create, whatever happens to the upload;
 *   - the caller is handed the UPLOAD'S OWN `CommandResult`, so a host that
 *     reconciles it has something to reconcile. The previous code fabricated
 *     `{patches: []}` and left the store never told about the id its caller
 *     then navigated to.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { allKinds, getKind } from '../domain';
import type { Seam } from '../data/seam';
import { stagedBirthFor } from './staged-birth';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom ships no WebCrypto; the upload task refuses to checksum without it,
// which is correct behaviour and not what these tests are about.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        ...globalThis.crypto,
        randomUUID: () => `id-${Math.random().toString(16).slice(2)}`,
        subtle: { digest: async () => new Uint8Array(32).buffer },
      },
    });
  }
});

const SPACE = 'space-1' as never;

/** The completion's patches, so a test can tell the real result from `[]`. */
const COMPLETION_PATCHES = [{ op: 'upsert', id: 'file-1' }];

function filesGroup(overrides: Partial<Seam['files']> = {}): Seam['files'] {
  return {
    uploadInit: vi.fn(async () => ({
      uploadId: 'u1',
      uploadUrl: '/v2/files/uploads/u1/content',
      token: 't',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxSizeBytes: 10_000_000,
    })),
    putBytes: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({
      patches: COMPLETION_PATCHES,
      entity: {
        id: 'file-1',
        kind: 'file',
        title: 'notes.txt',
        state: { kind: 'file', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5 },
        createdBy: { id: 'm1', displayName: 'Someone', isAgent: false, avatar: null },
        createdAt: '2026-08-12T00:00:00Z',
      },
    })),
    abort: vi.fn(async () => ({ patches: [] })),
    downloadHref: (id: string) => `/v2/files/${id}/download`,
    ...overrides,
  } as unknown as Seam['files'];
}

/** Drives the OS picker `pickFiles` opens, without a real file dialog. */
function stubPicker(files: File[]): void {
  const realClick = HTMLInputElement.prototype.click;
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    if (this.type !== 'file') {
      realClick.call(this);
      return;
    }
    Object.defineProperty(this, 'files', { value: files, configurable: true });
    this.dispatchEvent(new Event('change'));
  });
}

/** The kinds the REGISTRY says have a staged upload door — never a literal. */
const uploadKinds = allKinds().filter((k) => k.createForm === 'file-upload');

describe('stagedBirthFor', () => {
  it('answers with an action for every kind the registry gives an upload door', () => {
    // The both-halves control: a registry with no such kind would make every
    // assertion below vacuous, which is the shape of a guard that survives the
    // thing it guards being deleted.
    expect(uploadKinds.length).toBeGreaterThan(0);
    for (const config of uploadKinds) {
      expect(
        stagedBirthFor(config, { spaceId: SPACE, files: filesGroup() }),
        `${config.kind} declares an upload door but stagedBirthFor refused it`,
      ).toBeTypeOf('function');
    }
  });

  it('answers null for a kind with no create form, so the generic flow keeps it', () => {
    // Null is "carry on", not "refuse". A caller that read it as a refusal
    // would disable ＋ on every ordinary kind in the menu.
    const plain = allKinds().filter((k) => k.createForm === undefined);
    expect(plain.length).toBeGreaterThan(0);
    for (const config of plain) {
      expect(stagedBirthFor(config, { spaceId: SPACE, files: filesGroup() })).toBeNull();
    }
  });

  it('answers null for the scheduled-work form, which has no headless action', () => {
    // Documented behaviour, not an oversight: a loop's door is a dialog with
    // fields, so a header has nothing to run. Asserted so that changing it is
    // a decision rather than a side effect.
    const scheduled = allKinds().filter((k) => k.createForm === 'scheduled-work');
    expect(scheduled.length).toBeGreaterThan(0);
    for (const config of scheduled) {
      expect(stagedBirthFor(config, { spaceId: SPACE, files: filesGroup() })).toBeNull();
    }
  });
});

describe('running the staged birth', () => {
  const config = uploadKinds[0]!;

  it('uploads the bytes first and hands back the id the node stored', async () => {
    const files = filesGroup();
    const created = vi.fn();
    stubPicker([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);

    stagedBirthFor(config, { spaceId: SPACE, files, onCreated: created })!();

    await vi.waitFor(() => expect(created).toHaveBeenCalled());
    expect(files.uploadInit).toHaveBeenCalled();
    expect(files.putBytes).toHaveBeenCalled();
    expect(files.complete).toHaveBeenCalled();
  });

  it('carries the COMPLETION’s own result, so a host has something to reconcile', async () => {
    // The regression this replaced: `{patches: []}` told the store nothing,
    // and the host then navigated to an id the store had never heard of.
    const files = filesGroup();
    const created = vi.fn();
    stubPicker([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);

    stagedBirthFor(config, { spaceId: SPACE, files, onCreated: created })!();

    await vi.waitFor(() => expect(created).toHaveBeenCalled());
    expect(created).toHaveBeenCalledWith('file-1', expect.objectContaining({ patches: COMPLETION_PATCHES }));
  });

  it('creates nothing when the upload fails, and says why', async () => {
    const files = filesGroup({
      putBytes: vi.fn(async () => {
        throw Object.assign(new Error('nope'), { code: 'payload_too_large' });
      }),
    });
    const created = vi.fn();
    const notices: string[] = [];
    stubPicker([new File(['hello'], 'big.bin')]);

    stagedBirthFor(config, {
      spaceId: SPACE,
      files,
      onCreated: created,
      onNotice: (t) => notices.push(t),
    })!();

    await vi.waitFor(() => expect(notices.length).toBe(1));
    expect(created).not.toHaveBeenCalled();
    expect(files.complete).not.toHaveBeenCalled();
    // A failed upload releases its grant rather than orphaning the slot.
    expect(files.abort).toHaveBeenCalled();
    expect(notices[0]).toContain('big.bin');
  });

  it('does nothing at all when the picker is dismissed', async () => {
    const files = filesGroup();
    const created = vi.fn();
    const notices: string[] = [];
    stubPicker([]);

    stagedBirthFor(config, {
      spaceId: SPACE,
      files,
      onCreated: created,
      onNotice: (t) => notices.push(t),
    })!();

    await vi.waitFor(() => expect(files.uploadInit).not.toHaveBeenCalled());
    expect(created).not.toHaveBeenCalled();
    // Dismissing a dialog is not a failure, so it raises no notice either.
    expect(notices).toEqual([]);
  });
});

describe('the kind this door belongs to', () => {
  it('is reached through registry data and not named here', () => {
    // §15.2 restated as a behaviour: the door is found by asking the registry
    // which kinds declare it. If the `file` row ever loses `createForm`, this
    // lane does not quietly keep working against a hard-coded name — the
    // first test in this file goes red instead.
    for (const config of uploadKinds) {
      expect(getKind(config.kind).createForm).toBe('file-upload');
    }
  });
});
