import type { GuideSection } from './form-guide.js';

/**
 * Working safely across the human's workspaces (API doc 01a115c4 §8.5, Q4,
 * F3). The rules an agent needs before its first command, not per verb.
 */
export function workspaceGuide(): GuideSection[] {
  return [
    { title: 'Which workspace', lines: [
      'Commands apply to the human’s active workspace unless they name a tab or draft (its owner) or you pass --workspace <id|name>.',
      'Use --workspace only when the human asked for a workspace other than the current one. It never switches; activating a tab there answers not_active.',
      'For a multi-step job, take workspace.id from the first result and pass --expect-workspace <id> on every later command.',
      'On workspace_switched or workspace_mismatch (exit 6) nothing was applied: stop and ask the human whether to continue in the new workspace.',
      '--expect-revision is only meaningful together with --expect-workspace: revisions are per workspace.',
      'tabs close-visible with no --expect-workspace and two or more workspaces answers workspace_pin_required (exit 6).',
    ] },
    { title: 'Asking the human', lines: [
      'tm8 workspace use <ws> from an agent only asks: it exits 16 with a prompt id, and the human chooses Switch or Stay. tm8 workspace list shows the prompt’s outcome.',
      'tm8 workspace delete <ws> from an agent applies only to a workspace it created that is not active and has no unsaved drafts; otherwise it asks the same way.',
      'A newer switch prompt supersedes an older one. If your prompt disappears from tm8 workspace list, treat it as not accepted and ask again.',
      'tm8 workspace prompts resolve <prompt-id> accept|decline [--discard] is the human’s answer; an agent gets human_only (exit 4), and an agent’s --discard is ignored.',
    ] },
  ];
}
