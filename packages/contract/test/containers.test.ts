// The container contract (TM8-CONTAINERS-DESIGN §4.2), and specifically the
// two things a wrong schema would let through silently: a credential written
// into `spec.env`, and a spec whose numbers no node can honour.
import { describe, expect, it } from 'vitest';

import {
  CONTAINER_ISOLATION_RANK,
  CONTAINER_PROFILES,
  CONTAINER_STATUSES,
  CONTAINER_SURFACE_KINDS,
  ContainerLifecycleSchema,
  ContainerSpecInputSchema,
  ContainerSpecSchema,
  ContainersAttachInputSchema,
  ContainersCreateInputSchema,
  ContainersExposeInputSchema,
  ContainersLifecycleInputSchema,
  ContainersPoolsSetInputSchema,
  ContainersTerminalStartInputSchema,
  ContainersUpdateInputSchema,
  CreatableEntityKindSchema,
  CoreEntityKindSchema,
  EntityCapabilitiesSchema,
  EntityContentSchema,
  EntityStateSchema,
  OPERATIONS,
  getOperation,
  isSecretLookingEnvKey,
} from '../src/index.js';

const createInput = (over: Record<string, unknown> = {}) => ({
  clientMutationId: 'm1',
  spaceId: 'space-1',
  profile: 'shell' as const,
  ...over,
});

describe('containers — the kind itself', () => {
  it('is a core kind but is NOT creatable through entities.create', () => {
    expect(CoreEntityKindSchema.safeParse('container').success).toBe(true);
    // The birth verb is `containers.create`, which reserves the record and
    // then provisions a runtime. A generic create would make a container row
    // with no machine behind it: it would render, list and count, and every
    // verb on it would fail.
    expect(CreatableEntityKindSchema.safeParse('container').success).toBe(false);
  });

  it('carries all 25 catalog rows, every one v1', () => {
    const rows = OPERATIONS.filter((op) => op.name.startsWith('containers.'));
    expect(rows).toHaveLength(25);
    expect(rows.every((op) => op.status === 'v1')).toBe(true);
  });

  it('declares containers.stream as an alias of the existing socket, not a second mount', () => {
    const stream = getOperation('containers.stream');
    const events = getOperation('events.subscribe');
    expect(stream.method).toBe('WS');
    expect(`${stream.method} ${stream.path}`).toBe(`${events.method} ${events.path}`);
    expect(stream.aliasOf).toBe('events.subscribe');
  });

  it('orders isolation classes weakest to strongest, because the policy COMPARES them', () => {
    // §12.1 refuses a provider whose class ranks below the profile's minimum.
    // If this order were alphabetical, `gvisor` would outrank `microvm` and a
    // browser profile would accept weaker isolation than the design demands.
    expect(CONTAINER_ISOLATION_RANK.process).toBeLessThan(CONTAINER_ISOLATION_RANK.container);
    expect(CONTAINER_ISOLATION_RANK.container).toBeLessThan(CONTAINER_ISOLATION_RANK.gvisor);
    expect(CONTAINER_ISOLATION_RANK.gvisor).toBeLessThan(CONTAINER_ISOLATION_RANK.microvm);
    expect(CONTAINER_ISOLATION_RANK.microvm).toBeLessThan(CONTAINER_ISOLATION_RANK.vm);
  });

  it('pins the three vocabularies the status machine and the surfaces depend on', () => {
    expect(CONTAINER_STATUSES).toHaveLength(9);
    expect(CONTAINER_PROFILES).toHaveLength(7);
    expect(CONTAINER_SURFACE_KINDS).toHaveLength(6);
  });
});

