/**
 * Output law (§7.1, §7.3) + the coordinator's pinned default.
 *
 *   no flag -> human · --format json -> the exact contract DTO · jsonl -> one record per line
 *
 * The assertions that matter are the negative ones: stdout must contain the
 * DATA and nothing else, in all three formats. A diagnostic on stdout is not a
 * cosmetic problem — `worker init` pipes stdout straight into an agent's
 * system prompt, and `--format json` output is piped into `jq`.
 */
import { describe, expect, it } from 'vitest';
import { createOutput, type OutputStreams } from '../src/output.js';
import { CliError } from '../src/exit.js';

function capture(): OutputStreams & { out: string[]; err: string[]; bytes: Uint8Array[] } {
  const out: string[] = [];
  const err: string[] = [];
  const bytes: Uint8Array[] = [];
  return {
    out,
    err,
    bytes,
    stdout(chunk) {
      if (typeof chunk === 'string') out.push(chunk);
      else bytes.push(chunk);
    },
    stderr(chunk) {
      err.push(chunk);
    },
  };
}

const DTO = { id: 'ent_1', title: 'Ship the kernel', version: 3 };

describe('formats render the SAME dto', () => {
  it('human renders through the renderer; stdout gets only that', () => {
    const streams = capture();
    const out = createOutput({ format: 'human', streams });
    out.data(DTO, (dto) => `${dto.id}  ${dto.title}  v${dto.version}`);
    expect(streams.out).toEqual(['ent_1  Ship the kernel  v3\n']);
    expect(streams.err).toEqual([]);
  });

  it('json emits the exact DTO — no wrapper, no renaming, no CLI-private fields', () => {
    const streams = capture();
    const out = createOutput({ format: 'json', streams });
    out.data(DTO, () => 'ignored');
    expect(JSON.parse(streams.out.join(''))).toEqual(DTO);
  });

  it('jsonl emits one complete record per line', () => {
    const streams = capture();
    const out = createOutput({ format: 'jsonl', streams });
    out.line({ seq: 1 }, () => '1');
    out.line({ seq: 2 }, () => '2');
    expect(streams.out.join('').trimEnd().split('\n').map((l) => JSON.parse(l))).toEqual([
      { seq: 1 },
      { seq: 2 },
    ]);
  });

  it('the human renderer receives the DTO itself, so it cannot render a different shape', () => {
    const streams = capture();
    const out = createOutput({ format: 'human', streams });
    let seen: unknown;
    out.data(DTO, (dto) => {
      seen = dto;
      return dto.id;
    });
    expect(seen).toBe(DTO);
  });
});

describe('stream discipline', () => {
  it('notes, warnings and errors all go to stderr, never stdout', () => {
    const streams = capture();
    const out = createOutput({ format: 'json', streams });
    out.note('resolving space from --space');
    out.warn('deprecated field');
    out.error(['tm8: forbidden: nope', '  requestId: req_9']);
    expect(streams.out).toEqual([]);
    expect(streams.err.join('')).toBe(
      'resolving space from --space\ndeprecated field\ntm8: forbidden: nope\n  requestId: req_9\n',
    );
  });

  it('--quiet silences notes but never warnings or errors', () => {
    const streams = capture();
    const out = createOutput({ format: 'human', quiet: true, streams });
    out.note('chatter');
    out.warn('you should know this');
    out.error(['tm8: not_found: gone']);
    expect(streams.err.join('')).toBe('you should know this\ntm8: not_found: gone\n');
  });
});

describe('raw bytes are mutually exclusive with structured output (§7.3)', () => {
  it('writes bytes under human', () => {
    const streams = capture();
    const out = createOutput({ format: 'human', streams });
    out.bytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(streams.bytes).toHaveLength(1);
  });

  it('refuses bytes under json and jsonl', () => {
    for (const format of ['json', 'jsonl'] as const) {
      const out = createOutput({ format, streams: capture() });
      try {
        out.bytes(new Uint8Array([1]));
        throw new Error(`expected a refusal under ${format}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).exitCode).toBe(2);
      }
    }
  });

  it('refuses to splice bytes and structured output into one stdout', () => {
    const out = createOutput({ format: 'human', streams: capture() });
    out.bytes(new Uint8Array([1]));
    expect(() => out.data(DTO, () => 'x')).toThrowError(/cannot follow raw bytes/);
  });

  it('refuses a per-line stream under --format json', () => {
    const out = createOutput({ format: 'json', streams: capture() });
    expect(() => out.line({ seq: 1 }, () => '1')).toThrowError(/--format jsonl/);
  });
});
