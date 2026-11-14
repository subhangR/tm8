/**
 * Voice notes to text on this host (migration 442 §3). No API and no key: the
 * server runs one local program, and nothing leaves the machine.
 *
 * THE PROGRAM. `TM8_TRANSCRIBE_BIN` names it (set but empty: transcription is
 * off); otherwise `tm8-transcribe` on PATH, else in `$HOME/.local/bin` (a
 * systemd unit's PATH rarely has it). It is run as `<program> -` with the audio
 * bytes on stdin, and prints one JSON object on stdout:
 *
 *     {"text": "...", "language": "te", ...}
 *
 * exiting 0. Exit 3 means the audio is longer than it will transcribe. Any
 * other exit, a timeout or output that is not that object is a failure, which
 * the caller records; the voice note keeps its file either way. On the tm8
 * host the program wraps faster-whisper with local Whisper weights, refuses
 * notes over 5 minutes, and takes up to about 1.5x a note's length on a busy
 * host, hence the 10-minute default timeout.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface Transcript {
  readonly text: string;
  readonly language: string | null;
}

export type Transcriber = (audio: Buffer, mime: string | null) => Promise<Transcript>;

const PROGRAM = 'tm8-transcribe';
const MAX_STDOUT_BYTES = 1_000_000;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The transcriber to run, or null when there is none (or it is turned off). */
export function findTranscriber(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env['TM8_TRANSCRIBE_BIN'];
  if (configured !== undefined) {
    const path = configured.trim();
    return path !== '' && executable(path) ? path : null;
  }
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((d) => d !== '');
  if (env['HOME']) dirs.push(join(env['HOME'], '.local', 'bin'));
  for (const dir of dirs) {
    const candidate = join(dir, PROGRAM);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/**
 * Runs `program -` once per voice note, the audio on stdin. At `timeoutMs` its
 * whole process group is killed and the call fails at once: a child the
 * program started could otherwise hold the pipes open and stall the queue
 * behind it.
 */
export function createLocalTranscriber(program: string, options: { timeoutMs?: number } = {}): Transcriber {
  const timeoutMs = options.timeoutMs ?? 600_000;
  return (audio) => new Promise<Transcript>((resolve, reject) => {
    // detached: its own process group, so the timeout can kill everything it started.
    const child = spawn(program, ['-'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid === undefined) throw new Error('no pid');
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes < MAX_STDOUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 16) err.push(chunk);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return undefined; // already failed at the deadline
      if (code === 3) return reject(new Error('too_long'));
      if (code !== 0) {
        const detail = Buffer.concat(err).toString('utf8').trim().slice(0, 200);
        return reject(new Error(`exited ${code ?? signal}${detail ? `: ${detail}` : ''}`));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(out).toString('utf8'));
      } catch {
        return reject(new Error('printed no JSON'));
      }
      const value = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
      if (typeof value['text'] !== 'string') return reject(new Error('printed no text'));
      resolve({ text: value['text'], language: typeof value['language'] === 'string' ? value['language'] : null });
    });
    // The program may exit before reading everything (a decode error); that is its answer, not ours.
    child.stdin.on('error', () => undefined);
    child.stdin.end(audio);
  });
}
