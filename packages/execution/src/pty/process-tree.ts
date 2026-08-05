/**
 * Is a PTY's agent *working*, or is it *waiting for a human*?
 *
 * Output silence alone cannot tell these apart, and that is not a tuning
 * problem. Measured against real agents on this platform: a `claude` session
 * sitting at its own prompt went 39.4s without emitting a byte (a true "needs
 * you"), and a `claude` session mid-turn, waiting on a long shell command, went
 * 33.0s and 41.3s without emitting a byte on two separate runs (a false one).
 * Both are silence. No value of `idleAfterMs` separates them, because the
 * distinguishing fact is not in the byte stream at all.
 *
 * It IS in the process tree. An agent running a tool has a live descendant; an
 * agent waiting for you has none. Sampling the tree during those same silent
 * windows separated the two cleanly — 8 samples silent-with-descendant
 * (`bash`, `sleep`) against 14 silent-with-none, no overlap.
 *
 * Why this and not a provider hook: this is a property of the PROCESS, not of
 * any agent's protocol. It works identically for claude-code, codex, and for
 * agent tools tm8 has not added yet — no per-provider parser to write, none to
 * keep in sync as a vendor changes its TUI. Provider hooks are strictly better
 * signals where they exist (they can say WHAT the agent wants), but they are a
 * per-provider adapter on top of this floor, never a replacement for it.
 *
 * The walk is RECURSIVE by design, not for completeness but because a tm8
 * session may be a coordinator: a claude-code session that spawns a codex
 * agent. Such a session is silent at its own PTY while its child does the work,
 * and reporting it as "waiting for you" would be exactly wrong.
 */

import { readdirSync, readFileSync } from 'node:fs';

/**
 * Whether `rootPid` has any live descendant process.
 *
 * Returns `null` when the question cannot be answered on this platform (no
 * readable `/proc`), which callers MUST treat as "no information" and fall back
 * to their silence-only behaviour. Returning `false` there would assert the
 * agent is idle on the strength of a failed measurement — the one error this
 * module exists to stop.
 *
 * Synchronous on purpose. It runs once per idle decision (order of once per
 * 10s per session), never on the output hot path, and the decision it feeds
 * must not interleave with an exit that could invalidate the pid.
 */
export function hasLiveDescendant(rootPid: number): boolean | null {
  const children = readChildMap();
  if (children === null) return null;

  // Breadth-first from the root. Depth is tiny in practice (agent -> shell ->
  // tool), but a `visited` set keeps a malformed/racing /proc from looping.
  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue;
      // Any descendant at all is enough: something below the agent is alive, so
      // the silence is work, not waiting.
      return true;
    }
  }
  return false;
}

/**
 * Every live descendant of `rootPid`, nearest first, as `[pid, comm]`.
 *
 * Not used by the idle gate — {@link hasLiveDescendant} short-circuits and is
 * the cheaper question. This exists for diagnostics and for the attribution the
 * chat surface needs when a NESTED agent is the one that is blocked: naming the
 * wrong agent is worse than naming none, because the user answers a question
 * they were never asked.
 */
export function liveDescendants(rootPid: number): Array<[number, string]> {
  const children = readChildMap();
  if (children === null) return [];
  const out: Array<[number, string]> = [];
  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      out.push([child, readComm(child) ?? '?']);
      queue.push(child);
    }
  }
  return out;
}

/**
 * pid -> its direct children, built from one pass over `/proc`.
 *
 * `null` means /proc is unavailable or unreadable — an answer of "unknown",
 * deliberately distinct from an empty map, which means "scanned, no children".
 */
function readChildMap(): Map<number, number[]> | null {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  const map = new Map<number, number[]>();
  for (const name of entries) {
    // Numeric entries are the processes; everything else in /proc is not one.
    if (name.length === 0 || name.charCodeAt(0) < 0x30 || name.charCodeAt(0) > 0x39) continue;
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    const ppid = readPpid(pid);
    // A process that vanished mid-scan is not an error: /proc is a live view and
    // short-lived tool processes are exactly what we are looking for.
    if (ppid === null) continue;
    const siblings = map.get(ppid);
    if (siblings) siblings.push(pid);
    else map.set(ppid, [pid]);
  }
  return map;
}

/** Parent pid from `/proc/<pid>/stat`, or null if the process is gone. */
function readPpid(pid: number): number | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // Field 4 is ppid, but fields 1-2 are `pid (comm)` and comm may itself contain
  // spaces or parentheses -- so parse from the LAST ')' rather than splitting the
  // whole line, which is the classic way to misread this file.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(' ');
  // rest[0] is state, rest[1] is ppid.
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/** Process name, for diagnostics and nested-agent attribution. */
function readComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}