describe('secret-looking env keys are refused, by name, at the contract', () => {
  // Secrets reach a machine through the credential path (§12.3). An env var on
  // the spec is stored on the row, returned by every read of it, and visible
  // to anything that can see the entity — so this refusal is the difference
  // between a credential in a process and a credential in the graph.
  const refused = [
    'GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TM8_AGENT_TOKEN',
    'MY_SECRET', 'SECRET_SAUCE', 'DB_PASSWORD', 'PASSWORD', 'AWS_ACCESS_KEY',
    'STRIPE_API_KEY', 'SSH_PRIVATE_KEY', 'SOME_CREDENTIALS', 'AUTH_HEADER', 'BEARER_TOKEN',
  ];
  for (const key of refused) {
    it(`refuses ${key}`, () => {
      expect(isSecretLookingEnvKey(key)).toBe(true);
      const parsed = ContainerSpecInputSchema.safeParse({ env: { [key]: 'x' } });
      expect(parsed.success).toBe(false);
    });
  }

  it('is case-insensitive — a lowercase secret is still a secret', () => {
    expect(isSecretLookingEnvKey('github_token')).toBe(true);
    expect(ContainerSpecInputSchema.safeParse({ env: { github_token: 'x' } }).success).toBe(false);
  });

  it('names the offending KEY and never echoes its VALUE', () => {
    const parsed = ContainerSpecInputSchema.safeParse({ env: { GITHUB_TOKEN: 'ghp_notarealsecret' } });
    expect(parsed.success).toBe(false);
    const rendered = JSON.stringify(parsed.success ? {} : parsed.error.issues);
    expect(rendered).toContain('GITHUB_TOKEN');
    // A refusal that echoed the value would copy the secret into every log,
    // CLI transcript and error body that touches the response.
    expect(rendered).not.toContain('ghp_notarealsecret');
  });

  it('still admits ordinary env vars', () => {
    for (const key of ['NODE_ENV', 'PORT', 'HOME', 'LANG', 'TZ', 'CI', 'DEBUG']) {
      expect(isSecretLookingEnvKey(key)).toBe(false);
    }
    expect(ContainerSpecInputSchema.safeParse({ env: { NODE_ENV: 'production', PORT: '3000' } }).success).toBe(true);
  });

  it('refuses a secret key arriving through containers.create, not just the bare spec', () => {
    expect(ContainersCreateInputSchema.safeParse(
      createInput({ spec: { env: { AWS_SECRET_ACCESS_KEY: 'x' } } }),
    ).success).toBe(false);
  });
});

describe('spec bounds', () => {
  const spec = (over: Record<string, unknown>) => ContainerSpecInputSchema.safeParse(over).success;

  it('accepts the documented range and refuses either side of it', () => {
    expect(spec({ cpus: 0.25 })).toBe(true);
    expect(spec({ cpus: 16 })).toBe(true);
    expect(spec({ cpus: 0.1 })).toBe(false);
    expect(spec({ cpus: 17 })).toBe(false);

    expect(spec({ memMiB: 128 })).toBe(true);
    expect(spec({ memMiB: 65536 })).toBe(true);
    expect(spec({ memMiB: 127 })).toBe(false);
    expect(spec({ memMiB: 65537 })).toBe(false);
    expect(spec({ memMiB: 1024.5 })).toBe(false);

    expect(spec({ diskMiB: 512 })).toBe(true);
    expect(spec({ diskMiB: 511 })).toBe(false);
  });

  it('bounds ports to the real port space and caps how many', () => {
    expect(spec({ ports: [1, 65535] })).toBe(true);
    expect(spec({ ports: [0] })).toBe(false);
    expect(spec({ ports: [65536] })).toBe(false);
    expect(spec({ ports: Array.from({ length: 33 }, (_, i) => i + 1) })).toBe(false);
  });

  it('requires a guest mount path to be ABSOLUTE', () => {
    expect(spec({ mounts: [{ host: '/tmp/x', guest: '/workspace', ro: false }] })).toBe(true);
    expect(spec({ mounts: [{ host: '/tmp/x', guest: 'workspace', ro: false }] })).toBe(false);
  });

  it('keeps the host path on the INPUT side and off the READ side (R5)', () => {
    // A mount cannot round-trip: you send a host path and never read one back,
    // because `entity_content` reaches the client and host paths must not.
    expect(spec({ mounts: [{ host: '/tmp/x', guest: '/workspace', ro: true }] })).toBe(true);
    const read = ContainerSpecSchema.safeParse({
      profile: 'shell', cpus: 1, memMiB: 512,
      mounts: [{ host: '/tmp/x', guest: '/workspace', ro: true }],
      env: {}, ports: [], network: { preset: 'balanced', allow: [] },
      surfaces: {}, labels: {},
    });
    expect(read.success).toBe(false);
  });

  it('is strict — an unknown member is a typo, not a no-op', () => {
    expect(spec({ cpuz: 2 })).toBe(false);
    expect(ContainersCreateInputSchema.safeParse(createInput({ profil: 'shell' })).success).toBe(false);
  });

  it('bounds the lifecycle numbers and lets ttl be an explicit null', () => {
    const life = (over: Record<string, unknown>) => ContainerLifecycleSchema.safeParse({
      ephemeral: true, ttlSeconds: null, idleHibernateSeconds: null,
      graceSeconds: 600, snapshotOnStop: false, ...over,
    }).success;
    expect(life({})).toBe(true);
    expect(life({ ttlSeconds: 60 })).toBe(true);
    expect(life({ ttlSeconds: 604800 })).toBe(true);
    expect(life({ ttlSeconds: 59 })).toBe(false);
    expect(life({ ttlSeconds: 604801 })).toBe(false);
    expect(life({ graceSeconds: -1 })).toBe(false);
  });
});

