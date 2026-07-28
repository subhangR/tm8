import type { CoreEntityKind } from '@tm8/contract';

export type RouteStrategy =
  | 'channel-special'
  | 'anchored-message'
  | 'collection'
  | 'custom-collection'
  | 'none';

export type CollectionStrategy =
  | 'channel-view'
  | 'not-addressable'
  | 'typed-collection'
  | 'custom-registry'
  | 'none';

export type ProjectionStrategy =
  | 'universal-typed'
  | 'project-materialized'
  | 'interaction-profile-sanitized'
  | 'custom-scalar'
  | 'static-registry-only';

export type CapabilityProfile =
  | 'generic'
  | 'message-owned'
  | 'work-session-execution'
  | 'project-restricted'
  | 'interaction-profile-lifecycle'
  | 'custom-scalar'
  | 'static-no-authority';

export type MenuStrategy =
  | 'default'
  | 'registered-not-default'
  | 'config-addable'
  | 'not-addressable'
  | 'not-kind';

export type MigrationStrategy =
  | 'baseline-core'
  | 'baseline-identity'
  | 'baseline-message-plus-w1'
  | 'baseline-session-plus-w1'
  | 'w1-project-projection'
  | 'w1-interaction-profile'
  | 'custom-registry'
  | 'none';

export interface CapabilityDisposition {
  readonly profile: CapabilityProfile;
  readonly genericCreate: boolean;
  readonly genericPatch: boolean;
  readonly genericMove: boolean;
  readonly genericHierarchy: boolean;
  readonly genericDeleteRestore: boolean;
  readonly genericPoints: boolean;
  readonly messages: boolean;
  readonly reactions: boolean;
  readonly connections: boolean;
  readonly lifecycleOperations: readonly string[];
}

export interface KindDisposition {
  readonly kind: CoreEntityKind | 'c:*';
  readonly entityKind: true;
  readonly route: { readonly strategy: RouteStrategy; readonly slug?: string };
  readonly collection: { readonly strategy: CollectionStrategy };
  readonly projection: { readonly strategy: ProjectionStrategy };
  readonly capabilities: CapabilityDisposition;
  readonly menu: { readonly strategy: MenuStrategy };
  readonly migration: { readonly strategy: MigrationStrategy };
}

function core(
  kind: CoreEntityKind,
  slug: string,
  options: Omit<KindDisposition, 'kind' | 'entityKind' | 'route' | 'capabilities'> & {
    route?: RouteStrategy;
    capabilities: { readonly profile: CapabilityProfile };
  },
): KindDisposition {
  return {
    kind,
    entityKind: true,
    route: { strategy: options.route ?? 'collection', slug },
    collection: options.collection,
    projection: options.projection,
    capabilities: capabilities(options.capabilities.profile),
    menu: options.menu,
    migration: options.migration,
  };
}

function capabilities(profile: CapabilityProfile): CapabilityDisposition {
  const allGeneric = {
    genericCreate: true,
    genericPatch: true,
    genericMove: true,
    genericHierarchy: true,
    genericDeleteRestore: true,
    genericPoints: true,
    messages: true,
    reactions: true,
    connections: true,
    lifecycleOperations: [],
  } as const;
  switch (profile) {
    case 'generic':
    case 'custom-scalar':
      return { profile, ...allGeneric };
    case 'message-owned':
      return {
        profile,
        genericCreate: false,
        genericPatch: false,
        genericMove: false,
        genericHierarchy: false,
        genericDeleteRestore: false,
        genericPoints: false,
        messages: true,
        reactions: true,
        connections: true,
        lifecycleOperations: ['messages.post', 'messages.edit', 'messages.delete'],
      };
    case 'work-session-execution':
      return {
        profile,
        genericCreate: false,
        genericPatch: false,
        genericMove: false,
        genericHierarchy: false,
        genericDeleteRestore: false,
        genericPoints: false,
        messages: true,
        reactions: true,
        connections: true,
        lifecycleOperations: ['execution.spawn', 'execution.terminate', 'execution.streams.attach'],
      };
    case 'project-restricted':
      return {
        profile,
        genericCreate: false,
        genericPatch: false,
        genericMove: false,
        genericHierarchy: false,
        genericDeleteRestore: false,
        genericPoints: false,
        messages: true,
        reactions: true,
        connections: true,
        lifecycleOperations: ['projects.link', 'projects.unlink', 'projects.associations.correct'],
      };
    case 'interaction-profile-lifecycle':
      return {
        profile,
        genericCreate: false,
        genericPatch: false,
        genericMove: false,
        genericHierarchy: false,
        genericDeleteRestore: false,
        genericPoints: false,
        messages: true,
        reactions: true,
        connections: true,
        lifecycleOperations: [
          'interactionProfiles.propose',
          'interactionProfiles.updateDraft',
          'interactionProfiles.validate',
          'interactionProfiles.preview',
          'interactionProfiles.activate',
          'interactionProfiles.retire',
        ],
      };
    case 'static-no-authority':
      return {
        profile,
        genericCreate: false,
        genericPatch: false,
        genericMove: false,
        genericHierarchy: false,
        genericDeleteRestore: false,
        genericPoints: false,
        messages: false,
        reactions: false,
        connections: false,
        lifecycleOperations: [],
      };
    default: throw new Error(`unknown capability profile: ${String(profile)}`);
  }
}

