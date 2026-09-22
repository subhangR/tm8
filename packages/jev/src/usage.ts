// Metadata only: never persist request state, question text, response bodies or keys.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const JEV_USAGE_FILENAME = 'jev-usage.jsonl';
export type JevCaller = 'routing' | 'context' | 'roster' | 'advise';
export type JevFailureReason =
  | 'timeout' | 'budget' | '429' | '529' | '5xx'
  | 'no_key' | 'unparsed' | 'http_error' | 'network';
export type JevOutcome = 'ok' | JevFailureReason;

export interface JevUsageContext {
  caller: JevCaller;
  spaceId?: string | null;
  subjectId?: string | null;
}

export interface JevUsageEntry {
  readonly at: string;
  readonly caller: JevCaller;
  readonly spaceId: string | null;
  readonly subjectId: string | null;
  /** Null when the server did not identify a concrete version. */
  readonly jevModel: string | null;
  readonly inputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly outcome: JevOutcome;
}

export type JevUsageSink = (entry: JevUsageEntry) => void | Promise<void>;

export function jevUsagePath(dataDir?: string): string {
  const root = dataDir ?? (process.env.TM8_DATA_DIR?.trim()
    || join(homedir(), process.env.TM8_ENV === 'prod' ? '.tm8' : '.tm8-dev'));
  const expanded = root === '~' ? homedir() : root.startsWith('~/') ? join(homedir(), root.slice(2)) : root;
  return join(resolve(expanded), JEV_USAGE_FILENAME);
}

/** A caller can inject a sink to use another node data root or capture test rows. */
export function fileUsageSink(path: string): JevUsageSink {
  return async (entry) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  };
}

/** A version is positive evidence; a floating alias is never a cache identity. */
export function concreteJevModel(model: unknown): string | null {
  if (typeof model !== 'string' || !model.trim()) return null;
  const value = model.trim();
  if (/^(?:unknown|unavailable|null|default|latest|auto|jev)$/i.test(value)
    || /(?:^|[-_:])(?:latest|default|auto)$/i.test(value)) return null;
  return value;
}