describe('which inputs demand expectedVersion', () => {
  // The record-changing verbs assert a version; the ones that act on the
  // runtime without changing the record do not. Getting this wrong either
  // makes a lost update silent or makes a legitimate call impossible.
  it('demands it on the lifecycle verbs, update, expose and pool', () => {
    expect(ContainersLifecycleInputSchema.safeParse({ clientMutationId: 'm' }).success).toBe(false);
    expect(ContainersLifecycleInputSchema.safeParse({ clientMutationId: 'm', expectedVersion: 3 }).success).toBe(true);
    expect(ContainersUpdateInputSchema.safeParse({ clientMutationId: 'm' }).success).toBe(false);
    expect(ContainersExposeInputSchema.safeParse({ clientMutationId: 'm', port: 8080 }).success).toBe(false);
    expect(ContainersPoolsSetInputSchema.safeParse({ clientMutationId: 'm', warm: 2 }).success).toBe(false);
  });

  it('does NOT accept it on create, attach or terminal.start', () => {
    expect(ContainersCreateInputSchema.safeParse(createInput({ expectedVersion: 1 })).success).toBe(false);
    expect(ContainersAttachInputSchema.safeParse({
      clientMutationId: 'm', surface: 'screen', mode: 'view', expectedVersion: 1,
    }).success).toBe(false);
    expect(ContainersTerminalStartInputSchema.safeParse({
      clientMutationId: 'm', expectedVersion: 1,
    }).success).toBe(false);
  });
});

describe('the narrow unions that are easy to widen by accident', () => {
  it('refuses attaching to `terminal` — that verb is containers.terminal.start', () => {
    // The exec terminal mints a real work_session and rides the PTY path; it
    // is not a surface grant, and admitting it here would produce a grant
    // nothing can serve.
    expect(ContainersAttachInputSchema.safeParse({ clientMutationId: 'm', surface: 'terminal', mode: 'view' }).success).toBe(false);
    expect(ContainersAttachInputSchema.safeParse({ clientMutationId: 'm', surface: 'http', mode: 'view' }).success).toBe(false);
    expect(ContainersAttachInputSchema.safeParse({ clientMutationId: 'm', surface: 'screen', mode: 'drive' }).success).toBe(true);
  });

  it('keeps the two share vocabularies apart', () => {
    // The container shares like a work_session (`explicit`); a PORT shares by
    // `link`. They read alike and mean different things.
    expect(ContainersUpdateInputSchema.safeParse({ clientMutationId: 'm', expectedVersion: 1, shareMode: 'explicit' }).success).toBe(true);
    expect(ContainersUpdateInputSchema.safeParse({ clientMutationId: 'm', expectedVersion: 1, shareMode: 'link' }).success).toBe(false);
    expect(ContainersExposeInputSchema.safeParse({ clientMutationId: 'm', expectedVersion: 1, port: 80, share: 'link' }).success).toBe(true);
    expect(ContainersExposeInputSchema.safeParse({ clientMutationId: 'm', expectedVersion: 1, port: 80, share: 'explicit' }).success).toBe(false);
  });

  it('accepts confirmUntrusted only as literal true — `false` must not read as consent', () => {
    expect(ContainersCreateInputSchema.safeParse(createInput({ confirmUntrusted: true })).success).toBe(true);
    expect(ContainersCreateInputSchema.safeParse(createInput({ confirmUntrusted: false })).success).toBe(false);
  });
});

