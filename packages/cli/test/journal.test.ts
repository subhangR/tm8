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

describe('class is decided at write time (F8)', () => {
  const CALL = {
    operation: 'entities.get', method: 'GET', path: '/v2/entities/x',
    status: 200, requestChars: 0, responseChars: 10, durationMs: 5,
  };

  function classWritten(env: Partial<NodeJS.ProcessEnv>, baseUrl: string): string | undefined {
    const path = tempJournal();
    const j = createJournal({ ...envFor(path), ...env });
    j.noteCall({ ...CALL, baseUrl });
    j.finish({ path: ['entity', 'get'], argv: ['entity', 'get', 'x'], exitCode: 0 });
    return readRecords(path)[0]!.class;
  }

  it('an explicit TM8_JOURNAL_CLASS wins over every heuristic', () => {
    // A stable-port call would say agent; the env says harness. Env wins.
    expect(classWritten({ TM8_JOURNAL_CLASS: 'harness' }, 'http://127.0.0.1:7778')).toBe('harness');
    expect(classWritten({ TM8_JOURNAL_CLASS: 'human' }, 'http://127.0.0.1:55555')).toBe('human');
  });

  it('an INVALID TM8_JOURNAL_CLASS falls through to the heuristics, never onto the disk', () => {
    const path = tempJournal();
    const j = createJournal({ ...envFor(path), TM8_JOURNAL_CLASS: 'robot' });
    j.finish({ path: ['help'], argv: ['help'], exitCode: 0 });
    const [rec] = readRecords(path);
    expect(['agent', 'harness', 'human']).toContain(rec.class);
    expect(rec.class).not.toBe('robot');
  });

  it('this very test run classifies as harness WITHOUT being told — the cwd heuristic', () => {
    // vitest runs from packages/cli, so even a record whose mocked call names
    // a stable node is tagged harness here. That is the safety property: an
    // in-process unit test with a stale inherited journal env cannot pollute
    // the agent corpus. The port heuristic with a CONTROLLED cwd is pinned in
    // journal-stats.test.ts, where cwd is an explicit argument.
    expect(classWritten({}, 'http://127.0.0.1:53211')).toBe('harness');
    expect(classWritten({}, 'http://127.0.0.1:7778')).toBe('harness');
  });

  it('every record carries a class — the field is never omitted at write time', () => {
    const path = tempJournal();
    const j = createJournal(envFor(path));
    j.finish({ path: ['help'], argv: ['help'], exitCode: 0 });
    // The default-agent path needs a non-repo cwd, which a unit test cannot
    // honestly fake (see journal-stats.test.ts for the controlled version).
    // What must hold HERE is that the writer always answers.
    expect(['agent', 'harness', 'human']).toContain(readRecords(path)[0]!.class);
  });
});

describe('the spend line (F8 visible spend)', () => {
  function stderrDuring(fn: () => void): string {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      fn();
    } finally {
      process.stderr.write = original;
    }
    return chunks.join('');
  }

  it('an agent invocation prints exactly one stderr line, after the record is written', () => {
    const path = tempJournal();
    const j = createJournal({ ...envFor(path), TM8_JOURNAL_CLASS: 'agent' });
    j.wrapStreams(sink).stdout('x'.repeat(4_000));
    const text = stderrDuring(() => j.finish({ path: ['entity', 'get'], argv: ['entity', 'get', 'x'], exitCode: 0 }));
    expect(text).toMatch(/^\[journal: ~\d+k? est chars-over-4 this session; \d+% on re-fetches\]\n$/);
    expect(readRecords(path)).toHaveLength(1); // the line never replaces the record
  });

  it('totals accumulate across sibling invocations of one session', () => {
    const path = tempJournal();
    for (let i = 0; i < 3; i += 1) {
      const j = createJournal({ ...envFor(path), TM8_JOURNAL_CLASS: 'agent' });
      j.wrapStreams(sink).stdout('x'.repeat(4_000)); // 1k est tokens each
    // identical argv on purpose: run 2 and 3 are byte-identical re-fetches
      const text = stderrDuring(() => j.finish({ path: ['entity', 'get'], argv: ['entity', 'get', 'x'], exitCode: 0 }));
      if (i === 2) {
        expect(text).toContain('~3k est chars-over-4');
        // 2 of 3 cli→agent payloads are repeats of the first → 66%.
        expect(text).toMatch(/6[67]% on re-fetches/);
      }
    }
  });

  it('a harness invocation prints NOTHING — fixtures must stay byte-deterministic', () => {
    const path = tempJournal();
    const j = createJournal({ ...envFor(path), TM8_JOURNAL_CLASS: 'harness' });
    const text = stderrDuring(() => j.finish({ path: ['help'], argv: ['help'], exitCode: 0 }));
    expect(text).toBe('');
    expect(readRecords(path)).toHaveLength(1); // still journalled, still tagged
    expect(readRecords(path)[0]!.class).toBe('harness');
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
