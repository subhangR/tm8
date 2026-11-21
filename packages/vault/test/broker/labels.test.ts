import { afterEach, describe, expect, it } from 'vitest';
import { harness, validInput, type Harness } from './support.js';

// Review addendum 2, C6: the dispatcher parses every input against the contract schema before a handler
// runs (dispatcher.ts parseInput), so a name or username that would show people something other than
// what it holds is refused there. The harness sends JSON.stringify output, which spells a lone surrogate
// as an ASCII escape; the broker's JSON.parse turns it back into one. Every value here is synthetic.
// One harness per operation keeps the five requests inside every rate class (rate-limit.ts; the import
// class holds exactly five), and the safe request asserts it was not rate limited, so it cannot pass vacuously.

/** Text from code points, so this file holds no invisible character and no escape a tool could rewrite. */
const cp = (...points: number[]) => String.fromCodePoint(...points);

const opened: Harness[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((h) => h.close())); });

type Build = (label: string) => Record<string, unknown>;
const CASES: [string, Parameters<Harness['send']>[0], Build][] = [
  ['a capture link name', 'vault.captureLinks.create', (label) => ({ ...validInput('vault.captureLinks.create'), name: `Bank${label}x` })],
  ['an item name', 'vault.items.update', (label) => ({ ...validInput('vault.items.update'), name: `Item${label}x` })],
  ['an item username', 'vault.items.update', (label) => ({ ...validInput('vault.items.update'), username: `user${label}x` })],
  ['a passkey name', 'vault.passkeys.registerBegin', (label) => ({ ...validInput('vault.passkeys.registerBegin'), name: `Key${label}x` })],
  ['an import row name', 'vault.imports.commit', (label) => ({ ...validInput('vault.imports.commit'),
    rows: [{ index: 0, include: true, exposureTier: 'a', name: `Row${label}x` }] })],
];

describe('the broker refuses display-unsafe labels before any handler runs (review addendum 2, C6)', () => {
  it.each(CASES)('refuses %s holding an override, a C1 control, a tag character or a lone surrogate', async (_label, op, build) => {
    const h = await harness();
    opened.push(h);
    for (const unsafe of [cp(0x202e), cp(0x85), cp(0xe0067, 0xe006f), String.fromCharCode(0xd800)]) {
      const response = await h.send(op, { input: build(unsafe) });
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe('invalid_input');
      // The refusal never says which field or character it was, so it cannot echo the label.
      expect(response.json.error.details).toBeUndefined();
    }
    // The same input with a safe non-Latin label passes the input check; whatever the handler answers
    // next is not an input refusal, and not a rate-limit refusal that would hide one.
    const safe = await h.send(op, { input: build(` ${cp(0xc24, 0xc46, 0xc32, 0xc41, 0xc17, 0xc41)} ${cp(0x200e)}`) });
    expect(safe.status).not.toBe(429);
    expect(safe.json?.error?.code).not.toBe('invalid_input');
  });

  it('refuses an item username holding a TAB, which the item update cannot trim away', async () => {
    const h = await harness();
    opened.push(h);
    const response = await h.send('vault.items.update', { input: { ...validInput('vault.items.update'), username: `user${cp(0x9)}` } });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('invalid_input');
  });
});