describe('EntityState / EntityContent carry a container arm — and every other kind', () => {
  // WHY THIS TEST EXISTS. Both unions are annotated `z.ZodType<EntityState>`,
  // and that annotation checks the schema PARSES to the type — it does NOT
  // check the union is exhaustive over the type's arms. A union missing an arm
  // is still assignable, so adding a TS arm and forgetting the zod one is
  // invisible to `tsc`. That is exactly what happened when `container` landed:
  // every file compiled and a real container payload failed `safeParse` at
  // runtime. Lane D found it against its fixtures, one package downstream.
  //
  // This is the assertion that catches it here instead, and catches the next
  // kind too.
  const state = {
    kind: 'container' as const,
    status: 'running' as const,
    profile: 'shell' as const,
    provider: 'fake',
    isolation: 'process' as const,
    nodeId: 'node-a',
    surfaces: ['terminal' as const],
    ephemeral: true,
    shareMode: 'none' as const,
    startedAt: '2026-09-03T00:00:00.000Z',
    expiresAt: null,
  };

  const content = {
    kind: 'container' as const,
    image: 'alpine:3',
    spec: {
      profile: 'shell' as const, cpus: 1, memMiB: 512, mounts: [], env: {}, ports: [],
      network: { preset: 'balanced' as const, allow: [] }, surfaces: {}, labels: {},
    },
    lifecycle: {
      ephemeral: true, ttlSeconds: null, idleHibernateSeconds: null,
      graceSeconds: 600, snapshotOnStop: false,
    },
    surfaceDetail: { terminal: { live: true } },
    error: null,
    usage: null,
    exposed: [],
  };

  it('accepts a container state payload', () => {
    const parsed = EntityStateSchema.safeParse(state);
    expect(parsed.success).toBe(true);
  });

  it('accepts a container content payload', () => {
    const parsed = EntityContentSchema.safeParse(content);
    expect(parsed.success).toBe(true);
  });

  it('REFUSES a runtimeRef smuggled into content (R5)', () => {
    // `.strict()` is what makes putting it back a red rather than a silent
    // leak of a native runtime id to every client that can see the entity.
    expect(EntityContentSchema.safeParse({ ...content, runtimeRef: 'docker://abc' }).success)
      .toBe(false);
  });

  it('REFUSES a host path in a read-side mount (R5)', () => {
    expect(EntityContentSchema.safeParse({
      ...content,
      spec: { ...content.spec, mounts: [{ host: '/Users/me', guest: '/workspace', ro: true }] },
    }).success).toBe(false);
  });

  it('accepts a surfaceDetail with NO screen key — it is partial', () => {
    expect(EntityContentSchema.safeParse({ ...content, surfaceDetail: {} }).success).toBe(true);
  });

  it('every CoreEntityKind has an arm in BOTH unions', () => {
    // Asserted by INSPECTING THE UNION rather than by parsing a sample of each
    // kind. A sample-based test proves a payload someone hand-wrote validates,
    // which drifts and fails for reasons that have nothing to do with the arm
    // being present; this asks the question directly — "is there an arm whose
    // `kind` literal is this kind" — and cannot pass by accident.
    for (const kind of CoreEntityKindSchema.options) {
      expect(unionKinds(EntityStateSchema), `EntityStateSchema has no arm for ${kind}`)
        .toContain(kind);
      expect(unionKinds(EntityContentSchema), `EntityContentSchema has no arm for ${kind}`)
        .toContain(kind);
    }
  });
});

