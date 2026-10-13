import type { ChatMode } from '@tm8/contract';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'];

export const DIRECT_TOOL_NAMES = [
  'repo_read_file', 'repo_glob', 'repo_grep',
  'repo_write', 'repo_edit', 'repo_multi_edit',
  'session_transcript', 'session_tail', 'session_followup', 'session_stop',
  'explain_diagram', 'explain_graph', 'explain_code', 'explain_asset',
  // form_create (FORMS-DESIGN §9) is direct so the question list is a TYPED
  // schema the model fills in, checked against the contract registry before
  // any call, rather than a free-form `tm8_act` body it learns by rejection.
  'form_create', 'doc_create', 'doc_update', 'artifact_create',
  'web_fetch', 'web_search',
  'memory_write', 'memory_search',
  'git_branch', 'git_status', 'git_diff', 'git_pr',
  // Containers (TM8-CONTAINERS-DESIGN §14.1). DIRECT rather than `tm8_act`
  // guides because agents call these in tight loops and need TYPED results —
  // a screenshot as an image block, an exit code as a number — not a template
  // to fill in. Every other containers.* operation stays a guide row.
  'container_computer', 'container_run', 'container_screenshot',
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
 *
 * ---
 *
 * THIS `allow` IS WHAT LETS A MID-CHAT MODE SWITCH KEEP THE RUNNING CHILD. The
 * composer changes a chat's mode per turn: the pick rides one turn as
 * `messages.requested_chat_mode` (153) -> `chat_turns.mode` (154) and reaches the
 * agent as that turn's `[mode: x]` envelope line. The child is not restarted for
 * it — `ensureRuntime` leaves the mode off its reuse rule on purpose, because a
 * mode picked per turn would otherwise cost a restart per turn. That is correct
 * only while nothing the child was LAUNCHED with depends on the mode, and the
 * mode does have spawn-time consumers:
 *
 *   - `TM8_CHAT_MODE` (compose.ts), stamped into the MCP server's env and parsed
 *     back by `parseChatMode` (env.ts) — so the router's mode is forever the mode
 *     the chat launched in. It feeds only this function now; `tm8_overview` used
 *     to echo it as `mode`, and so contradicted the envelope after every switch.
 *   - the provider's `--allowedTools`, computed once, at spawn, from
 *     `exposedToolNames(launchMode, …)` in `chatProviderToolPolicy`.
 *
 * Both reduce to the identity while this function returns `allow`
 * unconditionally. NARROW A MODE HERE AND THAT STOPS: the envelope would tell
 * the agent to `build` while the child still held `ask`'s surface — with no
 * error anywhere. The server's orchestrator.test.ts ("the spawn surface is
 * mode-independent") fails the day that happens. Making it pass again is a
 * choice between three designs, and a test edit is not one of them: restart the
 * child on a mode change (the model's path, `ensureRuntime` close + resume),
 * refuse a narrowing switch where the composer can show why, or keep the spawn
 * surface the union and enforce the narrowing per call against the running
 * turn's mode — which only the server knows, not this process.
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
