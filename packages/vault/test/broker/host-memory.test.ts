import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HostMemoryError, protectHostMemory, realHostProc, type HostMemoryFacts } from '../../src/broker/host-memory.js';
import { APPORT_PATTERN, LEAF, SLICE, SWAPS_HEADER, exposedHost, limits, syntheticHost } from '../support/host-memory.js';

const HARDENED: HostMemoryFacts = {
  coreFilter: 0, coreLimit: { soft: '0', hard: '0' }, corePattern: 'file', swapAreas: 0, swapMax: '0',
};

describe('broker host memory (review F05)', () => {
  it('sets the core dump filter to 0 first, and a hardened host passes', () => {
    const host = syntheticHost();
    expect(protectHostMemory(host.proc)).toEqual({ facts: HARDENED, failures: [] });
    expect(host.writes).toEqual([['/proc/self/coredump_filter', '0']]);
  });

  it.each([
    ['swap is active, but the cgroup limit is 0', { '/proc/swaps': `${SWAPS_HEADER}/swap.img file 4194300 0 -2\n` }, { swapAreas: 1 }],
    ['the unit has no limit, but its slice has 0', { [LEAF]: 'max\n', [SLICE]: '0\n' }, {}],
    ['only the slice sets a limit, of 0', { [LEAF]: null, [SLICE]: '0\n' }, {}],
    // The effective limit is the lowest on the path, not the unit's own.
    ['the unit allows 1 GiB, but its slice allows none', { [LEAF]: '1073741824\n', [SLICE]: '0\n' }, {}],
    ['the broker runs in the root of a cgroup namespace (a container)', { '/proc/self/cgroup': '0::/\n',
      '/sys/fs/cgroup/memory.swap.max': '0\n' }, {}],
  ] as const)('passes when %s', (_name, files, facts) => {
    expect(protectHostMemory(syntheticHost(files).proc)).toEqual({ facts: { ...HARDENED, ...facts }, failures: [] });
  });

  it.each([
    ['the filter cannot be written', {}, { filterWritable: false }, { coreFilter: 0x33 }, ['core_filter']],
    ['the filter cannot be read', { '/proc/self/coredump_filter': null }, {}, { coreFilter: null }, ['core_filter']],
    ['the hard core limit is unlimited', { '/proc/self/limits': limits('0', 'unlimited') }, {},
      { coreLimit: { soft: '0', hard: 'unlimited' } }, ['core_limit']],
    ['the soft core limit is not 0', { '/proc/self/limits': limits('1024', '1024') }, {},
      { coreLimit: { soft: '1024', hard: '1024' } }, ['core_limit']],
    ['the limits cannot be read', { '/proc/self/limits': null }, {}, { coreLimit: null }, ['core_limit']],
    // RLIMIT_CORE does not apply to a pipe (core(5)), so a 0 limit would not stop this core.
    ['cores are piped to a program', { '/proc/sys/kernel/core_pattern': APPORT_PATTERN }, {}, { corePattern: 'pipe' }, ['core_pattern']],
    ['the core pattern is hidden, as ProcSubset=pid hides it', { '/proc/sys/kernel/core_pattern': null }, {},
      { corePattern: null }, ['core_pattern']],
    ['no swap is active, but nothing stops a later swapon', { [LEAF]: 'max\n' }, {}, { swapMax: 'max' }, ['swap_limit']],
    ['the swap limit is above 0', { [LEAF]: '1073741824\n' }, {}, { swapMax: '1073741824' }, ['swap_limit']],
    ['the host has cgroup v1 only', { '/proc/self/cgroup': '12:memory:/system.slice/tm8-vault-broker.service\n' }, {},
      { swapMax: null }, ['swap_limit']],
    ['the cgroup path is not plain', { '/proc/self/cgroup': '0::/system.slice/../x\n' }, {}, { swapMax: null }, ['swap_limit']],
    ['no swap limit can be read', { [LEAF]: null, [SLICE]: null }, {}, { swapMax: null }, ['swap_limit']],
    // An empty read is not a limit of 0.
    ['the swap limit reads empty', { [LEAF]: '\n', [SLICE]: null }, {}, { swapMax: null }, ['swap_limit']],
  ] as const)('fails when %s', (_name, files, options, facts, failures) => {
    expect(protectHostMemory(syntheticHost(files, options).proc)).toEqual({ facts: { ...HARDENED, ...facts }, failures });
  });

  it('reports every failure of a host shaped like this build host, in fixed words', () => {
    const check = protectHostMemory(exposedHost().proc);
    expect(check).toEqual({ failures: ['core_limit', 'core_pattern', 'swap_limit'],
      facts: { coreFilter: 0, coreLimit: { soft: '0', hard: 'unlimited' }, corePattern: 'pipe', swapAreas: 1, swapMax: 'max' } });
    expect(new HostMemoryError(check.failures).message).toBe('vault broker: refused (host memory: core_limit, core_pattern, swap_limit)');
  });

  it('on a real Linux kernel, the filter write takes effect and every core fact parses', () => {
    const check = protectHostMemory(realHostProc);
    // Read back directly, not through the code under test: the kernel accepted the write.
    expect(readFileSync('/proc/self/coredump_filter', 'utf8')).toBe('00000000\n');
    expect(check.facts.coreFilter).toBe(0);
    const [, soft, hard] = /^Max core file size\s+(\S+)\s+(\S+)/m.exec(readFileSync('/proc/self/limits', 'utf8'))!;
    expect(check.facts.coreLimit).toEqual({ soft, hard });
    expect(check.facts.corePattern).toBe(readFileSync('/proc/sys/kernel/core_pattern', 'utf8').startsWith('|') ? 'pipe' : 'file');
    expect(check.facts.swapAreas).toBe(readFileSync('/proc/swaps', 'utf8').trim().split('\n').length - 1);
  });
});