describe('EntityCapabilities carries the six container verbs', () => {
  // THE THIRD INSTANCE of the shape the two tests above exist for, and the one
  // with the least cover. `EntityCapabilitiesSchema` is `.strict()` and
  // annotated `z.ZodType<EntityCapabilities>`; the six container members are
  // OPTIONAL, and a schema missing an optional member still produces a valid
  // `EntityCapabilities`, so the annotation type-checks while the runtime
  // schema rejects the very payload the server computes.
  //
  // Nothing else would catch it. The only consumer that would notice is a
  // container fixture failing `EntityDetailSchema`, and those fixtures live in
  // `packages/tm8-ui`, which CI typechecks but does not TEST. Deleting the six
  // lines therefore goes green through the entire gate — which is how the
  // omission reached review in the first place.
  const base = {
    canEdit: true, canDelete: false, canAddChild: false, canLink: true,
    canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
  };
  const containerVerbs = {
    canStart: false, canStop: true, canDestroy: true,
    canAttach: true, canControl: false, canExec: true,
  };

  it('accepts a capability payload carrying all six', () => {
    const parsed = EntityCapabilitiesSchema.safeParse({ ...base, ...containerVerbs });
    // Printed rather than asserted as a bare boolean: a strict object names the
    // member it refused, so a red says WHICH of the six is missing.
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.')))
      .toEqual([]);
  });

  it('accepts each of the six on its own, so one missing member cannot hide', () => {
    // The `toEqual([])` above passes if ALL six are present. This localises a
    // failure to the single member at fault instead of the whole set.
    for (const [verb, value] of Object.entries(containerVerbs)) {
      const parsed = EntityCapabilitiesSchema.safeParse({ ...base, [verb]: value });
      expect(parsed.success, `EntityCapabilitiesSchema has no ${verb}`).toBe(true);
    }
  });

  it('DISPROOF: the schema is genuinely strict, so the six passing means something', () => {
    // Without this, the two tests above would also pass against a schema that
    // accepted anything — they assert PRESENCE, and a permissive schema is
    // indistinguishable from a complete one. This shows the same schema refuses
    // an undeclared member, so acceptance of the six is evidence and not noise.
    const parsed = EntityCapabilitiesSchema.safeParse({ ...base, canTeleport: true });
    expect(parsed.success).toBe(false);
  });

  it('keeps all six OPTIONAL — a non-container entity sends none of them', () => {
    expect(EntityCapabilitiesSchema.safeParse(base).success).toBe(true);
  });
});

/**
 * The `kind` literals each arm of a discriminated-ish union accepts.
 *
 * It reaches through `z.lazy` and reads zod internals, which is a deliberate
 * trade: the alternative is trusting `z.ZodType<T>`, and that annotation is
 * exactly what failed to notice the missing arm in the first place.
 */
function unionKinds(schema: unknown): string[] {
  const def = (schema as { _def: Record<string, unknown> })._def;
  const resolved = typeof def.getter === 'function'
    ? (def.getter as () => { _def: Record<string, unknown> })()._def
    : def;
  const options = (resolved.options ?? []) as Array<{ _def: { shape?: () => Record<string, unknown> }; shape?: Record<string, unknown> }>;
  const kinds: string[] = [];
  for (const option of options) {
    const shape = typeof option._def.shape === 'function' ? option._def.shape() : option.shape;
    const kind = shape?.kind as { _def?: { value?: string; values?: string[] } } | undefined;
    if (!kind?._def) continue;
    if (kind._def.value !== undefined) kinds.push(kind._def.value);
    else if (kind._def.values) kinds.push(...kind._def.values);
  }
  return kinds;
}
