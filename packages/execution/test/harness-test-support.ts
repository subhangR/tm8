import type {
  HarnessObservation,
  HarnessSession,
  LaunchMaterial,
  OpenHarnessInput,
  PreparedLaunch,
  RuntimeConfig,
  TurnCommand,
} from '../src/runtime/index.js';
export function config(
  harness: 'claude' | 'codex',
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    schemaVersion: 1,
    revision: 1,
    target: {
      harness,
      provider: harness === 'codex' ? 'openai' : 'anthropic',
      model: 'test-model',
      reasoningEffort: 'high',
      serviceTier: null,
    },
    instructionHash: 'instructions',
    toolPolicyHash: 'tools',
    mcpBindingRevision: 'mcp1',
    cwdIdentity: 'cwd1',
    credentialBindingId: 'credential1',
    credentialRevision: 'cred1',
    launchFingerprint: 'launch1',
    ...overrides,
  };
}
export function launch(material: LaunchMaterial, onRelease: () => void = () => {}): PreparedLaunch {
  return {
    kind: 'ephemeral-launch',
    launchId: 'launch1',
    storageScopeId: 'material1',
    nativeStorageScopeId: 'history1',
    nativeStorageGeneration: 1,
    owner: { chatId: 'chat1', generation: 1, ownerLeaseId: 'owner1', claimFence: 'claim1' },
    modelCredentialLeaseId: 'lease1',
    runtimeGrantId: 'grant1',
    capabilityPlanId: 'caps1',
    materialize: async () => material,
    release: async () => {
      onRelease();
    },
  };
}
export function input(material: LaunchMaterial, onRelease?: () => void): OpenHarnessInput {
  return {
    fence: {
      chatId: 'chat1',
      bindingId: 'binding1',
      generation: 1,
      leaseEpoch: 1,
      configRevision: 1,
    },
    config: config(material.harness),
    mode: { kind: 'create' },
    launch: launch(material, onRelease),
  };
}
export function command(runtimeConfig: RuntimeConfig, text = 'normal', n = 1): TurnCommand {
  return {
    attempt: {
      turnId: 'user-' + n,
      attemptId: 'attempt-' + n,
      configRevision: runtimeConfig.revision,
    },
    clientSubmissionId: 'submission-' + n,
    text,
    attachmentRefs: [],
    config: runtimeConfig,
  };
}
export class Recorder {
  readonly events: HarnessObservation[] = [];
  private wake: (() => void) | null = null;
  readonly finished: Promise<void>;
  constructor(session: HarnessSession) {
    this.finished = (async () => {
      for await (const event of session.observations) {
        this.events.push(event);
        this.wake?.();
      }
    })();
  }
  async until(predicate: (events: HarnessObservation[]) => boolean): Promise<void> {
    const end = Date.now() + 5000;
    while (!predicate(this.events)) {
      if (Date.now() > end) throw new Error('Timed out waiting for harness evidence');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
  terminal(n = 1): Promise<void> {
    return this.until((events) => events.filter((e) => e.payload.kind === 'terminal').length >= n);
  }
}
