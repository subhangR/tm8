import { readFile } from 'node:fs/promises';

/**
 * DID THE KERNEL KILL SOMETHING FOR MEMORY?
 *
 * A SIGKILL from a deploy and a SIGKILL from the OOM killer are byte-for-byte
 * identical at the process level: node-pty reports `{ exitCode: 0, signal: 9 }`
 * for both. Signal number alone therefore CANNOT distinguish the one death the
 * standing policy permits — resource exhaustion — from the deploy deaths the
 * policy forbids. Guessing "9 might mean OOM" would be worse than saying
 * nothing, because it would launder a deploy bug as an infrastructure fact.
 *
 * So this asks the kernel instead. cgroup v2 keeps a monotonic counter of OOM
 * kills per cgroup at `memory.events`:
 *
 *     low 0
 *     high 0
 *     max 0
 *     oom 0
 *     oom_kill 0        <-- this one
 *
 * Read it when a session starts, read it again when the session ends, and an
 * ADVANCE across that window is positive evidence that the kernel killed
 * something in this cgroup for memory. That is a fact, not an inference.
 *
 * MEASURED on the prod node 2026-08-22: `oom_kill 0`, `memory.max = max`,
 * `memory.current ≈ 4.5G`. No OOM had occurred — every death studied was a
 * deploy. This is wired before it is needed rather than after, because once
 * deploy deaths are eliminated it becomes the signal that matters.
 *
 * HONESTY BOUND — read this before trusting a positive.
 *
 *   * The counter is PER CGROUP, not per process. Under a single-unit
 *     arrangement every agent shares the server's cgroup, so an advance says
 *     "the kernel killed SOMETHING here for memory", not "it killed THIS
 *     session". With two agents dying in the same window, both are told the
 *     same thing, and at most one of them is right.
 *   * It is therefore only sound to consult when there is ONE plausible
 *     candidate, or when the caller is willing to say "a memory kill happened
 *     in this window" rather than "this session was the one killed".
 *   * A NEGATIVE is strong: the counter did not move, so the kernel killed
 *     nothing for memory, so whatever happened was not an OOM. That direction
 *     carries no ambiguity, and it is the direction that matters most here —
 *     it lets every other ending be reported honestly as NOT a memory problem.
 *
 * Returns null when the counter cannot be read at all (not cgroup v2, a
 * container without the file, a permission refusal). Null means "no evidence
 * either way" and MUST NOT be rendered as "not an OOM".
 */
export async function readOomKillCount(cgroupFile = '/proc/self/cgroup'): Promise<number | null> {
  const path = await resolveMemoryEventsPath(cgroupFile);
  if (path === null) return null;
  try {
    const text = await readFile(path, 'utf8');
    // `oom_kill <n>` — anchored to a line start so `oom_group_kill` cannot
    // match it, and so a future kernel adding `nested_oom_kill` cannot either.
    const match = /^oom_kill (\d+)$/m.exec(text);
    if (match?.[1] === undefined) return null;
    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The cgroup v2 path for THIS process, turned into its `memory.events` file.
 * `/proc/self/cgroup` on v2 holds exactly one line, `0::<path>`, where the path
 * is relative to the cgroup mount.
 */
async function resolveMemoryEventsPath(cgroupFile: string): Promise<string | null> {
  try {
    const text = await readFile(cgroupFile, 'utf8');
    const match = /^0::(.*)$/m.exec(text);
    const rel = match?.[1];
    if (rel === undefined || rel === '') return null;
    // A leading slash is already present in the v2 line; join without doubling.
    return `/sys/fs/cgroup${rel}/memory.events`;
  } catch {
    return null;
  }
}

/**
 * Did the kernel OOM-kill anything between two readings?
 *
 * `before` null (never sampled) or `after` null (unreadable now) both yield
 * `false` — absence of evidence, reported as such. Only a genuine ADVANCE is
 * a positive, and the counter is monotonic so a decrease means the cgroup was
 * recreated underneath us and is not evidence of anything.
 */
export function oomKillObserved(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return false;
  return after > before;
}
