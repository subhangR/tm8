import type { ModelSuggestion } from '@tm8/contract';

import { canLaunch } from '../domain/launch';
import type { CatalogModel } from '../domain/model-catalog';

/** Providers Jev never suggests (owner ruling): their rows belong to the Kimi/Groq credentials. */
const NEVER_SUGGESTED = new Set(['moonshot', 'groq']);

/**
 * Why Apply must refuse this model suggestion on this surface, or null.
 *
 * Apply sets model, tool and effort TOGETHER, so every one of the three has to
 * be launchable here: the model must be in this node's catalog, run on the tool
 * Jev named, take the effort Jev named, and pass `canLaunch` for that tool and
 * model. The `canLaunch` call is isolated to the model question — a scratch
 * target and no capacity — so an unrelated refusal (an untrusted project, a
 * full node) never masquerades as "you can't run this model".
 *
 * `credentialRefusal` lets a surface that knows the viewer's credentials refuse
 * a tool whose provider it has been told to use and cannot.
 */
export function modelApplyRefusal(
  suggestion: ModelSuggestion,
  opts: { catalog: readonly CatalogModel[]; credentialRefusal?: (agentTool: string) => string | null },
): string | null {
  const entry = opts.catalog.find((row) => row.model === suggestion.model);
  if (entry && NEVER_SUGGESTED.has(entry.provider)) {
    return 'Jev never suggests Kimi or Groq models, so this suggestion is not offered.';
  }
  if (!entry) return `“${suggestion.model}” isn’t in this node’s model catalog, so it can’t be launched here.`;
  if (entry.agentTool !== suggestion.agentTool) {
    return `This node runs ${entry.label} on ${entry.agentTool}, not ${suggestion.agentTool}.`;
  }
  if (entry.efforts && !entry.efforts.includes(suggestion.effort)) {
    return `${entry.label} takes no “${suggestion.effort}” reasoning effort.`;
  }
  const verdict = canLaunch({
    teamMemberId: 'jev-model-check',
    agentToolId: suggestion.agentTool,
    model: suggestion.model,
    reasoningEffort: null,
    accessMode: null,
    mode: 'worker',
    target: { kind: 'scratch' },
  }, { projects: [] });
  if (!verdict.ok) return verdict.reason;
  return opts.credentialRefusal?.(suggestion.agentTool) ?? null;
}

/** The catalog's words for a suggested model, or its id when the catalog lacks it. */
export function modelLabel(suggestion: ModelSuggestion, catalog: readonly CatalogModel[]): string {
  return catalog.find((row) => row.model === suggestion.model)?.label ?? suggestion.model;
}
