/**
 * Refuse-to-start behaviour on a version mismatch — SIDECAR-PACKAGING.md §4.
 *
 * The operator-facing text is asserted verbatim-ish because it is the product:
 * when this fires, the message *is* the recovery procedure, and a message that
 * omits the dump path leaves the user with nothing.
 */

import { describe, expect, it } from 'vitest';

import { isSidecarError } from '../../src/sidecar/errors.js';
import { refuseDowngrade, upgradeFailureMessage } from '../../src/sidecar/upgrade.js';

describe('downgrade', () => {
  it('refuses with MajorDowngrade before touching anything', () => {
    try {
      refuseDowngrade(18, 19, '/Users/x/.tm8/pg/19');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isSidecarError(e)).toBe(true);
      if (!isSidecarError(e)) return;
      expect(e.code).toBe('MajorDowngrade');
      expect(e.message).toContain('bundles Postgres 18');
      expect(e.message).toContain('created by\nPostgres 19');
      expect(e.message).toContain('will NOT touch your data');
      // Nothing on disk is referenced as modified, and no backup is claimed.
      expect(e.backupPath).toBeUndefined();
    }
  });
});

describe('upgrade failure message', () => {
  it('names the dump path and a working pg_restore command', () => {
    const path = '/Users/x/.tm8/backups/pre-migration/premigrate_18-19_20260725T140322Z.dump';
    const msg = upgradeFailureMessage(18, 19, path, 'tm8');

    expect(msg).toContain('Postgres major upgrade 18 -> 19 failed');
    expect(msg).toContain('Your data was NOT modified');
    expect(msg).toContain(path);
    expect(msg).toContain(`pg_restore --clean --if-exists -d tm8 ${path}`);
    expect(msg).toContain('Nothing was upgraded');
  });
});
