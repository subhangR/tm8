/**
 * The connector protocol has two byte-identical copies (coordinator ruling,
 * B1b, 2026-10-30): the canonical one here, which tm8-server imports, and the
 * mirror the WhatsApp runtime builds from inside its own Docker context. This
 * test is what keeps them one module.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, SLACK_CAPABILITIES, WHATSAPP_CAPABILITIES } from '../src/index.js';

const canonical = fileURLToPath(new URL('../src/bridge-runtime-protocol.ts', import.meta.url));
const integrations = fileURLToPath(new URL('../../../integrations/', import.meta.url));
/** Every connector runtime's mirror: integrations/<name>-bridge/src/runtime/protocol.ts. */
const mirrors = readdirSync(integrations).filter((d) => d.endsWith('-bridge'))
  .map((d) => `${integrations}${d}/src/runtime/protocol.ts`).filter((p) => existsSync(p));

describe('bridge runtime protocol (D35)', () => {
  it('finds the WhatsApp mirror at least', () => {
    expect(mirrors.some((p) => p.includes('whatsapp-bridge'))).toBe(true);
  });

  it.each(mirrors)('the runtime mirror %s is byte-identical to the canonical module', (mirror) => {
    expect(readFileSync(mirror, 'utf8')).toBe(readFileSync(canonical, 'utf8'));
  });

  it('is exported from @tm8/contract', () => {
    expect(PROTOCOL_VERSION).toBe(4);
    expect(SLACK_CAPABILITIES.threads).toBe('native');
    expect(WHATSAPP_CAPABILITIES.reactions).toBe(true);
  });
});
