/**
 * The chat runtime's environment → the router's options.
 *
 * ITS OWN MODULE, AND THAT IS THE POINT. This mapping used to be an inline
 * object literal in `cli.ts`, whose module body starts a stdio server the
 * moment it is imported — so there was no way to exercise the mapping without
 * launching a server, and therefore no test on it at all.
 *
 * A negative control proved that mattered rather than merely looking untidy:
 * disabling the `TM8_CHAT_ID` read left every test in this package green.
 * `compose.test.ts` asserts the server WRITES that variable into each per-chat
 * MCP config; `tools.test.ts` asserts the router USES a chatId it is handed.
 * Nothing joined the two, so the wire between them could be cut silently.
 *
 * Every value is TRIMMED, and an empty result is treated as UNSET rather than
 * as an empty value. A config written with a blank variable must produce a
 * router that says nothing about its chat, not one that claims to run chat "".
 */
import type { Tm8ToolRouterOptions } from './tools.js';
import { parseChatMode } from './modes.js';

export function routerOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Tm8ToolRouterOptions {
  const trimmed = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const projectRoot = trimmed('TM8_CHAT_PROJECT_ROOT');
  const spaceId = trimmed('TM8_CHAT_SPACE_ID');
  // 176: the chat this server runs inside. Written into every per-chat MCP
  // config by the launch-config resolver since Wave 1; reading it is what makes
  // it reach the tool surface, and until it did, the variable was set and
  // consumed by nothing.
  const chatId = trimmed('TM8_CHAT_ID');
  const hidden = trimmed('TM8_CHAT_HIDDEN_TOOLS');
  return {
    mode: parseChatMode(env.TM8_CHAT_MODE),
    ...(projectRoot ? { projectRoot } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(hidden
      ? { hiddenTools: hidden.split(',').map((name) => name.trim()).filter(Boolean) }
      : {}),
  };
}
