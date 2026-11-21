import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { CONNECTORS } from '../../src/egress/connectors.js';
import { checkBody, JSON_BODY_ISSUE_BUDGET, type ConnectorOperation } from '../../src/egress/operations.js';
import { vaultBodyLimit } from '../../src/relay/routes.js';
import { EgressRefusal } from '../../src/types.js';
import { trackedObjects, zodNodes } from '../support/zod-walk.js';

// Review addendum 2, C4: a vetted connector's JSON body check stops once a body has raised more than
// JSON_BODY_ISSUE_BUDGET zod issues (src/bounded-parse.ts; zod 3.25.76 is in the range of
// GHSA-mrhx-c7xc-m3w5). The budget also counts the issues of union options tried before the one a
// passing body matches, so these tests fill the vault.callApi body cap with the passing bodies that
// raise the most of those. The JSON value alone is held to the whole cap, which is more than an agent
// can send: the rest of the vault.callApi input shares it. Every body here is synthetic.

const CAP = vaultBodyLimit('vault.callApi');

function operation(connector: string, id: string): ConnectorOperation {
  const found = CONNECTORS[connector]?.operations?.find((row) => row.id === id);
  if (found?.body?.kind !== 'json') throw new Error(`no JSON operation ${connector} ${id}`);
  return found;
}

function schemaOf(op: ConnectorOperation): ZodTypeAny {
  if (op.body?.kind !== 'json') throw new Error(`${op.id} takes no JSON body`);
  return op.body.schema as ZodTypeAny;
}

/** How many issues zod raises while checking `value`, counted the way the budget counts them. */
function raisedIssues(schema: ZodTypeAny, value: unknown): number {
  let raised = 0;
  schema.safeParse(value, { errorMap: (_issue, context) => { raised += 1; return { message: context.defaultError }; } });
  return raised;
}

/** The body `fill(count)` for the largest count whose JSON stays within the body cap. */
function filledToCap(fill: (count: number) => unknown): unknown {
  let low = 1;
  let high = CAP;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(fill(middle))) <= CAP) low = middle; else high = middle - 1;
  }
  return fill(low);
}

const repeat = <T>(count: number, item: () => T): T[] => Array.from({ length: count }, item);

// Each body puts every small union at the option tried last, and fills the rest of the cap with the
// smallest element that makes a union try a failing option first.
const WORST_PASSING: [connector: string, op: string, what: string, body: () => unknown][] = [
  ['openai', 'chat.completions.create', 'messages with array content', () => filledToCap((count) => ({
    model: 'm', stop: [], tool_choice: { type: 'function', function: { name: 'n' } },
    response_format: { type: 'json_schema', json_schema: { name: 'n' } },
    messages: repeat(count, () => ({ role: 'user', content: [] })) }))],
  ['anthropic', 'messages.create', 'messages with array content', () => filledToCap((count) => ({
    model: 'm', max_tokens: 1, system: [], tool_choice: { type: 'none' }, thinking: { type: 'disabled' },
    messages: repeat(count, () => ({ role: 'user', content: [{}] })) }))],
  ['anthropic', 'messages.countTokens', 'messages with array content', () => filledToCap((count) => ({
    model: 'm', system: [], tool_choice: { type: 'none' }, thinking: { type: 'disabled' },
    messages: repeat(count, () => ({ role: 'user', content: [{}] })) }))],
  ['openai', 'responses.create', 'every union at its last option', () => ({
    model: 'm', store: false, input: [{}], tool_choice: { type: 'function', name: 'n' },
    text: { format: { type: 'json_schema', name: 'n', schema: {} } } })],
  ['openai', 'embeddings.create', '8,192 tokens', () => ({ model: 'm', input: repeat(8192, () => 0) })],
  ['openai', 'embeddings.create', '2,048 strings', () => ({ model: 'm', input: repeat(2048, () => '') })],
  ['openai', 'embeddings.create', '2,048 token lists', () => ({ model: 'm', input: repeat(2048, () => [0]) })],
];

describe('connector body checks stop at JSON_BODY_ISSUE_BUDGET (review addendum 2, C4)', () => {
  it.each(WORST_PASSING)('passes %s %s with %s, raising well under the budget', (connector, id, _what, body) => {
    const op = operation(connector, id);
    const value = body();
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(CAP);
    expect(checkBody(op, { kind: 'json', value })).toEqual({ contentType: 'application/json' });
    const raised = raisedIssues(schemaOf(op), value);
    expect(raised).toBeLessThanOrEqual(0.6 * JSON_BODY_ISSUE_BUDGET);
  });

  it('still refuses embeddings input past its maximums', () => {
    const op = operation('openai', 'embeddings.create');
    for (const input of [repeat(8193, () => 0), [repeat(8193, () => 0)], repeat(2049, () => ''), repeat(2049, () => [0])]) {
      expect(() => checkBody(op, { kind: 'json', value: { model: 'm', input } })).toThrow(EgressRefusal);
    }
  });

  it('refuses a body of bad messages after reading only the messages the budget allows (the measured GHSA-mrhx-c7xc-m3w5 case)', () => {
    const op = operation('anthropic', 'messages.create');
    // 43,000 `{}` messages fit the cap. Each raises four issues: a missing role, and a missing
    // content that fails both union options and then the union.
    const attack = trackedObjects(43_000);
    let refusal: unknown;
    try { checkBody(op, { kind: 'json', value: { model: 'm', max_tokens: 1, messages: attack.items } }); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(EgressRefusal);
    expect((refusal as EgressRefusal).code).toBe('request_schema_refused');
    expect(attack.touched.size).toBe(JSON_BODY_ISSUE_BUDGET / 4 + 1);
    // Control: unbounded, zod reads every message.
    const control = trackedObjects(1000);
    expect(schemaOf(op).safeParse({ model: 'm', max_tokens: 1, messages: control.items }).success).toBe(false);
    expect(control.touched.size).toBe(1000);
  });

  it('pins every union and .catch in the connector bodies, so a new one fails here until JSON_BODY_ISSUE_BUDGET is redone', () => {
    const sites: string[] = [];
    for (const [connector, template] of Object.entries(CONNECTORS)) {
      for (const op of template.operations ?? []) {
        if (op.body?.kind !== 'json') continue;
        for (const node of zodNodes(schemaOf(op))) {
          if (node.typeName === 'ZodCatch') sites.push(`${connector} ${op.id} ${node.path} catch`);
          if (node.typeName === 'ZodUnion') {
            sites.push(`${connector} ${op.id} ${node.path} ${(node.schema._def as { options: unknown[] }).options.length} options`);
          }
        }
      }
    }
    expect(sites.sort()).toEqual([
      'anthropic messages.countTokens messages[].content 2 options',
      'anthropic messages.countTokens system 2 options',
      'anthropic messages.countTokens thinking 2 options',
      'anthropic messages.countTokens tool_choice 4 options',
      'anthropic messages.create messages[].content 2 options',
      'anthropic messages.create system 2 options',
      'anthropic messages.create thinking 2 options',
      'anthropic messages.create tool_choice 4 options',
      'openai chat.completions.create messages[].content 2 options',
      'openai chat.completions.create response_format 3 options',
      'openai chat.completions.create stop 2 options',
      'openai chat.completions.create tool_choice 2 options',
      'openai embeddings.create input 4 options',
      'openai responses.create input 2 options',
      'openai responses.create text.format 3 options',
      'openai responses.create tool_choice 2 options',
    ]);
  });
});
