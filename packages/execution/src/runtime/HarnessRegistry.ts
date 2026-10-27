import type { HarnessAdapter, HarnessCapabilities, HarnessKind, HarnessTarget, RuntimeFailure } from './harness-types.js';

export class HarnessRuntimeError extends Error {
  constructor(readonly failure: RuntimeFailure) {
    super(failure.safeMessage);
    this.name = 'HarnessRuntimeError';
  }
}

export function harnessFailure(
  code: RuntimeFailure['code'], stage: RuntimeFailure['stage'], safeMessage: string,
  disposition: RuntimeFailure['disposition'] = 'blocked',
): HarnessRuntimeError {
  return new HarnessRuntimeError({ code, stage, safeMessage, disposition, providerCode: null });
}

type RequiredCapability = 'nativeResume' | 'portableBootstrap' | 'cancelActiveTurn'
  | 'usage' | 'contextReading' | 'interactiveRequests' | 'imageInputs' | 'fileInputs'
  | 'builtInToolRestriction';

/** Catalog resolution belongs to the server. This registry never guesses from model IDs. */
export class HarnessRegistry {
  private readonly adapters = new Map<HarnessKind, HarnessAdapter>();

  constructor(adapters: readonly HarnessAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: HarnessAdapter): void {
    if (this.adapters.has(adapter.kind)) throw harnessFailure('invalid_config', 'prepare', `Duplicate ${adapter.kind} harness`);
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: HarnessKind): HarnessAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw harnessFailure('unsupported_capability', 'prepare', `Harness ${kind} is unavailable`);
    return adapter;
  }

  async admit(target: HarnessTarget, required: readonly RequiredCapability[] = []): Promise<HarnessCapabilities> {
    if (!target.model.trim() || !target.provider.trim()) throw harnessFailure('invalid_config', 'prepare', 'A resolved model and provider are required');
    const caps = await this.get(target.harness).capabilities();
    if (caps.harness !== target.harness || caps.textInputs !== 'supported') {
      throw harnessFailure('unsupported_capability', 'prepare', 'Harness text-input capability is unavailable');
    }
    for (const name of required) {
      if (caps[name] !== 'supported') throw harnessFailure('unsupported_capability', 'prepare', `Harness capability ${name} is ${caps[name]}`);
    }
    for (const name of ['reasoningEffort', 'serviceTier'] as const) {
      if (target[name] !== null && ['unsupported', 'unknown'].includes(caps.configuration[name])) {
        throw harnessFailure('unsupported_capability', 'prepare', `Harness configuration ${name} is unavailable`);
      }
    }
    return caps;
  }
}
