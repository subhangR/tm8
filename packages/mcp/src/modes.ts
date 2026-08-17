import type { ChatMode } from '@tm8/contract';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'];

export const DIRECT_TOOL_NAMES = [
  'repo_read_file', 'repo_glob', 'repo_grep',
  'repo_write', 'repo_edit', 'repo_multi_edit', 'repo_bash',
  'session_transcript', 'session_tail', 'session_followup', 'session_stop',
  'explain_diagram', 'explain_graph', 'explain_code', 'explain_asset',
  'doc_create', 'doc_update', 'artifact_create',
  'web_fetch', 'web_search',
  'memory_write', 'memory_search',
  'git_branch', 'git_status', 'git_diff', 'git_pr',
] as const;

export type DirectToolName = (typeof DIRECT_TOOL_NAMES)[number];

const EXPLAIN_OUTPUTS = new Set<string>([
  'explain_diagram', 'explain_graph', 'explain_code', 'explain_asset',
]);

/**
 * Central mode policy.
 *
 * A chat mode states INTENT, not permission. Every mode carries the full tool
 * surface — repository reads and edits, web, the whole tm8 graph including
 * mutation and delegation, docs, artifacts, memory and git — so no mode is
 * crippled by its own label. What separates the modes is the system prompt
 * (`chatSystemPrompt`), which says how to work, not what may be touched.
 *
 * Exactly two exceptions survive, and both are stated rather than implied:
 *
 * - `repo_bash` stays Build's alone and answers `ask`, which `exposedToolNames`
 *   drops. A headless provider cannot settle an approval prompt, so shell work
 *   is delegated to a worker session rather than silently pre-approved.
 * - The `explain_*` inline presentation tools are Explain's extra surface.
 *   They are a rendering contract with the Explain transcript, not a
 *   capability: every other mode expresses the same content durably through
 *   doc_create/doc_update (fenced Mermaid) and artifact_create, which every
 *   mode now has.
 *
 * The `operation` argument is still accepted because the router narrows
 * hierarchical tools through this one entry point; no mode narrows an
 * operation any more.
 */
export function toolPermission(mode: ChatMode, tool: string, _operation?: string): ToolPermission {
  if (tool === 'repo_bash') return mode === 'build' ? 'ask' : 'deny';
  if (EXPLAIN_OUTPUTS.has(tool)) return mode === 'explain' ? 'allow' : 'deny';
  return 'allow';
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
