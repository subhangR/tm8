import { describe, expect, it } from 'vitest';

import { broadWorkingDirReason, broadWorkingDirWarning } from './working-dir-risk';

describe('broadWorkingDirReason', () => {
  it('names the filesystem root on both flavours', () => {
    expect(broadWorkingDirReason('/', '/')).toBe('the root of the whole filesystem');
    expect(broadWorkingDirReason('C:\\', '\\')).toBe('the root of the whole filesystem');
    // A trailing separator is the same directory, not a deeper one.
    expect(broadWorkingDirReason('//', '/')).toBe('the root of the whole filesystem');
  });

  it('names the container of every home directory', () => {
    for (const path of ['/home', '/Users', '/home/']) {
      expect(broadWorkingDirReason(path, '/')).toBe("the folder that holds every user's home directory");
    }
    expect(broadWorkingDirReason('C:\\Users', '\\')).toBe("the folder that holds every user's home directory");
  });

  it("names a whole user's home, which is the likeliest slip", () => {
    expect(broadWorkingDirReason('/home/tm8', '/')).toBe("an entire user's home directory");
    expect(broadWorkingDirReason('/Users/ada', '/')).toBe("an entire user's home directory");
    expect(broadWorkingDirReason('C:\\Users\\ada', '\\')).toBe("an entire user's home directory");
    expect(broadWorkingDirReason('/root', '/')).toBe("the root user's home directory");
  });

  it('stays quiet for an ordinary project directory', () => {
    expect(broadWorkingDirReason('/home/tm8/projects/tm8', '/')).toBeNull();
    expect(broadWorkingDirReason('/opt/tm8/prod', '/')).toBeNull();
    expect(broadWorkingDirReason('/srv/app', '/')).toBeNull();
    expect(broadWorkingDirReason('C:\\Users\\ada\\code\\app', '\\')).toBeNull();
    // `/opt` and `/var` are broad but they are not home directories and they
    // are legitimate deployment roots; warning on them would be noise that
    // teaches admins to click through the warning that matters.
    expect(broadWorkingDirReason('/opt', '/')).toBeNull();
  });

  it('says nothing about an empty or non-absolute path — validation owns that', () => {
    expect(broadWorkingDirReason('', '/')).toBeNull();
    expect(broadWorkingDirReason('   ', '/')).toBeNull();
    expect(broadWorkingDirReason('relative/path', '/')).toBeNull();
    expect(broadWorkingDirReason('/home/tm8', '\\')).toBeNull();
  });

  it('reads as a sentence when composed', () => {
    const reason = broadWorkingDirReason('/', '/')!;
    expect(broadWorkingDirWarning(reason)).toContain('This folder is the root of the whole filesystem.');
    expect(broadWorkingDirWarning(reason)).toContain('Every member of this space will be able to read');
  });
});
