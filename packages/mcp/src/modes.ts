import type { ChatMode } from '@tm8/contract';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'plan', 'build', 'orchestrate'];

export const DIRECT_TOOL_NAMES = [
  'repo_read_file', 'repo_glob', 'repo_grep',
  'repo_write', 'repo_edit', 'repo_multi_edit', 'repo_bash',
  'session_transcript', 'session_tail', 'session_followup', 'session_stop',
  'doc_create', 'doc_update', 'artifact_create',
  'web_fetch', 'web_search',
  'memory_write', 'memory_search',
  'git_branch', 'git_status', 'git_diff', 'git_pr',
] as const;

export type DirectToolName = (typeof DIRECT_TOOL_NAMES)[number];

const READ_TOOLS = new Set<string>([
  'tm8_overview', 'tm8_read', 'repo_read_file', 'repo_glob', 'repo_grep',
  'session_transcript', 'session_tail', 'web_fetch', 'web_search',
  'memory_search', 'git_branch', 'git_status', 'git_diff', 'git_pr',
]);

const PLAN_WRITES = new Set<string>(['doc_create', 'doc_update', 'artifact_create']);
const BUILD_ONLY = new Set<string>([
  'repo_write', 'repo_edit', 'repo_multi_edit', 'memory_write',
]);
const ORCHESTRATION = new Set<string>([
  'tm8_delegate', 'session_followup', 'session_stop',
]);

/**
 * Central mode policy. Operation-level checks below narrow hierarchical tools;
 * this top-level answer is still useful for provider registration minimization.
 */
export function toolPermission(mode: ChatMode, tool: string, operation?: string): ToolPermission {
  if (tool === 'repo_bash') return mode === 'build' ? 'ask' : 'deny';
  if (mode === 'build') return 'allow';

  if (tool === 'tm8_messages') {
    if (!operation) return 'allow';
    if (operation === 'messages.list' || operation === 'messages.delivery.get') return 'allow';
    return mode === 'orchestrate' ? 'allow' : 'deny';
  }
  if (tool === 'tm8_act') {
    if (mode !== 'orchestrate') return 'deny';
    if (!operation) return 'allow';
    return operation.startsWith('entities.commands.') ? 'allow' : 'deny';
  }
  if (tool === 'tm8_delegate') return mode === 'orchestrate' ? 'allow' : 'deny';

  if (mode === 'orchestrate') {
    if (ORCHESTRATION.has(tool)) return 'allow';
    if (tool.startsWith('git_') || tool === 'session_transcript' || tool === 'session_tail') return 'allow';
    return tool === 'tm8_overview' || tool === 'tm8_read' || tool === 'memory_search' ? 'allow' : 'deny';
  }

  if (READ_TOOLS.has(tool)) return 'allow';
  if (mode === 'plan' && PLAN_WRITES.has(tool)) return 'allow';
  if (PLAN_WRITES.has(tool) || BUILD_ONLY.has(tool) || ORCHESTRATION.has(tool)) return 'deny';
  return 'deny';
}

export function exposedToolNames(mode: ChatMode, names: readonly string[]): string[] {
  // Provider processes are headless, so an `ask` decision cannot be safely
  // settled interactively. Keep those tools out of the provider allow-list;
  // the router also fails closed if one is invoked out of band.
  return names.filter((name) => toolPermission(mode, name) === 'allow');
}

export function parseChatMode(raw: string | undefined): ChatMode {
  const mode = raw?.trim().toLowerCase();
  return CHAT_MODES.includes(mode as ChatMode) ? mode as ChatMode : 'ask';
}
