/**
 * The connector protocol has two byte-identical copies (coordinator ruling,
 * B1b, 2026-10-30): the canonical one here, which tm8-server imports, and the
 * mirror the WhatsApp runtime builds from inside its own Docker context. This
 * test is what keeps them one module.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, WHATSAPP_CAPABILITIES } from '../src/index.js';

const canonical = fileURLToPath(new URL('../src/bridge-runtime-protocol.ts', import.meta.url));
const mirror = fileURLToPath(new URL('../../../integrations/whatsapp-bridge/src/runtime/protocol.ts', import.meta.url));

describe('bridge runtime protocol (D35)', () => {
  it('the runtime mirror is byte-identical to the canonical module', () => {
    expect(readFileSync(mirror, 'utf8')).toBe(readFileSync(canonical, 'utf8'));
  });

  it('is exported from @tm8/contract', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(WHATSAPP_CAPABILITIES.reactions).toBe(true);
  });
});