const generic = { profile: 'generic' } as const;
const universal = { strategy: 'universal-typed' } as const;
const typedCollection = { strategy: 'typed-collection' } as const;
const baseline = { strategy: 'baseline-core' } as const;

/**
 * W0's total kind matrix, represented as a compile-time total Record.
 * Adding a CoreEntityKind to the contract without a disposition fails tsc;
 * removing one leaves an excess property and fails tsc as well.
 */
export const CORE_KIND_DISPOSITIONS = {
  channel: core('channel', 'channels', {
    route: 'channel-special', collection: { strategy: 'channel-view' },
    projection: universal, capabilities: generic, menu: { strategy: 'default' }, migration: baseline,
  }),
  task: core('task', 'tasks', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'default' }, migration: baseline,
  }),
  message: core('message', 'messages', {
    route: 'anchored-message', collection: { strategy: 'not-addressable' },
    projection: universal, capabilities: { profile: 'message-owned' },
    menu: { strategy: 'not-addressable' }, migration: { strategy: 'baseline-message-plus-w1' },
  }),
  member: core('member', 'members', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'default' }, migration: { strategy: 'baseline-identity' },
  }),
  team_member: core('team_member', 'teammates', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'default' }, migration: { strategy: 'baseline-identity' },
  }),
  doc: core('doc', 'docs', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'default' }, migration: baseline,
  }),
  file: core('file', 'files', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'registered-not-default' }, migration: baseline,
  }),
  spell: core('spell', 'spells', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'registered-not-default' }, migration: baseline,
  }),
  skill: core('skill', 'skills', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'registered-not-default' }, migration: baseline,
  }),
  pull_request: core('pull_request', 'pulls', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'default' }, migration: baseline,
  }),
  commit: core('commit', 'commits', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'registered-not-default' }, migration: baseline,
  }),
  work_session: core('work_session', 'sessions', {
    collection: typedCollection, projection: universal,
    capabilities: { profile: 'work-session-execution' }, menu: { strategy: 'default' },
    migration: { strategy: 'baseline-session-plus-w1' },
  }),
  collection: core('collection', 'collections', {
    collection: typedCollection, projection: universal, capabilities: generic,
    menu: { strategy: 'registered-not-default' }, migration: baseline,
  }),
  project: core('project', 'projects', {
    collection: typedCollection, projection: { strategy: 'project-materialized' },
    capabilities: { profile: 'project-restricted' }, menu: { strategy: 'default' },
    migration: { strategy: 'w1-project-projection' },
  }),
  interaction_profile: core('interaction_profile', 'interaction-profiles', {
    collection: typedCollection, projection: { strategy: 'interaction-profile-sanitized' },
    capabilities: { profile: 'interaction-profile-lifecycle' },
    menu: { strategy: 'registered-not-default' }, migration: { strategy: 'w1-interaction-profile' },
  }),
} as const satisfies Readonly<Record<CoreEntityKind, KindDisposition>>;

export const CUSTOM_KIND_DISPOSITION = {
  kind: 'c:*',
  entityKind: true,
  route: { strategy: 'custom-collection', slug: 'c-{name}' },
  collection: { strategy: 'custom-registry' },
  projection: { strategy: 'custom-scalar' },
  capabilities: capabilities('custom-scalar'),
  menu: { strategy: 'config-addable' },
  migration: { strategy: 'custom-registry' },
} as const satisfies KindDisposition;

export const UI_TEMPLATE_SENTINEL = {
  kind: 'ui_template',
  entityKind: false,
  route: { strategy: 'none' },
  collection: { strategy: 'none' },
  projection: { strategy: 'static-registry-only' },
  capabilities: capabilities('static-no-authority'),
  menu: { strategy: 'not-kind' },
  migration: { strategy: 'none' },
} as const;

export function assertKindDispositionTotality(coreKinds: readonly string[]): void {
  const contract = [...coreKinds].sort();
  const dispositions = Object.keys(CORE_KIND_DISPOSITIONS).sort();
  if (JSON.stringify(contract) !== JSON.stringify(dispositions)) {
    throw new Error(
      `core kind disposition drift: contract=${contract.join(',')} dispositions=${dispositions.join(',')}`,
    );
  }
  if (contract.includes(UI_TEMPLATE_SENTINEL.kind)) {
    throw new Error('ui_template must remain a static negative sentinel, never a CoreEntityKind');
  }
}
