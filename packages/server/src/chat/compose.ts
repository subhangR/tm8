// TM8 Chat composition root — the commit neither lane owned.
//
// Lane 2 (orchestrator) consumes an injected AgentRuntime and a
// ResolveChatLaunchConfig; lane 1 (execution) ships ClaudeHeadlessAdapter;
// lane 3 (mcp) ships the stdio tool server and the agent_runtime mint. Each
// close-out correctly listed "production wiring" as NOT PROVEN, because the
// wiring is a property of the composed tree, not of any lane. This module is
// that wiring: main() passes `composeChatBootstrap` as the chat factory, and
// test harnesses keep injecting fakes exactly as before.

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CollabError } from '@tm8/contract';
import {
  ClaudeHeadlessAdapter,
  type AgentRuntime as ExecutionAgentRuntime,
} from '@tm8/execution';

import type { Db, DbClaims } from '../db/types.js';
import { issueAgentRuntimeSession } from '../identity/pg-auth.js';
import type {
  AgentRuntime,
  ChatLaunchConfig,
  ChatLaunchConfigInput,
  ResolveChatLaunchConfig,
  StartAgentThreadInput,
} from './runtime.js';

/** The closed v1 tool surface (D3/D9): the five hierarchical tm8 groups. */
export const TM8_CHAT_ALLOWED_TOOLS: readonly string[] = [
  'mcp__tm8__tm8_overview',
  'mcp__tm8__tm8_read',
  'mcp__tm8__tm8_act',
  'mcp__tm8__tm8_delegate',
  'mcp__tm8__tm8_messages',
];

function claims(identityId: string): DbClaims {
  return { identityId };
}

/**
 * The server chat port and the execution chat port were written by two lanes
 * against the same C1 contract and differ in exactly one declared spot: the
 * server states resume intent as `{ nativeSessionId, cwd }` (both values also
 * present top-level), the execution port as the literal `'post_interrupt'`.
 * This wrapper is that one translation — everything else passes through, and
 * tsc holds the two unions structurally identical.
 */
export function wrapExecutionAgentRuntime(runtime: ExecutionAgentRuntime): AgentRuntime {
  return {
    async startThread(input: StartAgentThreadInput) {
      const { resume, ...rest } = input;
      return runtime.startThread({
        ...rest,
        ...(resume ? { resume: 'post_interrupt' as const } : {}),
      });
    },
    sendTurn: (threadId, input) => runtime.sendTurn(threadId, input),
    interrupt: (threadId) => runtime.interrupt(threadId),
    close: (threadId) => runtime.close(threadId),
  };
}

export interface ChatLaunchComposition {
  readonly db: Db;
  /** Node state root; per-thread MCP configs land under `<dataDir>/chat/`. */
  readonly dataDir: string;
  /** Loopback origin of THIS node — the stdio MCP server calls back into it. */
  readonly baseUrl: string;
  /** Test override; defaults to the workspace-resolved @tm8/mcp cli. */
  readonly mcpCliPath?: string;
}

function defaultMcpCliPath(): string {
  // package.json `exports` exposes only ".", so resolve the package entry and
  // take its sibling: dist/index.js -> dist/cli.js (the tm8-mcp bin target).
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@tm8/mcp')), 'cli.js');
}

function systemPromptFor(input: ChatLaunchConfigInput): string {
  return [
    `You are a tm8 chat teammate (team member ${input.teammateId}) conversing with a human in message thread ${input.rootMessageId}.`,
    'You work ON the tm8 graph through the tm8_* tools and nothing else: read entities, act on them, delegate real work by spawning worker sessions, and send graph messages.',
    'Call tm8_overview first in a new conversation to learn the tool surface; group tools return the schemas of their sub-actions.',
    'You have no filesystem and no shell. If work needs one, delegate it to a worker session via tm8_delegate.',
    'Your plain text reply IS your chat message to the human — do not use a tool to reply. Keep replies concise.',
  ].join('\n');
}

/**
 * Production ResolveChatLaunchConfig: mint the thread's agent_runtime MCP
 * credential (C5) under the REQUESTING HUMAN's claims, write the per-thread
 * strict MCP config, and hand back the closed tool surface with the system
 * prompt. Called by the orchestrator on every cold or post-interrupt start,
 * which is what keeps the <=24h credential fresh across resumes.
 */
export function createChatLaunchConfigResolver(
  options: ChatLaunchComposition,
): ResolveChatLaunchConfig {
  const cliPath = options.mcpCliPath ?? defaultMcpCliPath();
  return async (input: ChatLaunchConfigInput): Promise<ChatLaunchConfig> => {
    if (input.agentTool !== 'claude-code') {
      // Honest v1 refusal (D12/DECISION §4): the codex adapter is Stage 2.
      throw new CollabError(
        'invalid_input',
        `chat v1 runs claude-code models only; '${input.model}' launches via ${input.agentTool}`,
      );
    }
    const minted = await issueAgentRuntimeSession(options.db, claims(input.requesterIdentityId), {
      threadRootId: input.rootMessageId,
      teamMemberId: input.teammateId,
    });
    const configDir = join(options.dataDir, 'chat');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const mcpConfigPath = join(configDir, `${input.rootMessageId}.mcp.json`);
    const config = {
      mcpServers: {
        tm8: {
          command: process.execPath,
          args: [cliPath],
          env: {
            TM8_BASE_URL: options.baseUrl,
            TM8_AGENT_RUNTIME_TOKEN: minted.token,
          },
        },
      },
    };
    // 0600 and rewritten whole on every start: the token inside rotates per
    // mint (atomic per-thread replacement in 105's SQL), so a stale file can
    // never hold the only live secret.
    await writeFile(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return {
      systemPrompt: systemPromptFor(input),
      mcpConfigPath,
      allowedTools: TM8_CHAT_ALLOWED_TOOLS,
    };
  };
}

export interface ChatBootstrapComposition {
  readonly runtime: AgentRuntime;
  readonly resolveLaunchConfig: ResolveChatLaunchConfig;
  readonly onError?: (error: unknown) => void;
}

/** The production chat block main() hands to bootstrap once a db exists. */
export function composeChatBootstrap(ctx: {
  db: Db;
  dataDir: string;
  baseUrl: string;
}): ChatBootstrapComposition {
  return {
    runtime: wrapExecutionAgentRuntime(new ClaudeHeadlessAdapter()),
    resolveLaunchConfig: createChatLaunchConfigResolver(ctx),
    onError: (error) => {
      // eslint-disable-next-line no-console
      console.error('[chat]', error instanceof Error ? error.message : String(error));
    },
  };
}
