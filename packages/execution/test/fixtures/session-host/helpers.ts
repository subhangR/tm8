// Shared by the session-host tests: process probes and the doc §5 v6 fd check.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, ms = 20_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await wait(25);
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Zombies count as dead: /proc/<pid>/stat state Z. */
export function running(pid: number): boolean {
  if (!alive(pid)) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return false;
  }
}

function fdLinks(pid: number): Map<number, string> {
  const links = new Map<number, string>();
  for (const name of readdirSync(`/proc/${pid}/fd`)) {
    try {
      links.set(Number(name), readlinkSync(`/proc/${pid}/fd/${name}`));
    } catch {
      /* closed while we looked */
    }
  }
  return links;
}

/**
 * STRICT form, for a PTY agent (its stdio is the PTY slave): above fd 2 it may
 * hold no PTY master and no socket at all.
 */
export function strictLeaks(pid: number): string[] {
  return [...fdLinks(pid)]
    .filter(([fd, link]) => fd > 2 && (link.includes('/dev/ptmx') || link.startsWith('socket:')))
    .map(([fd, link]) => `${fd} -> ${link}`);
}

/**
 * Doc §5 v6 form, for a pipe child whose stdio is itself AF_UNIX socketpairs:
 * drop the inodes of its own fds 0/1/2 first; above fd 2, /dev/ptmx is always
 * a leak, and so is any socket that is not one of those stdio inodes.
 */
export function pipeChildLeaks(pid: number): string[] {
  const links = fdLinks(pid);
  const stdio = new Set([0, 1, 2].map((fd) => links.get(fd)).filter((l): l is string => l !== undefined));
  return [...links]
    .filter(([fd, link]) => fd > 2 && (link.includes('/dev/ptmx') || (link.startsWith('socket:') && !stdio.has(link))))
    .map(([fd, link]) => `${fd} -> ${link}`);
}
