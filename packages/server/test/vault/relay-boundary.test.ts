/**
 * The relay's agent-boundary preconditions (independent review F03; design doc 01a1fe13, section 4,
 * checks R1 to R6 and R8; src/vault/boundary.ts). relay-config.test.ts runs them through boot.
 *
 * R1 to R6 run on a synthetic host view: no test here reads this machine's /etc or /proc, so a
 * pass or a refusal below says nothing about the host the suite runs on. R8 runs on throwaway EC
 * certificates openssl makes at runtime; none is printed, and none leaves the temporary directory.
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTAINER_SOCKETS } from '@tm8/vault/relay';

import {
  AGENT_RUN_AS_KNOB, FORBIDDEN_AGENT_GROUPS, RELAY_TLS_CA_KNOB, RELAY_TLS_CERT_KNOB, RELAY_TLS_KEY_KNOB,
  checkRelayBoundary, checkRelayTlsMaterial, parseAgentRunAs, type AgentRunAs, type BoundaryFailure, type BoundaryFile,
  type HostEntryStat, type VaultHostView,
} from '../../src/vault/boundary.js';
import { VaultBoundaryError, VaultRelayConfigError } from '../../src/vault/config.js';

const SIGNING_KNOB = 'TM8_VAULT_RELAY_PRIVATE_KEY_FILE';
const DIR = 0o040000;
const FILE = 0o100000;
const LINK = 0o120000;
/** The relay's own uid and private group on the synthetic host. */
const SERVER_UID = 990;

/** The four files config.ts checks for a mutual-TLS target, in its order. */
const FILES: readonly BoundaryFile[] = [
  { knob: RELAY_TLS_KEY_KNOB, path: '/srv/tm8-relay/tls.key' },
  { knob: RELAY_TLS_CERT_KNOB, path: '/srv/tm8-relay/tls.crt' },
  { knob: RELAY_TLS_CA_KNOB, path: '/srv/tm8-relay/ca.crt' },
  { knob: SIGNING_KNOB, path: '/srv/tm8-relay/relay.key' },
];
/** A socket target: the signing key alone. */
const SIGNING: readonly BoundaryFile[] = [FILES[3]!];

const RANGE: AgentRunAs = parseAgentRunAs('uids:100000-165535')!;

function limitsText(soft: string, hard: string): string {
  return [
    'Limit                     Soft Limit           Hard Limit           Units     ',
    'Max cpu time              unlimited            unlimited            seconds   ',
    `Max core file size        ${soft.padEnd(21)}${hard.padEnd(21)}bytes     `,
    '',
  ].join('\n');
}
const procLine = (mountPoint: string, options: string): string => `22 1 0:21 / ${mountPoint} rw,nosuid,nodev,noexec,relatime shared:12 - proc proc ${options}`;
const SYS_LINE = '23 1 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw';

/**
 * A host that meets every check for RANGE: agent1 and agent2 hold agent uids, agent2's primary
 * group is `agents`, and nothing an agent holds is forbidden.
 */
const HARDENED_TEXT: Readonly<Record<string, string>> = {
  '/etc/group': [
    '# local groups', 'root:x:0:', 'adm:x:4:syslog', 'sudo:x:27:admin', 'docker:x:999:admin', `tm8-relay:x:${SERVER_UID}:`,
    'agents:x:20000:agent1,agent2', '',
  ].join('\n'),
  '/etc/passwd': [
    'root:x:0:0:root:/root:/bin/bash', 'syslog:x:104:110::/home/syslog:/usr/sbin/nologin', 'admin:x:1000:1000::/home/admin:/bin/bash',
    `tm8-relay:x:${SERVER_UID}:${SERVER_UID}::/srv/tm8-relay:/usr/sbin/nologin`,
    'agent1:x:100001:100001::/home/agent1:/bin/sh', 'agent2:x:100002:20000::/home/agent2:/bin/sh', '',
  ].join('\n'),
  '/proc/sys/kernel/yama/ptrace_scope': '1\n',
  '/proc/self/mountinfo': [procLine('/proc', 'rw,hidepid=invisible'), SYS_LINE, ''].join('\n'),
  '/proc/self/limits': limitsText('0', '0'),
  '/proc/sys/kernel/core_pattern': 'core\n',
};
const HOST_FILES = Object.keys(HARDENED_TEXT);

