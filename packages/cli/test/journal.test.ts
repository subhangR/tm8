/**
 * The session command journal.
 *
 * The properties under test are almost all NEGATIVE — what the journal must
 * never do to the command it is observing. A journal that records perfectly
 * but perturbs stdout, or turns a working command into a failing one when the
 * disk is full, is a defect of a much worse kind than a missing field.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJournal } from '../src/journal.js';
import type { OutputStreams } from '../src/output.js';

const SESSION = '019fbbcd-cef8-7701-ae98-3d5f1d459ed8';

function tempJournal(): string {
  return join(mkdtempSync(join(tmpdir(), 'tm8-journal-')), 'commands.jsonl');
}

function envFor(path: string): NodeJS.ProcessEnv {
  return { TM8_JOURNAL_PATH: path, TM8_SESSION_ID: SESSION };
}

function readRecords(path: string): Record<string, any>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

const sink: OutputStreams = { stdout: () => {}, stderr: () => {} };

describe('the gate', () => {
  it('is inert without TM8_JOURNAL_PATH, so a human at their own terminal writes nothing', () => {
    const j = createJournal({ TM8_SESSION_ID: SESSION });
    expect(j.enabled).toBe(false);
    j.finish({ path: ['help'], argv: ['help'], exitCode: 0 });
    // Nothing to assert a file against — the point is that it did not throw
    // and had nowhere to write.
  });

  it('is inert without a session id: a journal that cannot name its records is not a journal', () => {
    const path = tempJournal();
    expect(createJournal({ TM8_JOURNAL_PATH: path }).enabled).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

describe('observing without participating', () => {
  it('forwards every byte to the real stream unchanged', () => {
    const path = tempJournal();
    const seen: string[] = [];
    const j = createJournal(envFor(path));
    const wrapped = j.wrapStreams({ stdout: (c) => seen.push(String(c)), stderr: (c) => seen.push(c) });
    wrapped.stdout('alpha');
    wrapped.stderr('beta');
    expect(seen).toEqual(['alpha', 'beta']);
  });

  it('never throws out of finish(), even when the path cannot be written', () => {
    // A directory where a file must go: the append can only fail.
    const dir = mkdtempSync(join(tmpdir(), 'tm8-journal-'));
    const j = createJournal({ TM8_JOURNAL_PATH: dir, TM8_SESSION_ID: SESSION });
    expect(() => j.finish({ path: ['help'], argv: ['help'], exitCode: 0 })).not.toThrow();
  });

  it('writes exactly one record even if finish() is called twice', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.finish({ path: ['help'], argv: ['help'], exitCode: 0 });
    j.finish({ path: ['help'], argv: ['help'], exitCode: 0 });
    expect(readRecords(path)).toHaveLength(1);
  });
});

describe('counting', () => {
  it('records exact character counts and a labelled estimate derived from them', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    const wrapped = j.wrapStreams(sink);
    wrapped.stdout('x'.repeat(400));
    wrapped.stderr('y'.repeat(40));
    j.finish({ path: ['entity', 'get'], argv: ['entity', 'get', 'abc'], exitCode: 0 });

    const [rec] = readRecords(path);
    expect(rec.output.stdoutChars).toBe(400);
    expect(rec.output.stderrChars).toBe(40);
    expect(rec.tokens.estimator).toBe('chars/4');
    // The estimate is a pure function of the exact counts: (400 + 40) / 4.
    expect(rec.tokens.cliToAgent).toBe(110);
  });

  it('counts stdin toward what the AGENT emitted, not toward what it consumed', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.noteStdin(80);
    j.finish({ path: ['message', 'send'], argv: ['message', 'send'], exitCode: 0 });

    const [rec] = readRecords(path);
    expect(rec.input.stdinChars).toBe(80);
    // 'message send' is 12 chars, + 80 stdin = 92 → 23.
    expect(rec.tokens.agentToCli).toBe(23);
    expect(rec.tokens.cliToAgent).toBe(0);
  });

  it('keeps counts exact when the sample is truncated', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.wrapStreams(sink).stdout('z'.repeat(50_000));
    j.finish({ path: ['graph'], argv: ['graph'], exitCode: 0 });

    const [rec] = readRecords(path);
    expect(rec.output.stdoutChars).toBe(50_000); // ground truth, never bounded
    expect(rec.output.stdoutSample.length).toBeLessThanOrEqual(2_000);
    expect(rec.output.truncated).toBe(true);
  });

  it('records a transport failure as a call with a null status, not as no call', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.noteCall({
      operation: 'entities.get', method: 'GET', path: '/v2/entities/x',
      baseUrl: 'http://127.0.0.1:4610', status: null,
      requestChars: 0, responseChars: 0, durationMs: 12,
    });
    j.finish({ path: ['entity', 'get'], argv: ['entity', 'get', 'x'], exitCode: 6 });

    const [rec] = readRecords(path);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].status).toBeNull();
    expect(rec.result.exitCode).toBe(6);
  });
});

describe('redaction happens at write time, so the secret never reaches the disk', () => {
  it('redacts a secret-looking option value in both spellings', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.finish({
      path: ['help'],
      argv: ['help', '--token', 'SUPERSECRET', '--api-key=HUNTER2', '--format', 'json'],
      exitCode: 0,
    });

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('SUPERSECRET');
    expect(raw).not.toContain('HUNTER2');
    const [rec] = readRecords(path);
    expect(rec.command.argv).toEqual([
      'help', '--token', '<redacted>', '--api-key=<redacted>', '--format', 'json',
    ]);
  });

  it('does not swallow the following FLAG when a secret option has no value', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.finish({ path: ['help'], argv: ['help', '--token', '--format', 'json'], exitCode: 0 });
    // `--format` must survive: redaction may not eat a real option.
    expect(readRecords(path)[0].command.argv).toContain('--format');
  });

  it('leaves ordinary values alone', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.finish({ path: ['entity', 'get'], argv: ['entity', 'get', '--format', 'json'], exitCode: 0 });
    expect(readRecords(path)[0].command.argv).toEqual(['entity', 'get', '--format', 'json']);
  });
});

describe('concurrent sibling invocations', () => {
  it('appends whole lines rather than corrupting each other', () => {
    const path = tempJournal();
    // Each `tm8` process has its own journal instance appending to one file.
    for (let i = 0; i < 25; i += 1) {
      const j = createJournal(envFor(path));
      j.wrapStreams(sink).stdout('o'.repeat(i * 37));
      j.finish({ path: ['help'], argv: ['help', String(i)], exitCode: 0 });
    }
    const records = readRecords(path); // throws if any line is torn
    expect(records).toHaveLength(25);
    expect(records[24].output.stdoutChars).toBe(24 * 37);
  });

  it('tolerates a pre-existing malformed line without losing the good ones', () => {
    const path = tempJournal();
    writeFileSync(path, 'not json at all\n');
    const j = createJournal(envFor(path));
    j.finish({ path: ['help'], argv: ['help'], exitCode: 0 });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).command.path).toEqual(['help']);
  });
});
