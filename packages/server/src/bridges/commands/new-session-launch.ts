import {
  CLAUDE_CODE_EFFORTS, CollabError, LAUNCH_MODEL_CATALOG, launchModel,
  type LaunchModelEffort,
} from '@tm8/contract';
import { DEFAULT_MODEL, resolveModelConfig } from '@tm8/execution';
import type { NewSessionOptions } from './parse.js';

export interface NewSessionLaunch {
  model: string;
  agentTool: string;
  provider: string | null;
  effort: LaunchModelEffort | null;
}

/** Read-only preflight. Never use the WhatsApp transport as a model provider. */
export function resolveNewSessionLaunch(
  options: Omit<NewSessionOptions, 'teammate'>,
  teammate: { model: string | null; agentTool: string | null },
): NewSessionLaunch {
  const refuse = (message: string): never => { throw new CollabError('invalid_input', message); };
  const defaults = resolveModelConfig({}, teammate);
  const nativeDefaultProvider = defaults.model === DEFAULT_MODEL && defaults.agentTool === 'claude-code' ? 'anthropic' : null;
  const provider = options.provider?.toLowerCase();
  if (provider && !LAUNCH_MODEL_CATALOG.some(row => row.provider === provider)) {
    refuse(`unsupported provider: ${options.provider}; use ${[...new Set(LAUNCH_MODEL_CATALOG.map(row => row.provider))].join(', ')}`);
  }
  let selected = options.model ? launchModel(options.model) : launchModel(defaults.model);
  if (options.model && !selected) refuse(`unsupported model: ${options.model}; choose a launch catalog model in tm8`);
  if (provider && options.model && selected?.provider !== provider) {
    refuse(`model ${options.model} belongs to ${selected!.provider}, not ${provider}`);
  }
  // Provider-only keeps a matching default; otherwise the catalog's first model
  // for that vendor is its offered default. No second model table lives here.
  if (provider && (selected?.provider ?? nativeDefaultProvider) !== provider) selected = LAUNCH_MODEL_CATALOG.find(row => row.provider === provider);
  const model = selected?.model ?? defaults.model;
  const agentTool = selected?.agentTool ?? defaults.agentTool;
  const effort = options.effort?.toLowerCase() as LaunchModelEffort | undefined;
  // The execution fallback is the native Claude `sonnet` alias. Its effort
  // vocabulary is authoritative too; custom defaults need a catalog model to
  // validate an explicit effort rather than guessing what the endpoint accepts.
  const efforts = selected?.efforts ?? (nativeDefaultProvider ? CLAUDE_CODE_EFFORTS : []);
  if (effort && !efforts.includes(effort)) {
    refuse(`${model} ${efforts.length ? `accepts effort: ${efforts.join(', ')}` : 'has no supported tunable effort; omit effort or choose a catalog model'}`);
  }
  return { model, agentTool, provider: selected?.provider ?? nativeDefaultProvider, effort: effort ?? null };
}
