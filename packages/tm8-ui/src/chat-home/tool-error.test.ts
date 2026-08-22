/**
 * The failure-reason extractor, against the shapes that actually arrive.
 *
 * The first case is not hypothetical: it is the exact payload that made an
 * artifact call fail in #feature-ideas on 2026-08-22 and rendered as nothing
 * but "Output was not created." Every other case exists because the same
 * reason can arrive wrapped one more layer deep depending on provider and
 * transport, and a reason that survives only one of those wrappings is a
 * reason the user sees only sometimes.
 */
import { describe, expect, it } from 'vitest';
import { toolFailureReason } from './tool-error';

describe('toolFailureReason', () => {
  it('reads tm8’s own MCP error envelope — the live artifact_create failure', () => {
    expect(toolFailureReason({
      schemaVersion: 'tm8.mcp.error.v1',
      error: { code: 'invalid_input', message: 'manifest.files needs objects', retryable: false },
    })).toEqual({ code: 'invalid_input', message: 'manifest.files needs objects' });
  });

  it('unwraps a content block whose text is itself the JSON envelope', () => {
    expect(toolFailureReason({
      content: [
        { type: 'text', text: '{"error":{"code":"payload_too_large","message":"bundle exceeds 25 MiB"}}' },
      ],
    })).toEqual({ code: 'payload_too_large', message: 'bundle exceeds 25 MiB' });
  });

  it('takes the first block that carries a reason, so a leading empty one cannot mask it', () => {
    expect(toolFailureReason([
      { type: 'text', text: '   ' },
      { type: 'text', text: '{"message":"entrypoint is not one of the supplied file paths"}' },
    ])).toEqual({ message: 'entrypoint is not one of the supplied file paths' });
  });

  it('accepts a bare string result as the sentence itself', () => {
    expect(toolFailureReason('tool timed out after 30s')).toEqual({ message: 'tool timed out after 30s' });
  });

  it('falls back to prose when a string only looked like JSON', () => {
    expect(toolFailureReason('{not really json')).toEqual({ message: '{not really json' });
  });

  it('reads a flat {code,message} result', () => {
    expect(toolFailureReason({ code: 'not_found', message: 'no such entity' }))
      .toEqual({ code: 'not_found', message: 'no such entity' });
  });

  it('reads a string-valued error', () => {
    expect(toolFailureReason({ error: 'permission denied' })).toEqual({ message: 'permission denied' });
  });

  it('collapses whitespace so a multi-line message stays one line', () => {
    expect(toolFailureReason({ message: 'first line\n\n   second line' }))
      .toEqual({ message: 'first line second line' });
  });

  it('truncates a long message with an ellipsis rather than filling the card', () => {
    const reason = toolFailureReason({ message: 'x'.repeat(1000) });
    expect(reason).not.toBeNull();
    expect(reason!.message.length).toBe(240);
    expect(reason!.message.endsWith('…')).toBe(true);
  });

  it('returns null when there is no usable sentence, so the caller keeps its own wording', () => {
    expect(toolFailureReason(null)).toBeNull();
    expect(toolFailureReason(undefined)).toBeNull();
    expect(toolFailureReason({})).toBeNull();
    expect(toolFailureReason({ ok: true, count: 3 })).toBeNull();
    expect(toolFailureReason('   ')).toBeNull();
  });

  it('does not chase an unbounded nest', () => {
    let deep: unknown = { message: 'buried' };
    for (let i = 0; i < 40; i++) deep = { data: deep };
    expect(toolFailureReason(deep)).toBeNull();
  });
});