const HARDENED_ENTRIES: Readonly<Record<string, HostEntryStat>> = {
  '/': { uid: 0, gid: 0, mode: DIR | 0o755 },
  '/srv': { uid: 0, gid: 0, mode: DIR | 0o755 },
  '/srv/tm8-relay': { uid: SERVER_UID, gid: SERVER_UID, mode: DIR | 0o700 },
  '/srv/tm8-relay/tls.key': { uid: SERVER_UID, gid: SERVER_UID, mode: FILE | 0o600 },
  '/srv/tm8-relay/tls.crt': { uid: SERVER_UID, gid: SERVER_UID, mode: FILE | 0o644 },
  '/srv/tm8-relay/ca.crt': { uid: SERVER_UID, gid: SERVER_UID, mode: FILE | 0o644 },
  '/srv/tm8-relay/relay.key': { uid: SERVER_UID, gid: SERVER_UID, mode: FILE | 0o600 },
};

interface HostShape {
  readonly uid?: number;
  readonly gids?: readonly number[] | null;
  /** Overrides an entry; null removes it. */
  readonly entries?: Readonly<Record<string, HostEntryStat | null>>;
  /** Symbolic links, by absolute path, to absolute targets. */
  readonly links?: Readonly<Record<string, string>>;
  /** Overrides a file; null makes it unreadable. */
  readonly text?: Readonly<Record<string, string | null>>;
  /** What this process may connect to. */
  readonly writable?: readonly string[];
}

/** The synthetic view, and every path its readText was asked for. lstat and realpath resolve as the kernel does. */
function synthetic(shape: HostShape = {}): { view: VaultHostView; reads: string[] } {
  const entries: Record<string, HostEntryStat | null> = { ...HARDENED_ENTRIES, ...shape.entries };
  const text: Record<string, string | null> = { ...HARDENED_TEXT, ...shape.text };
  const links = shape.links ?? {};
  const reads: string[] = [];
  // Every component but the last is followed, as lstat follows them; realpath follows the last too.
  const resolve = (path: string, followLast: boolean): string => {
    const parts = posix.normalize(path).split('/').filter((part) => part !== '');
    let current = '';
    parts.forEach((part, index) => {
      current = `${current}/${part}`;
      if (!followLast && index === parts.length - 1) return;
      for (let hops = 0; links[current] !== undefined && hops < 8; hops += 1) current = links[current]!;
    });
    return current === '' ? '/' : current;
  };
  const view: VaultHostView = {
    uid: () => shape.uid ?? SERVER_UID,
    gids: () => (shape.gids === undefined ? [SERVER_UID] : shape.gids),
    lstat: (path) => {
      if (!posix.isAbsolute(path)) return null;
      const at = resolve(path, false);
      return links[at] !== undefined ? { uid: SERVER_UID, gid: SERVER_UID, mode: LINK | 0o777 } : entries[at] ?? null;
    },
    realpath: (path) => {
      if (!posix.isAbsolute(path)) return null;
      const at = resolve(path, true);
      return entries[at] ? at : null;
    },
    readText: (path) => { reads.push(path); return text[path] ?? null; },
    canWrite: (path) => (shape.writable ?? []).includes(path),
    now: () => 0,
  };
  return { view, reads };
}

const check = (shape: HostShape = {}, runAs: AgentRunAs = RANGE, files: readonly BoundaryFile[] = FILES): BoundaryFailure[] =>
  checkRelayBoundary(synthetic(shape).view, runAs, files);
const host = (id: BoundaryFailure['check'], rule: string): BoundaryFailure => ({ check: id, knob: AGENT_RUN_AS_KNOB, rule });
const groupFile = (...lines: string[]): string => [...lines, ''].join('\n');

describe('parseAgentRunAs: TM8_VAULT_AGENT_RUN_AS (review F03, D5; the owner picks the variant, D2)', () => {
  it('reads each of the three forms as a closed interval of host uids, trimmed and frozen', () => {
    expect(parseAgentRunAs('uid:1001')).toEqual({ variant: 'uid', first: 1001, last: 1001 });
    expect(parseAgentRunAs('uids:100000-165535')).toEqual({ variant: 'uids', first: 100000, last: 165535 });
    expect(parseAgentRunAs('gvisor:200000-265535')).toEqual({ variant: 'gvisor', first: 200000, last: 265535 });
    expect(parseAgentRunAs(' uids:7-7\n')).toEqual({ variant: 'uids', first: 7, last: 7 });
    expect(parseAgentRunAs('uid:1')).toEqual({ variant: 'uid', first: 1, last: 1 });
    expect(parseAgentRunAs('uids:1-4294967294')).toEqual({ variant: 'uids', first: 1, last: 4294967294 });
    expect(Object.isFrozen(parseAgentRunAs('uid:1001'))).toBe(true);
  });

  it('refuses root, (uid_t)-1, a reversed range and every other spelling, so a typo never passes', () => {
    for (const value of [
      'uid:0', 'uids:0-10', 'gvisor:0-10', 'uid:4294967295', 'uids:1-4294967295', 'uid:9999999999', 'uid:99999999999', 'uids:10-9',
      'uid:01001', 'uids:0100-0200', 'uid:+1001', 'uid:-1', 'uid:0x3e9', 'uid:1e3', 'uid:1_001', 'uid:1001.0',
      'uid:tm8-agent', 'tm8-agent', '1001', 'UID:1001', 'Uids:1-2', 'uid: 1001', 'uid :1001', 'uids:1 -2', 'uid:10\n01',
      'uid:1001,1002', 'uid:1001-1002', 'uids:1001', 'gvisor:1001', 'uids:1-2-3', 'uids:1-2,3-4', 'bwrap:1-2', 'gid:1001',
      'uid:', 'uids:-', ':1001',
    ]) {
      expect([value, parseAgentRunAs(value)]).toEqual([value, null]);
    }
  });

  it('unset or blank is undefined: production refuses that, and the other modes then check nothing more', () => {
    for (const value of [undefined, '', '   ', '\t\n']) expect(parseAgentRunAs(value)).toBeUndefined();
  });
});

