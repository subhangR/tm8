/**
 * Host metrics for `node.metrics.get` — the desktop status strip's read.
 *
 * Every figure is MEASURED at request time. A figure this host cannot supply
 * is `null`, never a zero and never an estimate: the strip renders a dash for
 * `null`, and a dash that turns out to be a guess is worse than no strip.
 *
 * Two platform facts decide the shape of this file:
 *
 *   * CPU busy share is a DELTA between two `os.cpus()` samples, so the sampler
 *     keeps the previous sample and answers "busy since the last read". With
 *     no recent sample (first read, or a read after a long gap) it takes a
 *     short in-request window instead of answering over an arbitrary span.
 *   * `os.freemem()` is not "available memory" on macOS: it counts only pages
 *     that are free right now and leaves out inactive and purgeable ones, so a
 *     healthy Mac reads ~95% used. macOS is read from `vm_stat` (Activity
 *     Monitor's "Memory Used" = app + wired + compressed), Linux from
 *     `/proc/meminfo`'s `MemAvailable`. `os.freemem()` is the last resort.
 */
import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

import type { NodeMetricsView } from '@tm8/contract';

interface CpuSample {
  at: number;
  idle: number;
  total: number;
}

/** A sample older than this is too stale to difference against. */
const MAX_SAMPLE_AGE_MS = 60_000;
/** The in-request window used when there is no usable previous sample. */
const FIRST_READ_WINDOW_MS = 250;

export interface HostMetricsSamplerOptions {
  /** The data directory whose volume `disk` reports. Omitted: `disk` is null. */
  dataDir?: string;
  /** Injected for tests. */
  now?: () => number;
  cpus?: () => os.CpuInfo[];
  sleep?: (ms: number) => Promise<void>;
  readMemory?: () => Promise<{ totalBytes: number; usedBytes: number }>;
}

export function sampleCpu(cpus: os.CpuInfo[], at: number): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { at, idle, total };
}

/** Busy share 0–100 between two samples; null when no time elapsed. */
export function cpuPercent(prev: CpuSample, next: CpuSample): number | null {
  const total = next.total - prev.total;
  if (total <= 0) return null;
  const busy = total - (next.idle - prev.idle);
  return Math.round(Math.min(100, Math.max(0, (busy / total) * 100)) * 10) / 10;
}

/**
 * macOS `vm_stat` → bytes in use, the way Activity Monitor counts it:
 * app memory (anonymous minus purgeable) + wired + compressed.
 * Returns null when the output lacks the lines this needs.
 */
export function parseVmStatUsedBytes(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(output);
    return m ? Number(m[1]) : null;
  };
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable') ?? 0;
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor') ?? 0;
  if (anonymous === null || wired === null) return null;
  return Math.max(0, anonymous - purgeable + wired + compressed) * pageSize;
}

/** Linux `/proc/meminfo` → bytes in use (total − MemAvailable). */
export function parseMeminfoUsedBytes(output: string): { totalBytes: number; usedBytes: number } | null {
  const kb = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+) kB`, 'm').exec(output);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total === null || available === null) return null;
  return { totalBytes: total, usedBytes: Math.max(0, total - available) };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function readHostMemory(): Promise<{ totalBytes: number; usedBytes: number }> {
  const totalBytes = os.totalmem();
  try {
    if (process.platform === 'darwin') {
      const used = parseVmStatUsedBytes(await run('vm_stat', []));
      if (used !== null) return { totalBytes, usedBytes: Math.min(used, totalBytes) };
    } else if (process.platform === 'linux') {
      const parsed = parseMeminfoUsedBytes(await readFile('/proc/meminfo', 'utf8'));
      if (parsed) return parsed;
    }
  } catch {
    // Fall through to the portable figure.
  }
  return { totalBytes, usedBytes: Math.max(0, totalBytes - os.freemem()) };
}

async function readDisk(path: string): Promise<NodeMetricsView['disk']> {
  try {
    const s = await statfs(path);
    const totalBytes = s.blocks * s.bsize;
    if (!(totalBytes > 0)) return null;
    // "Used" is everything this user cannot write: total minus what is
    // available to them, which is what a "percent full" reader means.
    return { path, totalBytes, usedBytes: Math.max(0, totalBytes - s.bavail * s.bsize) };
  } catch {
    return null;
  }
}

export class HostMetricsSampler {
  private prev: CpuSample | null = null;
  private readonly now: () => number;
  private readonly cpus: () => os.CpuInfo[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readMemory: () => Promise<{ totalBytes: number; usedBytes: number }>;

  constructor(private readonly options: HostMetricsSamplerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cpus = options.cpus ?? os.cpus;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.readMemory = options.readMemory ?? readHostMemory;
  }

  private async cpu(): Promise<{ percent: number | null; cores: number }> {
    let prev = this.prev;
    if (!prev || this.now() - prev.at > MAX_SAMPLE_AGE_MS) {
      prev = sampleCpu(this.cpus(), this.now());
      await this.sleep(FIRST_READ_WINDOW_MS);
    }
    const cpus = this.cpus();
    const next = sampleCpu(cpus, this.now());
    this.prev = next;
    return { percent: cpuPercent(prev, next), cores: cpus.length };
  }

  async read(): Promise<NodeMetricsView> {
    const [cpu, memory, disk] = await Promise.all([
      this.cpu(),
      this.readMemory(),
      this.options.dataDir ? readDisk(this.options.dataDir) : Promise.resolve(null),
    ]);
    const mem = process.memoryUsage();
    const load = os.loadavg();
    return {
      sampledAt: new Date(this.now()).toISOString(),
      cpu,
      memory,
      // Windows answers [0, 0, 0] for a figure it does not have.
      loadAverage: process.platform === 'win32' ? null : [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      disk,
      process: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        uptimeSeconds: Math.round(process.uptime()),
      },
      hostUptimeSeconds: Math.round(os.uptime()),
    };
  }
}
