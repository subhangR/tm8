// @tm8/execution — the per-node provider registry (§10.1).
//
// Built at boot from config, then PROBED BY DOING. `descriptor.probe` is the
// answer to "does this actually work HERE", and it is produced by creating and
// destroying a real container, never by checking for a binary on PATH — the
// sandbox-probe lesson, kept. A PATH check calls a broken Docker Desktop
// healthy, and the first user request is where you find out.
//
// Selection (§12.1) is the other half of the honest 501: when no enabled
// provider can serve a profile at an acceptable isolation class, the answer is
// `no_provider` (501), and the message says WHICH constraint failed. A caller
// who asked for a browser on a node with only `fake` deserves "no provider on
// this node satisfies browser", not a 404 and not a crash.

import {
  CONTAINER_ISOLATION_RANK,
  type ContainerIsolationClass,
  type ContainerProfile,
  type ContainerProviderDescriptor,
} from '@tm8/contract';

import { ContainerError } from './errors.js';
import type { ContainerProvider } from './provider.js';

export interface ProviderSelection {
  provider: ContainerProvider;
  descriptor: ContainerProviderDescriptor;
}

export class ProviderRegistry {
  /** Insertion order IS preference order — `TM8_CONTAINER_PROVIDERS` is a
   *  comma list "in preference order" and this preserves it. */
  private readonly providers = new Map<string, ContainerProvider>();

  constructor(providers: readonly ContainerProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ContainerProvider): void {
    this.providers.set(provider.descriptor.id, provider);
  }

  get(id: string): ContainerProvider | undefined {
    return this.providers.get(id);
  }

  list(): ContainerProvider[] {
    return [...this.providers.values()];
  }

  descriptors(): ContainerProviderDescriptor[] {
    return this.list().map((p) => p.descriptor);
  }

  /**
   * Pick a provider for a profile, honouring an explicit request and the
   * isolation floor.
   *
   * Every refusal names the constraint that failed, because "no provider" with
   * no reason is the least actionable error a node can give: the caller cannot
   * tell whether to enable a provider, lower a policy, or move to another node.
   */
  select(input: {
    profile: ContainerProfile;
    requested?: string | null;
    minimumIsolation?: ContainerIsolationClass;
  }): ProviderSelection {
    const { profile, requested, minimumIsolation } = input;
    const floor = minimumIsolation ? CONTAINER_ISOLATION_RANK[minimumIsolation] : 0;

    if (requested) {
      const provider = this.providers.get(requested);
      if (!provider) {
        throw new ContainerError(
          `provider ${requested} is not enabled on this node`,
          'no_provider',
          { requested, enabled: [...this.providers.keys()] },
        );
      }
      if (!provider.descriptor.profiles.includes(profile)) {
        throw new ContainerError(
          `provider ${requested} cannot serve the ${profile} profile`,
          'no_provider',
          { requested, profile, profiles: provider.descriptor.profiles },
        );
      }
      if (!provider.synthetic && CONTAINER_ISOLATION_RANK[provider.descriptor.isolation] < floor) {
        // A POLICY refusal, not a missing feature: the provider is here and
        // could run it, but not at a class the policy accepts. 403, and the
        // message names the class and what would satisfy it (§4.3).
        throw new ContainerError(
          `provider ${requested} isolates at ${provider.descriptor.isolation}, `
          + `below the ${minimumIsolation} this profile requires`,
          'policy',
          { requested, isolation: provider.descriptor.isolation, minimumIsolation,
            satisfiedBy: this.satisfying(profile, floor).map((p) => p.descriptor.id) },
        );
      }
      return { provider, descriptor: provider.descriptor };
    }

    const candidates = this.satisfying(profile, floor);
    const chosen = candidates[0];
    if (!chosen) {
      const forProfile = this.list().filter((p) => p.descriptor.profiles.includes(profile));
      if (forProfile.length > 0 && minimumIsolation) {
        throw new ContainerError(
          `no provider on this node isolates the ${profile} profile at ${minimumIsolation} or stronger`,
          'policy',
          { profile, minimumIsolation,
            available: forProfile.map((p) => `${p.descriptor.id}:${p.descriptor.isolation}`) },
        );
      }
      throw new ContainerError(
        `no provider on this node serves the ${profile} profile`,
        'no_provider',
        { profile, enabled: [...this.providers.keys()] },
      );
    }
    return { provider: chosen, descriptor: chosen.descriptor };
  }

  /**
   * Re-run every provider's probe. Called at boot, on `tm8 doctor` and every
   * 6 h. A probe that THROWS is a probe that failed — it is recorded as
   * `ok: false` with the reason, never propagated, because one broken runtime
   * must not stop a node from serving the others.
   */
  async probeAll(now: () => Date = () => new Date()): Promise<ContainerProviderDescriptor[]> {
    const measuredAt = now().toISOString();
    return Promise.all(this.list().map(async (provider) => {
      if (!provider.probe) return provider.descriptor;
      try {
        const result = await provider.probe();
        return { ...provider.descriptor, probe: { ...result, measuredAt } };
      } catch (err) {
        return {
          ...provider.descriptor,
          probe: { ok: false, detail: err instanceof Error ? err.message : String(err), measuredAt },
        };
      }
    }));
  }

  private satisfying(profile: ContainerProfile, floor: number): ContainerProvider[] {
    // A synthetic provider is exempt from the floor — see the long note on
    // `ContainerProvider.synthetic` for why that is not a policy hole.
    return this.list().filter((p) => p.descriptor.profiles.includes(profile)
      && (p.synthetic === true || CONTAINER_ISOLATION_RANK[p.descriptor.isolation] >= floor));
  }

  /** Providers that materialize no workload. `fake` is the only one. */
  syntheticProviderIds(): string[] {
    return this.list().filter((p) => p.synthetic === true).map((p) => p.descriptor.id);
  }
}