describe('checkRelayBoundary, R1 to R6, on a synthetic host', () => {
  it('a hardened host passes under each variant, and only the account files and /proc are read, never a key file', () => {
    for (const runAs of ['uid:100001', 'uids:100000-165535', 'gvisor:200000-265535']) {
      const { view, reads } = synthetic();
      expect([runAs, checkRelayBoundary(view, parseAgentRunAs(runAs)!, FILES)]).toEqual([runAs, []]);
      expect(reads.every((path) => HOST_FILES.includes(path))).toBe(true);
      // gVisor gives each sandbox its own /proc, so this process's mounts say nothing about it.
      expect(reads.includes('/proc/self/mountinfo')).toBe(runAs.startsWith('gvisor:') ? false : true);
    }
  });

  it('R1: agents may not run as this server, and no file the relay reads may be an agent\'s', () => {
    const own = "includes this server's own uid (990): agents would run as the relay and could read its keys";
    for (const runAs of ['uid:990', 'uids:900-1000', 'gvisor:990-991']) {
      const failures = check({}, parseAgentRunAs(runAs)!);
      expect(failures[0]).toEqual(host('R1', own));
      // Every file is the server's, so each is now an agent's too.
      expect(failures.filter((failure) => failure.check === 'R1').map((failure) => failure.knob)).toEqual([AGENT_RUN_AS_KNOB, ...FILES.map((file) => file.knob)]);
    }
    expect(check({ uid: -1 })).toEqual([host('R1', 'cannot be checked: this process has no uid')]);
    expect(check({ entries: { '/srv/tm8-relay/tls.crt': { uid: 100001, gid: 100001, mode: FILE | 0o644 } } }))
      .toEqual([{ check: 'R1', knob: RELAY_TLS_CERT_KNOB, rule: 'names a file owned by uid 100001, an agent uid' }]);
    // A uid just outside the range is not an agent's.
    expect(check({ entries: { '/srv/tm8-relay/tls.crt': { uid: 99999, gid: 99999, mode: FILE | 0o644 } } })).toEqual([]);
    expect(check({ entries: { '/srv/tm8-relay/relay.key': null } })).toEqual([
      { check: 'R1', knob: SIGNING_KNOB, rule: 'cannot be checked: the file cannot be inspected' },
      { check: 'R2', knob: SIGNING_KNOB, rule: 'cannot be checked: the path does not resolve' },
    ]);
  });

  it('R2: the path is canonical, and neither the file nor any directory up to / can be replaced by an agent, a group or others', () => {
    const canonical = 'must be a canonical path with no symbolic link, "." or ".." in it';
    // A link to the key, a link in the path, and ".", ".." and "//" spellings of a real path.
    expect(check({ links: { '/srv/tm8-relay/link.key': '/srv/tm8-relay/relay.key' } }, RANGE, [{ knob: SIGNING_KNOB, path: '/srv/tm8-relay/link.key' }]))
      .toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: canonical }]);
    expect(check({ links: { '/opt': '/srv' } }, RANGE, [{ knob: SIGNING_KNOB, path: '/opt/tm8-relay/relay.key' }]))
      .toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: canonical }]);
    for (const path of ['/srv/tm8-relay/../tm8-relay/relay.key', '/srv/./tm8-relay/relay.key', '/srv//tm8-relay/relay.key']) {
      expect([path, check({}, RANGE, [{ knob: SIGNING_KNOB, path }])]).toEqual([path, [{ check: 'R2', knob: SIGNING_KNOB, rule: canonical }]]);
    }
    expect(check({}, RANGE, [{ knob: SIGNING_KNOB, path: 'tm8-relay/relay.key' }])).toEqual([
      { check: 'R1', knob: SIGNING_KNOB, rule: 'cannot be checked: the file cannot be inspected' },
      { check: 'R2', knob: SIGNING_KNOB, rule: 'must be an absolute path' },
    ]);

    // The file itself: a certificate is not owner-only, but group or others may never write it.
    for (const mode of [0o664, 0o646, 0o666]) {
      expect(check({ entries: { '/srv/tm8-relay/tls.crt': { uid: SERVER_UID, gid: SERVER_UID, mode: FILE | mode } } }))
        .toEqual([{ check: 'R2', knob: RELAY_TLS_CERT_KNOB, rule: 'names a file that group or others can write' }]);
    }

    // A directory on the path, up to and including /.
    const dir = (path: string, stat: HostEntryStat | null, files: readonly BoundaryFile[] = SIGNING) => check({ entries: { [path]: stat } }, RANGE, files);
    for (const mode of [0o775, 0o757, 0o777, 0o770]) {
      expect(dir('/srv', { uid: 0, gid: 0, mode: DIR | mode }))
        .toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: 'is under a directory that group or others can write: "/srv"' }]);
    }
    expect(dir('/', { uid: 0, gid: 0, mode: DIR | 0o757 }))
      .toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: 'is under a directory that group or others can write: "/"' }]);
    // The sticky bit lets only an entry's owner rename or remove it, so /tmp-like directories pass, as the design says.
    expect(dir('/srv', { uid: 0, gid: 0, mode: DIR | 0o1777 })).toEqual([]);
    expect(dir('/srv', { uid: 0, gid: 0, mode: DIR | 0o1775 })).toEqual([]);
    // An agent-owned directory is refused whatever its mode: its owner may rename anything in it.
    for (const mode of [0o700, 0o1700, 0o755]) {
      expect(dir('/srv/tm8-relay', { uid: 100001, gid: 100001, mode: DIR | mode }))
        .toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: 'is under a directory owned by uid 100001, an agent uid: "/srv/tm8-relay"' }]);
    }
    expect(dir('/srv', { uid: 0, gid: 0, mode: FILE | 0o755 }))
      .toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: 'has a parent that is not a directory: "/srv"' }]);
    expect(dir('/srv', null)).toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: 'cannot be checked: "/srv" cannot be inspected' }]);
    // Every file is checked and named.
    expect(dir('/srv', { uid: 0, gid: 0, mode: DIR | 0o775 }, FILES).map((failure) => failure.knob)).toEqual(FILES.map((file) => file.knob));

    // A path is quoted, so a control character in it cannot forge a line of the message.
    const odd = '/srv/we\nird';
    const failures = check({ entries: { [odd]: { uid: 0, gid: 0, mode: DIR | 0o777 }, [`${odd}/relay.key`]: { uid: SERVER_UID, gid: SERVER_UID, mode: FILE | 0o600 } } },
      RANGE, [{ knob: SIGNING_KNOB, path: `${odd}/relay.key` }]);
    expect(failures).toEqual([{ check: 'R2', knob: SIGNING_KNOB, rule: 'is under a directory that group or others can write: "/srv/we\\nird"' }]);
    expect(failures[0]!.rule.includes('\n')).toBe(false);
  });

  it('R3: this server is in no docker group and can connect to no container daemon', () => {
    expect(check({ gids: [SERVER_UID, 999] })).toEqual([host('R3', 'cannot be met while this server is in the docker group (gid 999)')]);
    // Any gid /etc/group names docker, wherever it sits.
    expect(check({ gids: [SERVER_UID, 4321], text: { '/etc/group': groupFile('root:x:0:', 'docker:x:4321:') } }))
      .toEqual([host('R3', 'cannot be met while this server is in the docker group (gid 4321)')]);
    expect(CONTAINER_SOCKETS.length).toBe(10);
    for (const socket of CONTAINER_SOCKETS) {
      expect(check({ writable: [socket] })).toEqual([host('R3', `cannot be met while this server can connect to ${JSON.stringify(socket)}`)]);
    }
    expect(check({ gids: null })).toEqual([host('R3', "cannot be checked: this process's groups are unknown")]);
    const unreadable = [
      host('R3', 'cannot be checked: /etc/group is unreadable or malformed'),
      host('R4', 'cannot be checked: /etc/passwd or /etc/group is unreadable or malformed'),
    ];
    // Unreadable, and each malformed shape: a NIS line would pull in groups nobody checked.
    for (const text of [null, '+:::', '+@admins:::', '-docker:::', 'docker:x:999', 'docker:x:999::', 'docker:x:abc:', 'docker:x:0999:',
      'docker:x:-1:', 'docker:x:999:agent1,', 'docker:x:999:+agent1', 'docker group:x:999:']) {
      expect([text, check({ text: { '/etc/group': text === null ? null : groupFile('root:x:0:', text) } })]).toEqual([text, unreadable]);
    }
    // Comments and blank lines are skipped, as glibc skips them.
    expect(check({ text: { '/etc/group': '# a comment\n\n  # indented\nroot:x:0:\n\n' } })).toEqual([]);
  });

  it('R4: agents are in no forbidden group and no group of this server, by private gid, passwd primary gid or membership', () => {
    expect(FORBIDDEN_AGENT_GROUPS).toEqual(['adm', 'disk', 'docker', 'kmem', 'libvirt', 'lxd', 'root', 'shadow', 'sudo', 'systemd-journal',
      'tm8', 'tm8-relay', 'tm8-vault', 'wheel']);
    for (const name of FORBIDDEN_AGENT_GROUPS) {
      // Membership: agent1 holds an agent uid.
      expect(check({ text: { '/etc/group': groupFile(`${name}:x:3000:admin,agent1`) } }))
        .toEqual([host('R4', `would put agents in the ${name} group (gid 3000)`)]);
    }
    // The primary gid passwd gives an agent user.
    expect(check({ text: { '/etc/passwd': groupFile('agent1:x:100001:27::/home/agent1:/bin/sh') } }))
      .toEqual([host('R4', 'would put agents in the sudo group (gid 27)')]);
    // A private group: a forbidden group whose gid is an agent uid.
    expect(check({ text: { '/etc/group': groupFile('root:x:0:', 'wheel:x:100005:') } }))
      .toEqual([host('R4', 'would put agents in the wheel group (gid 100005)')]);
    // A member who is not an agent, and a group that is not forbidden, pass (both are in the hardened files).
    expect(check()).toEqual([]);
    // A group this server is in, that an agent holds.
    expect(check({ gids: [SERVER_UID, 20000] })).toEqual([host('R4', 'would put agents in a group this server is in (gid 20000)')]);
    expect(check({ gids: [SERVER_UID, 100003] })).toEqual([host('R4', 'would put agents in a group this server is in (gid 100003)')]);
    // Reported once, under the first reason.
    expect(check({ gids: [SERVER_UID, 27], text: { '/etc/group': groupFile('sudo:x:27:agent1', 'wheel:x:27:agent2') } }))
      .toEqual([host('R4', 'would put agents in the sudo group (gid 27)')]);
    const unreadable = [host('R4', 'cannot be checked: /etc/passwd or /etc/group is unreadable or malformed')];
    for (const text of [null, 'agent1:x:100001:100001::/home/agent1', '+::::::', '+agent1::::::', 'agent1:x:abc:100001::/home/agent1:/bin/sh',
      'agent1:x:100001:01::/home/agent1:/bin/sh', 'agent 1:x:100001:100001::/home/agent1:/bin/sh']) {
      expect([text, check({ text: { '/etc/passwd': text === null ? null : groupFile('root:x:0:0:root:/root:/bin/bash', text) } })]).toEqual([text, unreadable]);
    }
  });

  it('R5: Yama is on, and agents cannot list or read this process in /proc', () => {
    for (const scope of ['1\n', '2\n', '3\n']) expect(check({ text: { '/proc/sys/kernel/yama/ptrace_scope': scope } })).toEqual([]);
    expect(check({ text: { '/proc/sys/kernel/yama/ptrace_scope': '0\n' } }))
      .toEqual([host('R5', 'cannot be met while Yama ptrace_scope is 0: it must be 1 or more')]);
    for (const scope of [null, '', 'one\n', '10\n', '-1\n']) {
      expect([scope, check({ text: { '/proc/sys/kernel/yama/ptrace_scope': scope } })]).toEqual([scope, [host('R5', 'cannot be checked: Yama ptrace_scope is unreadable')]]);
    }

    const mounts = (...lines: string[]) => ({ text: { '/proc/self/mountinfo': [...lines, SYS_LINE, ''].join('\n') } });
    for (const options of ['rw,hidepid=2', 'rw,hidepid=invisible', 'rw,hidepid=4', 'rw,hidepid=ptraceable', 'rw,hidepid=invisible,gid=990']) {
      expect([options, check(mounts(procLine('/proc', options)))]).toEqual([options, []]);
    }
    for (const options of ['rw', 'rw,hidepid=0', 'rw,hidepid=off', 'rw,hidepid=1', 'rw,hidepid=noaccess', 'rw,subset=pid']) {
      expect([options, check(mounts(procLine('/proc', options)))])
        .toEqual([options, [host('R5', 'cannot be met while proc at "/proc" is mounted without hidepid=invisible')]]);
    }
    // Every proc mount counts, not only /proc.
    expect(check(mounts(procLine('/proc', 'rw,hidepid=invisible'), procLine('/var/lib/sandbox/proc', 'rw'))))
      .toEqual([host('R5', 'cannot be met while proc at "/var/lib/sandbox/proc" is mounted without hidepid=invisible')]);
    // hidepid's gid= exempts a group from it: never one an agent holds.
    for (const gid of [20000, 100001]) {
      expect(check(mounts(procLine('/proc', `rw,hidepid=invisible,gid=${gid}`))))
        .toEqual([host('R5', `cannot be met while proc at "/proc" lets gid ${gid}, an agent group, see every process`)]);
    }
    const unreadable = [host('R5', 'cannot be checked: /proc/self/mountinfo is unreadable or malformed')];
    expect(check({ text: { '/proc/self/mountinfo': null } })).toEqual(unreadable);
    expect(check({ text: { '/proc/self/mountinfo': '22 1 0:21 / /proc rw proc proc rw\n' } })).toEqual(unreadable);
    expect(check({ text: { '/proc/self/mountinfo': '22 1 0:21 / - proc proc rw\n' } })).toEqual(unreadable);
    expect(check(mounts(procLine('/proc', 'rw,hidepid=invisible,gid=agents')))).toEqual(unreadable);
    expect(check(mounts())).toEqual([host('R5', 'cannot be checked: no proc mount is visible')]);

    // gVisor: the sandbox has its own /proc, so the mounts are not read; Yama still is.
    const gvisor = parseAgentRunAs('gvisor:200000-265535')!;
    expect(check({ text: { '/proc/self/mountinfo': null } }, gvisor)).toEqual([]);
    expect(check(mounts(procLine('/proc', 'rw')), gvisor)).toEqual([]);
    expect(check({ text: { '/proc/sys/kernel/yama/ptrace_scope': '0\n' } }, gvisor))
      .toEqual([host('R5', 'cannot be met while Yama ptrace_scope is 0: it must be 1 or more')]);
  });

  it('R6: this process may not dump core, and no core_pattern pipe ignores that limit', () => {
    const limit = (soft: string, hard: string) => check({ text: { '/proc/self/limits': limitsText(soft, hard) } });
    expect(limit('unlimited', 'unlimited')).toEqual([host('R6', 'cannot be met while this process may dump core (soft unlimited, hard unlimited): set LimitCORE=0')]);
    // A soft limit of 0 under a higher hard limit can be raised by the process itself.
    expect(limit('0', 'unlimited')).toEqual([host('R6', 'cannot be met while this process may dump core (soft 0, hard unlimited): set LimitCORE=0')]);
    expect(limit('4096', '4096')).toEqual([host('R6', 'cannot be met while this process may dump core (soft 4096, hard 4096): set LimitCORE=0')]);
    expect(limit('0x10', '0')).toEqual([host('R6', 'cannot be met while this process may dump core (soft unrecognised, hard 0): set LimitCORE=0')]);
    for (const text of [null, '', 'Max cpu time              unlimited            unlimited            seconds   \n']) {
      expect([text, check({ text: { '/proc/self/limits': text } })]).toEqual([text, [host('R6', 'cannot be checked: /proc/self/limits is unreadable')]]);
    }
    for (const pattern of ['core\n', '/var/crash/core.%e.%p\n', 'core.%p']) expect(check({ text: { '/proc/sys/kernel/core_pattern': pattern } })).toEqual([]);
    expect(check({ text: { '/proc/sys/kernel/core_pattern': '|/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -- %E\n' } }))
      .toEqual([host('R6', 'cannot be met while kernel.core_pattern pipes cores to a program, which ignores LimitCORE')]);
    expect(check({ text: { '/proc/sys/kernel/core_pattern': null } })).toEqual([host('R6', 'cannot be checked: kernel.core_pattern is unreadable')]);
  });

  it('collects every failure in check order, and VaultBoundaryError lists them all under the first one\'s knob', () => {
    // This build host's shape: the server in docker and able to reach its socket, an unhidden /proc, cores piped to apport.
    const failures = check({
      gids: [SERVER_UID, 988],
      text: {
        '/etc/group': groupFile('root:x:0:', 'docker:x:988:tm8', `tm8-relay:x:${SERVER_UID}:`),
        '/proc/self/mountinfo': [procLine('/proc', 'rw'), ''].join('\n'),
        '/proc/self/limits': limitsText('0', 'unlimited'),
        '/proc/sys/kernel/core_pattern': '|/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -- %E\n',
      },
      writable: ['/run/docker.sock', '/var/run/docker.sock'],
    });
    expect(failures).toEqual([
      host('R3', 'cannot be met while this server is in the docker group (gid 988)'),
      host('R3', 'cannot be met while this server can connect to "/run/docker.sock"'),
      host('R3', 'cannot be met while this server can connect to "/var/run/docker.sock"'),
      host('R5', 'cannot be met while proc at "/proc" is mounted without hidepid=invisible'),
      host('R6', 'cannot be met while this process may dump core (soft 0, hard unlimited): set LimitCORE=0'),
      host('R6', 'cannot be met while kernel.core_pattern pipes cores to a program, which ignores LimitCORE'),
    ]);
    expect(failures.every((failure) => Object.isFrozen(failure))).toBe(true);

    const mixed = [{ check: 'R1', knob: RELAY_TLS_CERT_KNOB, rule: 'names a file owned by uid 100001, an agent uid' } as const, ...failures];
    const error = new VaultBoundaryError(mixed);
    expect(error).toBeInstanceOf(VaultRelayConfigError);
    expect([error.name, error.knob]).toEqual(['VaultBoundaryError', RELAY_TLS_CERT_KNOB]);
    expect(error.message).toBe(`vault relay: refused (review F03 agent boundary): ${mixed.map((failure) => `${failure.check} ${failure.knob} ${failure.rule}`).join('; ')}`);
    expect(error.failures).toEqual(mixed);
    expect(error.failures).not.toBe(mixed);
    expect(Object.isFrozen(error.failures)).toBe(true);
    expect(() => new VaultBoundaryError([])).toThrow(TypeError);
  });
});

