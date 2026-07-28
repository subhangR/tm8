/**
 * The diagnostic surface: what an operator/agent actually reads on stderr.
 *
 * Two facts must survive from the Server to that line or the caller cannot
 * act: `details.reason` (the closed `AmendmentErrorReason`, e.g.
 * `use_message_send`) and `requestId` (the only handle for correlating with
 * Server logs). The CLI invents neither.
 */
import { describe, expect, it } from 'vitest';
import type { AmendmentErrorReason } from '@tm8/contract';
import {
  ApiError,
  InterruptedError,
  ProtocolError,
  RetiredCommandError,
  TransportError,
  UnsettledDeliveryError,
  errorLines,
  exitCodeFor,
} from '../src/errors.js';
import { CliError } from '../src/exit.js';

const forbidden = (reason: AmendmentErrorReason): ApiError =>
  new ApiError(403, 'forbidden', 'the public authoring route is message send', 'req_77', false, { reason }, 'execution.prompt');

describe('surfacing what the Server said', () => {
  it('renders code, message, reason and requestId on one stderr line', () => {
    expect(errorLines(forbidden('use_message_send'))).toEqual([
      'tm8: forbidden: the public authoring route is message send · reason: use_message_send · requestId: req_77',
    ]);
  });

  it('carries every closed reason through untouched', () => {
    const reasons: AmendmentErrorReason[] = [
      'use_message_send',
      'automated_wake_limit',
      'session_contact_forbidden',
      'project_not_linked',
      'menu_revision_conflict',
      'profile_principal_required',
      'profile_retired',
      'attachment_edge_owned',
    ];
    for (const reason of reasons) {
      expect(forbidden(reason).reason, reason).toBe(reason);
      expect(errorLines(forbidden(reason))[0], reason).toContain(`reason: ${reason}`);
    }
  });

  it('omits the reason clause when the Server sent no details, rather than inventing one', () => {
    const err = new ApiError(404, 'not_found', 'no such entity', 'req_1', false, undefined);
    expect(err.reason).toBeUndefined();
    expect(errorLines(err)).toEqual(['tm8: not_found: no such entity · requestId: req_1']);
  });

  it('adds retry advice ONLY when the Server marked it retryable, and says to reuse the id', () => {
    const retryable = new ApiError(429, 'rate_limited', 'slow down', 'req_2', true, undefined);
    expect(errorLines(retryable)[1]).toContain('SAME --mutation-id');
    expect(errorLines(new ApiError(409, 'conflict', 'stale', 'req_3', false, undefined))).toHaveLength(1);
  });

  it('says what a 501 IS — a catalogued operation not built on this node', () => {
    const lines = errorLines(new ApiError(501, 'not_implemented', 'no handler', 'req_4', false, undefined));
    expect(lines[1]).toContain('not implemented on this node');
    expect(exitCodeFor(new ApiError(501, 'not_implemented', 'x', 'r', false, undefined))).toBe(8);
  });
});

describe('local failures', () => {
  it('a CliError renders its message and its hint', () => {
    expect(errorLines(new CliError('unknown command: entity yeet', 2, { hint: 'run `tm8 help`' }))).toEqual([
      'tm8: unknown command: entity yeet',
      '  run `tm8 help`',
    ]);
  });

  it('a retired command says where the capability WENT', () => {
    const err = new RetiredCommandError('whoami', 'read your identity with `tm8 identity get`');
    expect(err.exitCode).toBe(2);
    expect(errorLines(err)).toEqual([
      'tm8: `tm8 whoami` no longer exists — read your identity with `tm8 identity get`',
      '  run `tm8 help` for the current grammar',
    ]);
  });
});

describe('the exit funnel classifies everything', () => {
  it('maps each error class to its frozen code', () => {
    expect(exitCodeFor(new TransportError('down'))).toBe(7);
    expect(exitCodeFor(new ProtocolError('drift', 500))).toBe(10);
    expect(exitCodeFor(new ProtocolError('lb', 503))).toBe(7);
    expect(exitCodeFor(new UnsettledDeliveryError('one target never settled', {}, []))).toBe(11);
    expect(exitCodeFor(new InterruptedError())).toBe(130);
    expect(exitCodeFor(new CliError('bad flag'))).toBe(2);
  });

  it('an UNCLASSIFIED throw is a protocol failure (10), never a silent success', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(10);
    expect(exitCodeFor('a string')).toBe(10);
    expect(exitCodeFor(undefined)).toBe(10);
    expect(errorLines(new Error('boom'))[0]).toContain('unexpected failure');
  });

  it('exit 11 tells the caller the message IS stored, so they do not resend', () => {
    expect(errorLines(new UnsettledDeliveryError('delivery did not settle', {}, []))[1]).toContain('do not resend');
  });
});
