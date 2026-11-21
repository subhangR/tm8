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

/**
 * A broker host as /proc and /sys show it, hardened by default: core limit 0/0, a file core
 * pattern, no swap, and the unit's cgroup at `memory.swap.max` 0. `files` overrides an entry;
 * null removes it (an unreadable file). The filter starts at the kernel default, 0x33.
 */
export function syntheticHost(files: Record<string, string | null> = {}, options: { filterWritable?: boolean } = {}) {
  const state: Record<string, string | null> = {
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
  };
  return { proc, writes };
}

/** This build host's shape: cores piped to apport, a hard core limit of unlimited, swap with no limit. */
export function exposedHost() {
  return syntheticHost({
    '/proc/self/limits': limits('0', 'unlimited'), '/proc/sys/kernel/core_pattern': APPORT_PATTERN,
    '/proc/swaps': `${SWAPS_HEADER}/swap.img                               file\t\t4194300\t\t0\t\t-2\n`, [LEAF]: 'max\n',
  });
}

export const hardenedHost = (): HostProc => syntheticHost().proc;