describe('checkRelayTlsMaterial, R8, on throwaway certificates', () => {
  let dir: string;
  const pem: Record<string, Buffer> = {};
  let from = 0;
  let to = 0;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-vault-r8-'));
    const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
    // Throwaway test fixtures, generated here: two CAs, a leaf client certificate from the first, and an unrelated key.
    openssl('req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=vault-test-ca', '-days', '1');
    openssl('req', '-x509', ...ec, '-keyout', 'ca2.key', '-out', 'ca2.crt', '-subj', '/CN=vault-test-ca-2', '-days', '1');
    openssl('req', ...ec, '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=vault-test-relay');
    await writeFile(join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n');
    openssl('x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.crt', '-days', '1', '-extfile', 'client.ext');
    openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'other.key');
    const phrase = ['throwaway', 'test', 'only'].join('-');
    openssl('pkcs8', '-topk8', '-in', 'client.key', '-out', 'client-encrypted.key', '-v2', 'aes-256-cbc', '-passout', `pass:${phrase}`);
    for (const name of ['ca.key', 'ca.crt', 'ca2.crt', 'client.key', 'client.crt', 'other.key', 'client-encrypted.key']) pem[name] = await readFile(join(dir, name));
    const leaf = new X509Certificate(pem['client.crt']!);
    [from, to] = [Date.parse(leaf.validFrom), Date.parse(leaf.validTo)];
  }, 30_000);
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  const material = (patch: Partial<Record<'key' | 'cert' | 'ca', Buffer>> = {}) => ({ key: pem['client.key']!, cert: pem['client.crt']!, ca: pem['ca.crt']!, ...patch });
  const middle = () => from + Math.floor((to - from) / 2);
  const r8 = (knob: string, rule: string): BoundaryFailure => ({ check: 'R8', knob, rule });

  it('accepts a leaf client certificate that matches its key, inside its validity, with one CA certificate', () => {
    expect(Number.isFinite(from) && Number.isFinite(to) && from < to).toBe(true);
    for (const now of [from, middle(), to]) expect(checkRelayTlsMaterial(material(), now)).toEqual([]);
    // Text outside a PEM block is ignored, as OpenSSL ignores it.
    expect(checkRelayTlsMaterial(material({ ca: Buffer.concat([Buffer.from('subject=CN = vault-test-ca\n'), pem['ca.crt']!]) }), middle())).toEqual([]);
  });

  it('refuses a key that is not an unencrypted PEM private key, and then claims no mismatch', () => {
    const publicPem = Buffer.from(createPublicKey(pem['client.key']!).export({ type: 'spki', format: 'pem' }).toString());
    for (const key of [Buffer.from('relay tls key'), Buffer.alloc(0), pem['client-encrypted.key']!, publicPem, pem['client.crt']!]) {
      expect(checkRelayTlsMaterial(material({ key }), middle())).toEqual([r8(RELAY_TLS_KEY_KNOB, 'is not an unencrypted PEM private key')]);
    }
  });

  it('refuses a certificate that is not one, does not match the key, or is a CA', () => {
    expect(checkRelayTlsMaterial(material({ cert: Buffer.from('relay certificate') }), middle())).toEqual([r8(RELAY_TLS_CERT_KNOB, 'is not a certificate')]);
    expect(checkRelayTlsMaterial(material({ key: pem['other.key']! }), middle())).toEqual([r8(RELAY_TLS_CERT_KNOB, 'does not match TM8_VAULT_RELAY_TLS_KEY_FILE')]);
    const ca = 'is a CA certificate: the relay needs a leaf client certificate';
    expect(checkRelayTlsMaterial(material({ key: pem['ca.key']!, cert: pem['ca.crt']! }), middle())).toEqual([r8(RELAY_TLS_CERT_KNOB, ca)]);
    expect(checkRelayTlsMaterial(material({ cert: pem['ca.crt']! }), middle()))
      .toEqual([r8(RELAY_TLS_CERT_KNOB, 'does not match TM8_VAULT_RELAY_TLS_KEY_FILE'), r8(RELAY_TLS_CERT_KNOB, ca)]);
  });

  it('refuses a certificate outside its validity period, by the clock it is given', () => {
    expect(checkRelayTlsMaterial(material(), from - 1)).toEqual([r8(RELAY_TLS_CERT_KNOB, 'is not valid yet')]);
    expect(checkRelayTlsMaterial(material(), to + 1)).toEqual([r8(RELAY_TLS_CERT_KNOB, 'has expired')]);
    expect(checkRelayTlsMaterial(material(), to + 400 * 86_400_000)).toEqual([r8(RELAY_TLS_CERT_KNOB, 'has expired')]);
  });

  it('the CA file holds exactly one PEM block, and it is a CA certificate', () => {
    const blocks = (certificates: number, others: number) => r8(RELAY_TLS_CA_KNOB,
      `must hold exactly one PEM block, a certificate (it holds ${certificates} certificate${certificates === 1 ? '' : 's'} and ${others} other PEM block${others === 1 ? '' : 's'})`);
    const ca = (bytes: Buffer | string) => checkRelayTlsMaterial(material({ ca: typeof bytes === 'string' ? Buffer.from(bytes) : bytes }), middle());
    // TLS would trust every certificate in the file.
    expect(ca(Buffer.concat([pem['ca.crt']!, pem['ca2.crt']!]))).toEqual([blocks(2, 0)]);
    expect(ca(Buffer.concat([pem['ca.crt']!, pem['ca.key']!]))).toEqual([blocks(1, 1)]);
    expect(ca(pem['ca.key']!)).toEqual([blocks(0, 1)]);
    expect(ca('broker ca')).toEqual([blocks(0, 0)]);
    expect(ca('')).toEqual([blocks(0, 0)]);
    const trusted = pem['ca.crt']!.toString('latin1').replaceAll('BEGIN CERTIFICATE', 'BEGIN TRUSTED CERTIFICATE').replaceAll('END CERTIFICATE', 'END TRUSTED CERTIFICATE');
    expect(ca(trusted)).toEqual([blocks(0, 1)]);
    expect(ca(pem['client.crt']!)).toEqual([r8(RELAY_TLS_CA_KNOB, 'holds a certificate that is not a CA')]);
    const notDer = Buffer.from('not a certificate').toString('base64');
    expect(ca(`-----BEGIN CERTIFICATE-----\n${notDer}\n-----END CERTIFICATE-----\n`)).toEqual([r8(RELAY_TLS_CA_KNOB, 'is not a certificate')]);
  });

  it('collects failures across the three files, and no rule carries PEM content', () => {
    const failures = checkRelayTlsMaterial({ key: Buffer.from('relay tls key'), cert: pem['ca.crt']!, ca: Buffer.concat([pem['ca.crt']!, pem['ca2.crt']!]) }, to + 1);
    expect(failures.map((failure) => [failure.knob, failure.rule])).toEqual([
      [RELAY_TLS_KEY_KNOB, 'is not an unencrypted PEM private key'],
      [RELAY_TLS_CERT_KNOB, 'is a CA certificate: the relay needs a leaf client certificate'],
      [RELAY_TLS_CERT_KNOB, 'has expired'],
      [RELAY_TLS_CA_KNOB, 'must hold exactly one PEM block, a certificate (it holds 2 certificates and 0 other PEM blocks)'],
    ]);
    const body = (name: string) => pem[name]!.toString('latin1').split('\n')[1]!;
    for (const failure of failures) {
      expect(failure.rule.includes('-----')).toBe(false);
      for (const name of ['ca.crt', 'ca2.crt', 'client.key']) expect(failure.rule.includes(body(name))).toBe(false);
    }
  });
});
