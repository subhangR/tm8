/**
 * The chat runtime's environment reaches the tool surface.
 *
 * This file exists because a negative control found a hole: disabling the
 * `TM8_CHAT_ID` read in `cli.ts` left every other test in the package green.
 * `compose.test.ts` asserts the server WRITES the variable into each per-chat
 * MCP config and `tools.test.ts` asserts the router USES a chatId it is handed
 * — but nothing joined the two, so the wire between them could be cut without a
 * single assertion noticing. These are that wire.
 */
import { describe, expect, it } from 'vitest';
import { routerOptionsFromEnv } from '../src/env.js';
import { Tm8ToolRouter } from '../src/tools.js';
import type { CatalogInvokeOptions, CatalogTransport } from '../src/catalog-client.js';

const CHAT = '019fa297-64e3-7000-8000-0000000000d1';
const SPACE = '019fa297-64e3-7000-8000-0000000000d2';

class NullTransport implements CatalogTransport {
  async invoke(_operation: never, _options?: CatalogInvokeOptions): Promise<unknown> {
    throw new Error('the overview makes no server call');
  }
}

describe('routerOptionsFromEnv', () => {
  it('carries the chat, space, root and mode the runtime wrote', () => {
    expect(routerOptionsFromEnv({
      TM8_CHAT_ID: CHAT,
      TM8_CHAT_SPACE_ID: SPACE,
      TM8_CHAT_PROJECT_ROOT: '/srv/chat',
      TM8_CHAT_MODE: 'build',
      TM8_CHAT_HIDDEN_TOOLS: 'repo_read_file, repo_glob ,',
    })).toEqual({
      mode: 'build',
      projectRoot: '/srv/chat',
      spaceId: SPACE,
      chatId: CHAT,
      hiddenTools: ['repo_read_file', 'repo_glob'],
    });
  });

  it('omits what is unset rather than carrying an empty value', () => {
    // An older per-chat config has no TM8_CHAT_ID at all. The key must be
    // ABSENT, not present-and-empty: `exactOptionalPropertyTypes` aside, a
    // router handed `chatId: ''` would have to decide what an empty id means,
    // and every answer to that is worse than not being told.
    expect(routerOptionsFromEnv({})).toEqual({ mode: 'ask' });
    expect(routerOptionsFromEnv({ TM8_CHAT_ID: '   ' })).toEqual({ mode: 'ask' });
    expect(routerOptionsFromEnv({ TM8_CHAT_ID: '' })).toEqual({ mode: 'ask' });
    // An unknown mode falls back to the safe default rather than throwing on
    // startup — a chat with a typo'd mode must still run.
    expect(routerOptionsFromEnv({ TM8_CHAT_MODE: 'nonsense' }).mode).toBe('ask');
  });

  it('reaches tm8_overview, which is the only place a model can read it', async () => {
    // THE WHOLE WIRE, end to end: the variable the server writes, through the
    // mapping this module owns, into the answer a tool call returns.
    const router = new Tm8ToolRouter(new NullTransport(), routerOptionsFromEnv({
      TM8_CHAT_ID: CHAT, TM8_CHAT_MODE: 'orchestrate',
    }));
    const overview = await router.call('tm8_overview', {});
    expect((overview.structuredContent.chat as { id: string }).id).toBe(CHAT);
    expect(overview.structuredContent.mode).toBe('orchestrate');
  });
});
