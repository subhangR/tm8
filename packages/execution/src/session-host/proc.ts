// /proc readers shared by the session host and its server-side client.
import { readFileSync } from 'node:fs';

/**
 * /proc/<pid>/stat field 22 (starttime, clock ticks since boot), as a string,
 * or null when the process is gone. A (pid, starttime) pair names one process
 * for the life of the machine; a bare pid can be recycled (R4).
 */
export function readStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may hold spaces and parens; the fields resume after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? null; // field 22 is index 19 once pid and comm are dropped
  } catch {
    return null;
  }
}
