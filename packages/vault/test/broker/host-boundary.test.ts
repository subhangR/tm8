/**
 * Review F03, check B3 (design doc 01a1fe13, section 4): the broker is outside the docker group and
 * can connect to no container daemon's socket. Every host below is synthetic (test/support/
 * host-memory.ts), apart from the last test, which only checks that the real reads work here.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostBoundaryError, checkHostBoundary } from '../../src/broker/host-boundary.js';
import { realHostProc, type HostProc } from '../../src/broker/host-memory.js';
import { CONTAINER_SOCKETS } from '../../src/relay/host-identity.js';
import { DOCKER_SOCKETS, exposedHost, syntheticHost } from '../support/host-memory.js';

const PASS = { facts: { dockerGroup: false, containerSockets: [] }, failures: [] };

describe('broker host boundary (review F03, B3)', () => {
  it('a hardened host passes: outside the docker group, no container socket it may open', () => {
    const host = syntheticHost();
    expect(checkHostBoundary(host.proc)).toEqual(PASS);
    // Read-only: B3 writes nothing (the only write at start is the F05 core filter).
    expect(host.writes).toEqual([]);
  });

  it('reads /etc/group alone and asks about every listed socket, in order', () => {
    const base = syntheticHost().proc;
    const read: string[] = [];
    const asked: string[] = [];
    const proc: HostProc = {
      ...base,
      read: (path) => { read.push(path); return base.read(path); },
      canWrite: (path) => { asked.push(path); return false; },
    };
    expect(checkHostBoundary(proc)).toEqual(PASS);
    expect(read).toEqual(['/etc/group']);
    expect(asked).toEqual([...CONTAINER_SOCKETS]);
    expect(CONTAINER_SOCKETS).toHaveLength(10);
    expect(Object.isFrozen(CONTAINER_SOCKETS)).toBe(true);
  });

  it('the docker group fails, by the gid /etc/group gives it, wherever it sits among the groups', () => {
    for (const groups of [[999], [996, 999], [999, 996], [996, 1000, 999]]) {
      expect(checkHostBoundary(syntheticHost({}, { groups }).proc))
        .toEqual({ facts: { dockerGroup: true, containerSockets: [] }, failures: ['docker_group'] });
    }
    // Docker's gid is what this host's /etc/group says, not 999.
    const moved = { '/etc/group': 'root:x:0:\ndocker:x:988:\nother:x:999:\n' };
    expect(checkHostBoundary(syntheticHost(moved, { groups: [988] }).proc).failures).toEqual(['docker_group']);
    expect(checkHostBoundary(syntheticHost(moved, { groups: [999] }).proc)).toEqual(PASS);
    // Comments and blank lines are skipped; a docker line after them still counts.
    const commented = { '/etc/group': '# local\n\nroot:x:0:\n  # indented comment\ndocker:x:999:\n' };
    expect(checkHostBoundary(syntheticHost(commented, { groups: [999] }).proc).failures).toEqual(['docker_group']);
  });

  it('each container socket the broker may connect to fails, named by path', () => {
    for (const socket of CONTAINER_SOCKETS) {
      expect(checkHostBoundary(syntheticHost({}, { sockets: [socket] }).proc))
        .toEqual({ facts: { dockerGroup: false, containerSockets: [socket] }, failures: ['container_socket'] });
    }
    expect(checkHostBoundary(syntheticHost({}, { sockets: [...CONTAINER_SOCKETS].reverse() }).proc).facts.containerSockets)
      .toEqual([...CONTAINER_SOCKETS]);
  });

  it('an unreadable or malformed /etc/group, or groups it cannot learn, fail closed', () => {
    // Unreadable, a NIS compat line (which pulls in entries no one checked), a short or long line,
    // an id that is not plain decimal or is out of range, a bad member, and a line with leading space.
    for (const text of [null, '+:::\n', '+@admins:::\n', '-docker:::\n', 'docker:x:999\n', 'docker:x:999::\n', 'docker:x:abc:\n',
      'docker:x:0999:\n', 'docker:x:-1:\n', 'docker:x:4294967295:\n', 'docker:x:999:+admins\n', ' docker:x:999:\n']) {
      expect([text, checkHostBoundary(syntheticHost({ '/etc/group': text }).proc)])
        .toEqual([text, { facts: { dockerGroup: null, containerSockets: [] }, failures: ['group_file'] }]);
    }
    expect(checkHostBoundary(syntheticHost({}, { groups: null }).proc))
      .toEqual({ facts: { dockerGroup: null, containerSockets: [] }, failures: ['groups'] });
  });

  it('reports every failure at once, in a fixed order, and the refusal names them in fixed words', () => {
    expect(checkHostBoundary(syntheticHost({ '/etc/group': null }, { groups: null, sockets: DOCKER_SOCKETS }).proc))
      .toEqual({ facts: { dockerGroup: null, containerSockets: [...DOCKER_SOCKETS] }, failures: ['group_file', 'groups', 'container_socket'] });
    expect(checkHostBoundary(exposedHost().proc))
      .toEqual({ facts: { dockerGroup: true, containerSockets: [...DOCKER_SOCKETS] }, failures: ['docker_group', 'container_socket'] });
    const error = new HostBoundaryError(['docker_group', 'container_socket']);
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.message, error.failures]).toEqual(['HostBoundaryError',
      'vault broker: refused (host boundary: docker_group, container_socket)', ['docker_group', 'container_socket']]);
  });

  it('on this machine, the real reads work: the groups include the effective gid, and canWrite is access(W_OK)', async () => {
    const groups = realHostProc.groups();
    expect(groups).not.toBeNull();
    expect(new Set(groups).size).toBe(groups!.length);
    if (typeof process.getegid === 'function') expect(groups).toContain(process.getegid());
    const dir = await mkdtemp(join(tmpdir(), 'tm8-vault-b3-'));
    try {
      const own = join(dir, 'own');
      await writeFile(own, '', { mode: 0o600 });
      expect(realHostProc.canWrite(own)).toBe(true);
      expect(realHostProc.canWrite(join(dir, 'absent'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // The verdict on this host is this host's: only its shape is checked here.
    const check = checkHostBoundary();
    expect(check.facts.dockerGroup === null || typeof check.facts.dockerGroup === 'boolean').toBe(true);
    expect(check.facts.containerSockets.every((socket) => CONTAINER_SOCKETS.includes(socket))).toBe(true);
  });
});
