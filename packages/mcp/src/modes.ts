import type { ChatMode } from '@tm8/contract';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'];

export const DIRECT_TOOL_NAMES = [
  'repo_read_file', 'repo_glob', 'repo_grep',
  'repo_write', 'repo_edit', 'repo_multi_edit',
  'session_transcript', 'session_tail', 'session_followup', 'session_stop',
  'explain_diagram', 'explain_graph', 'explain_code', 'explain_asset',
  'doc_create', 'doc_update', 'artifact_create',
  'web_fetch', 'web_search',
  'memory_write', 'memory_search',
  'git_branch', 'git_status', 'git_diff', 'git_pr',
] as const;

export type DirectToolName = (typeof DIRECT_TOOL_NAMES)[number];

/**
 * Central mode policy — now fully unified.
 *
 * A chat mode states INTENT, not permission. Every mode carries the SAME full
 * tool surface — repository reads/edits, web, the whole tm8 graph including
 * mutation and delegation, docs, artifacts, memory, git, and the `explain_*`
 * inline presentation tools — so no mode is crippled by its own label. What
 * separates the modes is the system prompt (`chatSystemPrompt`), which says how
 * to work, not what may be touched.
 *
 * The last two carve-outs are gone:
 *
 * - `repo_bash` (Build-only, and it failed closed even there because a headless
 *   provider cannot settle an approval) is removed entirely; Claude's native
 *   Bash covers shell work under the runtime's own permission posture.
 * - The `explain_*` presentation tools were Explain's alone; they are now
 *   allowed in every mode, so Plan can draw an inline diagram just as Explain
 *   can. They remain a rendering contract, not a new capability — every mode
 *   already had the durable equivalents (doc_create/doc_update, artifact_create).
 *
 * The `operation` argument is retained for interface stability (the router still
 * calls through this one entry point) but no mode narrows anything any more, so
 * every tool in every mode resolves to `allow`.
 */
export function toolPermission(_mode: ChatMode, _tool: string, _operation?: string): ToolPermission {
  return 'allow';
}

export function exposedToolNames(mode: ChatMode, names: readonly string[]): string[] {
  // Retained for call-site stability. With the gate collapsed to `allow`, this
  // is the identity filter — every named tool is exposed in every mode.
  return names.filter((name) => toolPermission(mode, name) === 'allow');
}

export function parseChatMode(raw: string | undefined): ChatMode {
  const mode = raw?.trim().toLowerCase();
  return CHAT_MODES.includes(mode as ChatMode) ? mode as ChatMode : 'ask';
}
