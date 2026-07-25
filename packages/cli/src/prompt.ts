/**
 * Prompt composition — re-exported from `@tm8/prompt`.
 *
 * The composer MOVED to its own zero-dependency package because it is needed in
 * two places that must not depend on each other: the spawn path
 * (`@tm8/execution`, which embeds the prompt in the agent's command line so it
 * exists at the first token) and this CLI (`tm8 worker init`, so an agent can
 * re-read its own briefing). This CLI cannot import `@tm8/execution` — that
 * would drag `node-pty` into the agent's own binary — so neither owns it.
 *
 * This file stays as the CLI's import site so existing callers and tests keep
 * working; there is exactly ONE implementation, and it is not here.
 */
export {
  composePrompt,
  commandSurface,
  instructionFor,
  profileFor,
  AGENT_MODES,
  type AgentMode,
  type CommandDoc,
  type PromptEnvelope,
  type PromptRuntime,
  type PromptManifest,
} from '@tm8/prompt';
