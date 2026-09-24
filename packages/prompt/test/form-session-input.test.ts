/**
 * Forms §7.2: the `form_response` / `form_cancelled` session-input envelope.
 *
 * The one property that differs from the incoming-message template: a form
 * response is never refused for size. It is cut by UTF-8 bytes — measured on
 * the ESCAPED envelope, on a code-point boundary — to fit the smaller of the
 * target profile's ceiling and the 16,384-byte budget, and says so beside its
 * fetch pointer. The answer stays stored in full either way.
 */
import { describe, expect, it } from 'vitest';

import { BYTE_BUDGETS, formSessionInputInjection, utf8Bytes, type FormSessionInputFacts } from '../src/index.js';

const base: FormSessionInputFacts = {
  kind: 'form_response',
  messageId: 'm-1',
  messageBatchId: 'form_response:r-2',
  deliveryAttemptId: 'd-1',
  deliveryAttemptNo: 2,
  senderActorId: 'member-1',
  senderActorKind: 'member',
  destinationSessionId: 's-1',
  formId: 'f-1',
  formStatus: 'open',
  structureVersion: 3,
  sourceMessageId: 'm-form',
  response: { id: 'r-2', submittedAt: '2026-09-24T00:00:00.000Z', answered: 2, of: 3, revision: 2, supersedesId: 'r-1' },
  body: 'Form: <Title> & co\n1. [pick] Pick → x',
};

const dataOf = (envelope: string): string => envelope.slice(envelope.indexOf('<untrusted_data'));

describe('formSessionInputInjection', () => {
  it('renders the §7.2 control lines; the title and answers stay in the untrusted block', () => {
    const out = formSessionInputInjection(base);
    expect(out).toContain('kind="form_response" message_id="m-1" message_batch_id="form_response:r-2" delivery_attempt_id="d-1"');
    expect(out).toContain('<form id="f-1" title_ref="untrusted" structure_version="3" status="open" />');
    expect(out).toContain('<response id="r-2" submitted_at="2026-09-24T00:00:00.000Z" answered="2" of="3" revision="2" supersedes="r-1" />');
    expect(out).toContain('<fetch command="tm8 form response get r-2 --format json" />');
    expect(out).toContain('anchor_id="f-1" parent_message_id="m-form"');
    expect(out).toContain('attempt="2"');
    expect(out.slice(0, out.indexOf('</trusted_control>'))).not.toContain('Title');
    expect(dataOf(out)).toContain('type="form-response" encoding="escaped-utf8" truncated="false" fetch_ref="tm8 form response get r-2 --format json"');
    expect(dataOf(out)).toContain('Form: &lt;Title&gt; &amp; co');
  });

  it('a first revision carries no revision/supersedes attributes', () => {
    const out = formSessionInputInjection({ ...base, response: { ...base.response!, revision: 1, supersedesId: null } });
    expect(out).not.toContain('revision=');
    expect(out).not.toContain('supersedes=');
  });

  it('10k characters of CJK plus <& fit the budget by bytes, truncated, with the fetch pointer', () => {
    const body = `${'漢字かな'.repeat(2_500)}<&`;
    expect(body.length).toBeGreaterThanOrEqual(10_000);
    const out = formSessionInputInjection({ ...base, body });
    expect(utf8Bytes(out)).toBeLessThanOrEqual(BYTE_BUDGETS.incomingMessageInjection);
    expect(dataOf(out)).toContain('truncated="true" fetch_ref="tm8 form response get r-2 --format json"');
    expect(dataOf(out)).toContain('… truncated to fit; fetch the full response.');
    expect(out.match(/<\/untrusted_data>/g)).toHaveLength(1);
    expect(out).not.toContain('�');
  });

  it('honours a smaller profile ceiling, and escaping is counted (a body of < is 4x on the wire)', () => {
    const out = formSessionInputInjection({ ...base, body: '<'.repeat(6_000), maxBytes: 4_096 });
    expect(utf8Bytes(out)).toBeLessThanOrEqual(4_096);
    expect(dataOf(out)).toContain('&lt;&lt;');
    expect(dataOf(out)).toContain('truncated="true"');
  });

  it('a surrogate pair is never split', () => {
    const out = formSessionInputInjection({ ...base, body: '🛠'.repeat(5_000), maxBytes: 3_000 });
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('form_cancelled: no response line, the notice body, and a fetch for the form', () => {
    const { response: _drop, ...rest } = base;
    const out = formSessionInputInjection({ ...rest, kind: 'form_cancelled', formStatus: 'cancelled',
      body: 'form_cancelled: T\nform: f-1\nreason: gone' });
    expect(out).toContain('kind="form_cancelled"');
    expect(out).not.toContain('<response ');
    expect(out).toContain('<fetch command="tm8 entity get f-1 --format json" />');
    expect(dataOf(out)).toContain('type="form-notice"');
  });
});
