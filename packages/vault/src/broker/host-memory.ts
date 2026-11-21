import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Keeps the broker's memory out of core dumps, and checks that the host will not write it to
 * disk (review F05: "verify no core dumps and no swap on the real broker host").
 *
 * Core dumps. `LimitCORE=0` (RLIMIT_CORE) stops a core FILE. The kernel ignores that limit when
 * `kernel.core_pattern` pipes cores to a program (core(5)), and Ubuntu's apport and
 * systemd-coredump both pipe. So the broker sets its own `/proc/self/coredump_filter` to 0 first,
 * in every mode. The kernel applies that filter to every core it writes, to a file or a pipe. With
 * it at 0, no anonymous or file-backed mapping is written, so the V8 heap, the native heap and the
 * stacks stay out. A core still carries the ELF headers, the vDSO and the notes. The notes hold
 * every thread's registers, including SSE/AVX state, plus the start of the command line and the
 * list of mapped files. So production also requires the limit at 0 (soft and hard) and a core
 * pattern that is a file, not a pipe. Then the kernel writes no core at all.
 *
 * Swap. `MemorySwapMax=0` sets the unit's cgroup v2 `memory.swap.max` to 0. The broker reads the
 * effective limit, which is the lowest one on its cgroup path. Without a limit of 0, a later
 * `swapon` could page it out, so that fails even when no swap is active now.
 *
 * Production refuses to start when any of these fails. The other modes log the same facts and run.
 * Not covered here: hibernation images, kdump captures, and hypervisor snapshots or migrations of
 * the VM's memory. The deploy README lists the host checks for those.
 */

/** What the check reads and writes; tests pass a synthetic one. Errors read as null or false. */
export interface HostProc {
  read(path: string): string | null;
  write(path: string, value: string): boolean;
}

export const realHostProc: HostProc = {
  read(path) {
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  },
  write(path, value) {
    try { writeFileSync(path, value); return true; } catch { return false; }
  },
};

export type HostMemoryFailure = 'core_filter' | 'core_limit' | 'core_pattern' | 'swap_limit';

export interface HostMemoryFacts {
  /** The filter read back after writing 0. null: unreadable. */
  coreFilter: number | null;
  /** RLIMIT_CORE as /proc/self/limits prints it: a byte count or `unlimited`. null: unreadable. */
  coreLimit: { soft: string; hard: string } | null;
  /** Whether the kernel writes a core to a file or pipes it to a program. null: unreadable. */
  corePattern: 'file' | 'pipe' | null;
  /** Active swap areas, from /proc/swaps. Reported only: a swap limit of 0 is what counts. */
  swapAreas: number | null;
  /** The effective cgroup v2 `memory.swap.max` (a byte count or `max`). null: no limit could be read. */
  swapMax: string | null;
}

export interface HostMemoryCheck { facts: HostMemoryFacts; failures: HostMemoryFailure[] }

export class HostMemoryError extends Error {
  constructor(readonly failures: readonly HostMemoryFailure[]) {
    super(`vault broker: refused (host memory: ${failures.join(', ')})`);
    this.name = 'HostMemoryError';
  }
}

function coreFilter(proc: HostProc): number | null {
  proc.write('/proc/self/coredump_filter', '0');
  const value = proc.read('/proc/self/coredump_filter')?.trim();
  return value !== undefined && /^[0-9a-f]{1,8}$/i.test(value) ? Number.parseInt(value, 16) : null;
}

function coreLimit(proc: HostProc): HostMemoryFacts['coreLimit'] {
  const match = /^Max core file size[ \t]+(\S+)[ \t]+(\S+)/m.exec(proc.read('/proc/self/limits') ?? '');
  return match ? { soft: match[1]!, hard: match[2]! } : null;
}

function corePattern(proc: HostProc): HostMemoryFacts['corePattern'] {
  const value = proc.read('/proc/sys/kernel/core_pattern');
  if (value === null) return null;
  return value.startsWith('|') ? 'pipe' : 'file';
}

function swapAreas(proc: HostProc): number | null {
  const lines = proc.read('/proc/swaps')?.split('\n').filter((line) => line.trim() !== '');
  return lines === undefined || lines.length === 0 ? null : lines.length - 1;
}

/** The lowest `memory.swap.max` from this process's cgroup v2 up to the root, which has none. */
function swapMax(proc: HostProc): string | null {
  const line = proc.read('/proc/self/cgroup')?.split('\n').find((entry) => entry.startsWith('0::'));
  const cgroup = line?.slice(3);
  if (!cgroup?.startsWith('/') || cgroup.split('/').some((segment) => segment === '..')) return null;
  let lowest: bigint | null = null;
  let unlimited = false;
  for (let path = cgroup; ; path = path.slice(0, path.lastIndexOf('/')) || '/') {
    const value = proc.read(`/sys/fs/cgroup${path === '/' ? '' : path}/memory.swap.max`)?.trim();
    if (value === 'max') unlimited = true;
    else if (value !== undefined && /^\d+$/.test(value) && (lowest === null || BigInt(value) < lowest)) lowest = BigInt(value);
    if (path === '/') break;
  }
  return lowest !== null ? lowest.toString() : unlimited ? 'max' : null;
}

/** Sets the core dump filter, then reads what the host will do with this process's memory. */
export function protectHostMemory(proc: HostProc = realHostProc): HostMemoryCheck {
  const facts: HostMemoryFacts = {
    coreFilter: coreFilter(proc), coreLimit: coreLimit(proc), corePattern: corePattern(proc),
    swapAreas: swapAreas(proc), swapMax: swapMax(proc),
  };
  const failures: HostMemoryFailure[] = [];
  if (facts.coreFilter !== 0) failures.push('core_filter');
  if (facts.coreLimit?.soft !== '0' || facts.coreLimit.hard !== '0') failures.push('core_limit');
  if (facts.corePattern !== 'file') failures.push('core_pattern');
  if (facts.swapMax !== '0') failures.push('swap_limit');
  return { facts, failures };
}
