/**
 * The local account-file parsers behind the relay's R3 and R4 and the broker's B3 (review F03).
 * Strict by design: any line they cannot read whole fails the file, so nothing passes unseen.
 */
import { describe, expect, it } from 'vitest';
import { MAX_HOST_ID, parseGroupFile, parsePasswdFile } from '../../src/relay/host-identity.js';

describe('host account files (review F03, R3, R4 and B3)', () => {
  it('parses /etc/group: comments and blank lines skipped, members listed, every entry frozen', () => {
    const entries = parseGroupFile('# local groups\n\nroot:x:0:\n  # indented\nadm:x:4:syslog,admin\nusers$:*:100:a.b_c-d$\n');
    expect(entries).toEqual([
      { name: 'root', gid: 0, members: [] },
      { name: 'adm', gid: 4, members: ['syslog', 'admin'] },
      { name: 'users$', gid: 100, members: ['a.b_c-d$'] },
    ]);
    expect(entries!.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.members))).toBe(true);
    expect(parseGroupFile('')).toEqual([]);
    expect(parseGroupFile(`top:x:${MAX_HOST_ID}:\n`)).toEqual([{ name: 'top', gid: MAX_HOST_ID, members: [] }]);
  });

  it('refuses a group file with any line it cannot read whole', () => {
    for (const line of [
      '+', '+:::', '+@admins:::', '-docker:::', '+docker:x:999:', // NIS compat: entries from elsewhere
      'docker:x:999', 'docker:x:999::', 'docker:x:', // field count
      'docker:x::', 'docker:x:abc:', 'docker:x:0999:', 'docker:x:-1:', 'docker:x:+1:', 'docker:x:1e3:', 'docker:x: 999:',
      `docker:x:${MAX_HOST_ID + 1}:`, 'docker:x:99999999999:', // ids
      ':x:999:', '-:x:999:', 'do cker:x:999:', 'docker\t:x:999:', ' docker:x:999:', // names
      'docker:x:999:admin,', 'docker:x:999:,admin', 'docker:x:999:admin,,root', 'docker:x:999:+admins', 'docker:x:999:ad min', // members
    ]) {
      expect([line, parseGroupFile(`root:x:0:\n${line}\n`)]).toEqual([line, null]);
    }
  });

  it('parses /etc/passwd to name, uid and gid, and refuses a file with any line it cannot read whole', () => {
    const entries = parsePasswdFile('root:x:0:0:root:/root:/bin/bash\n# comment\n\nagent1:x:100001:20000:Agent, One:/home/agent1:/bin/sh\n');
    expect(entries).toEqual([{ name: 'root', uid: 0, gid: 0 }, { name: 'agent1', uid: 100001, gid: 20000 }]);
    expect(entries!.every((entry) => Object.isFrozen(entry))).toBe(true);
    for (const line of [
      '+', '+::::::', '+agent1::::::', '-agent1::::::', '+@agents::::::',
      'agent1:x:100001:100001::/home/agent1', 'agent1:x:100001:100001::/home/agent1:/bin/sh:extra',
      'agent1:x:abc:100001::/home/agent1:/bin/sh', 'agent1:x:100001:0100001::/home/agent1:/bin/sh',
      `agent1:x:${MAX_HOST_ID + 1}:1::/:/bin/sh`, `agent1:x:1:${MAX_HOST_ID + 1}::/:/bin/sh`, ':x:1:1::/:/bin/sh', ' agent1:x:1:1::/:/bin/sh',
    ]) {
      expect([line, parsePasswdFile(`root:x:0:0:root:/root:/bin/bash\n${line}\n`)]).toEqual([line, null]);
    }
  });
});
