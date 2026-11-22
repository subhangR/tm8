import type { HostProc } from '../../src/broker/host-memory.js';

/** /proc/self/limits with a given RLIMIT_CORE, in the kernel's own column layout. */
export function limits(soft: string, hard: string): string {
  return [
    'Limit                     Soft Limit           Hard Limit           Units     ',
    'Max cpu time              unlimited            unlimited            seconds   ',
    `Max core file size        ${soft.padEnd(21)}${hard.padEnd(21)}bytes     `,
    'Max resident set          unlimited            unlimited            bytes     ',
  ].join('\n') + '\n';
}

export const SWAPS_HEADER = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n';
export const LEAF = '/sys/fs/cgroup/system.slice/tm8-vault-broker.service/memory.swap.max';
export const SLICE = '/sys/fs/cgroup/system.slice/memory.swap.max';
export const APPORT_PATTERN = '|/usr/share/apport/apport -p%p -s%s -c%c\n';
/** A local /etc/group with a docker group (gid 999) and the vault's own group (996). */
export const HOST_GROUPS = 'root:x:0:\ndocker:x:999:\ntm8-vault:x:996:tm8-vault-broker\n';
/** The broker's groups on a hardened host: its own, never docker's. */
export const BROKER_GROUPS: readonly number[] = [996];
export const DOCKER_SOCKETS: readonly string[] = ['/run/docker.sock', '/var/run/docker.sock'];

/**
 * A broker host as /proc and /sys show it, hardened by default: core limit 0/0, a file core
 * pattern, no swap, and the unit's cgroup at `memory.swap.max` 0; and for the host boundary (B3),
 * a broker outside the docker group that can open no container socket. `files` overrides an entry;
 * null removes it (an unreadable file). The filter starts at the kernel default, 0x33. `groups`
 * and `sockets` override the broker's groups (null: unknown) and the sockets it may connect to.
 */
export function syntheticHost(files: Record<string, string | null> = {}, options: {
  filterWritable?: boolean; groups?: readonly number[] | null; sockets?: readonly string[];
} = {}) {
  const state: Record<string, string | null> = {
    '/etc/group': HOST_GROUPS,
    '/proc/self/coredump_filter': '00000033\n',
    '/proc/self/limits': limits('0', '0'),
    '/proc/sys/kernel/core_pattern': 'core\n',
    '/proc/swaps': SWAPS_HEADER,
    '/proc/self/cgroup': '0::/system.slice/tm8-vault-broker.service\n',
    [LEAF]: '0\n',
    [SLICE]: 'max\n',
    ...files,
  };
  const writes: [string, string][] = [];
  const proc: HostProc = {
    read: (path) => state[path] ?? null,
    write: (path, value) => {
      writes.push([path, value]);
      if (options.filterWritable === false || state[path] == null) return false;
      state[path] = `${Number.parseInt(value, 10).toString(16).padStart(8, '0')}\n`;
      return true;
    },
    groups: () => (options.groups === undefined ? BROKER_GROUPS : options.groups),
    canWrite: (path) => (options.sockets ?? []).includes(path),
  };
  return { proc, writes };
}

/**
 * This build host's shape: cores piped to apport, a hard core limit of unlimited, swap with no
 * limit, and a process in the docker group that can open docker's socket.
 */
export function exposedHost() {
  return syntheticHost({
    '/proc/self/limits': limits('0', 'unlimited'), '/proc/sys/kernel/core_pattern': APPORT_PATTERN,
    '/proc/swaps': `${SWAPS_HEADER}/swap.img                               file\t\t4194300\t\t0\t\t-2\n`, [LEAF]: 'max\n',
  }, { groups: [114, 999], sockets: DOCKER_SOCKETS });
}

export const hardenedHost = (): HostProc => syntheticHost().proc;
