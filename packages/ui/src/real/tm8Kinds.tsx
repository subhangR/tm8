/**
 * Runtime KindRegistry extension — the `work_session` and `collection` kinds.
 *
 * WHY THIS FILE EXISTS (the first real transplant defect, and it is a crash):
 * the collab-v2 snapshot's `EntityKind` union is the inherited ELEVEN kinds,
 * and `KIND_REGISTRY` is a `Record<EntityKind, KindEntry>` read by
 * `registryFor()` with a bare index and NO fallback:
 *
 *     export function registryFor(kind: EntityKind): KindEntry {
 *       return KIND_REGISTRY[kind];          // undefined for an unknown kind
 *     }
 *
 * tm8's contract (03 §1) PROMOTED two further kinds to core — `work_session`
 * and `collection`. The live server returns `work_session` entities the moment
 * anything has been spawned, so the first real render died on
 * `registryFor('work_session').tint` → "Cannot read properties of undefined
 * (reading 'tint')", and the whole app went white. A mock world that never
 * produced those kinds could not have caught it.
 *
 * WHY IT IS REGISTERED FROM OUT HERE rather than fixed in KindRegistry.tsx:
 * Atlas's team owns that module and this lane's rule is to keep the diff at
 * import paths. Registration is ADDITIVE and uses only the module's own
 * exported surface — which is precisely the "runtime KindRegistry path" that
 * packages/ui/README.md already names as W3 work. Nothing inside collab-v2 is
 * edited to make this work.
 *
 * NOTE FOR ATLAS: the durable fix belongs upstream — widen `EntityKind`, add
 * these two entries, and give `registryFor` a fallback entry so an unknown
 * kind degrades to a generic chip instead of a white screen. A registry read
 * that can return `undefined` through a non-optional signature is the actual
 * bug; the missing kinds were only how it surfaced.
 */
import {
  KIND_ORDER, KIND_REGISTRY, registryFor,
  type KindEntry, type PrimaryAction, type RegistryCtx,
} from '../collab-v2/registry';
import { Pill, type PillTone } from '../collab-v2/kit';
import type { EntityDetail, EntityKind, EntitySummary } from '../collab-v2/types/contract';

/** The event a task's "Spawn agent" action raises; the host renders the dialog. */
export const SPAWN_REQUEST_EVENT = 'tm8:spawn-request';

type Mutable = Record<string, KindEntry>;

/**
 * The entries below describe kinds the snapshot's `EntityKind` union does not
 * contain, so they cannot be typed as `KindEntry` directly — `kind` would not
 * be assignable. This alias keeps every OTHER field fully typechecked (the
 * callbacks, the capabilities, the components) and confines the widening to
 * the one field that genuinely diverges, instead of casting the whole object
 * and losing contextual typing on all of it.
 */
type Tm8KindEntry = Omit<KindEntry, 'kind'> & { kind: string };

function stateOf(s: EntitySummary | EntityDetail): Record<string, unknown> {
  return (s.state ?? {}) as unknown as Record<string, unknown>;
}

const SESSION_TONE: Record<string, PillTone> = {
  spawning: 'waiting',
  running: 'working',
  exited: 'idle',
  failed: 'blocked',
};

/**
 * `work_session` — the running agent. Its `state` is
 * `{status, agentTool, model, shareMode, startedAt, exitedAt}`, verified by
 * live call against the server rather than read off a schema.
 */
const workSession: Tm8KindEntry = {
  kind: 'work_session',
  label: 'Session',
  labelPlural: 'Sessions',
  glyph: '▶',
  tint: (s) => {
    const status = String(stateOf(s).status ?? '');
    return status === 'running' ? 'var(--pn-working, #34d399)'
      : status === 'failed' ? 'var(--pn-blocked, #f87171)'
      : 'var(--pn-ink, #8b8d98)';
  },
  chipLabel: (s) => s.title || 'Session',
  chipMeta: (s) => {
    const st = stateOf(s);
    // Only state the server actually sent. `agentTool`/`model` are nullable and
    // a null must read as absent, not as a default like "claude".
    return [st.agentTool, st.model].filter(Boolean).join(' · ') || null;
  },
  chipPulse: (s) => stateOf(s).status === 'running',
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity);
    return (
      <div className="cv2-field">
        <span className="cv2-field__value t-mono">{String(st.status ?? 'unknown')}</span>
        {st.startedAt ? <span className="cv2-field__value t-mono">started {String(st.startedAt).slice(11, 19)}</span> : null}
        {st.exitedAt ? <span className="cv2-field__value t-mono">exited {String(st.exitedAt).slice(11, 19)}</span> : null}
      </div>
    );
  },
  Content: ({ detail }) => {
    const st = stateOf(detail);
    return (
      <div className="cv2-content">
        <div className="cv2-kv">
          <div className="cv2-field"><span className="cv2-field__value t-mono">status: {String(st.status ?? 'unknown')}</span></div>
          <div className="cv2-field"><span className="cv2-field__value t-mono">tool: {String(st.agentTool ?? '—')}</span></div>
          <div className="cv2-field"><span className="cv2-field__value t-mono">model: {String(st.model ?? '—')}</span></div>
        </div>
        {/* Honest about the terminal: this node exposes no PTY stream, and an
            empty black rectangle would imply a live-but-silent terminal. */}
        <p className="t-secondary" style={{ marginTop: 12 }}>
          No terminal stream: this tm8 node exposes no PTY route yet, so session
          output cannot be shown. Status above is polled from the entity itself.
        </p>
      </div>
    );
  },
  fullLayout: 'generic',
  status: {
    current: (s) => {
      const status = String(stateOf(s).status ?? 'unknown');
      return { label: status, tone: SESSION_TONE[status] ?? 'neutral', pulse: status === 'running' };
    },
  },
  patchTitle: null,
  primaryActions: (d) => sessionActions(d),
  creation: null,
  creationDisabledReason: 'Sessions are created by spawning an agent on a task.',
  capabilities: { workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: null },
  createVia: null,
  paletteCreate: null,
  collectionEmptyHint: null,
};

/**
 * Prompt / terminate. Both are REAL operations on this node
 * (`entities.commands.prompt`, `entities.commands.terminate`), and both are
 * hidden once the session has exited rather than shown-and-failing.
 */
function sessionActions(d: EntityDetail): PrimaryAction[] {
  const status = String(stateOf(d).status ?? '');
  if (status === 'exited' || status === 'failed') return [];
  return [
    {
      id: 'prompt',
      label: 'Prompt',
      title: 'Send a message into the live PTY',
      run: async ({ facade }) => {
        const message = window.prompt('Message to send to the agent:');
        if (!message) return;
        const exec = facade as unknown as {
          promptSession?: (id: string, m: string) => Promise<unknown>;
        };
        if (!exec.promptSession) throw new Error('this facade cannot prompt sessions');
        return exec.promptSession(d.id, message);
      },
    },
    {
      id: 'terminate',
      label: 'Terminate',
      title: 'Stop this session',
      run: async ({ facade }) => {
        const exec = facade as unknown as { terminateSession?: (id: string) => Promise<unknown> };
        if (!exec.terminateSession) throw new Error('this facade cannot terminate sessions');
        return exec.terminateSession(d.id);
      },
    },
  ];
}

/** `collection` — tm8's other promoted kind. Minimal but truthful. */
const collection: Tm8KindEntry = {
  kind: 'collection',
  label: 'Collection',
  labelPlural: 'Collections',
  glyph: '▤',
  tint: () => 'var(--pn-ink, #8b8d98)',
  chipLabel: (s) => s.title || 'Collection',
  chipMeta: (s) => {
    const n = stateOf(s).itemCount;
    return typeof n === 'number' ? `${n} item${n === 1 ? '' : 's'}` : null;
  },
  chipPulse: () => false,
  SummaryFields: ({ entity }) => (
    <div className="cv2-field">
      <span className="cv2-field__value t-mono">{String(stateOf(entity).collectionType ?? 'collection')}</span>
    </div>
  ),
  Content: ({ detail }) => (
    <div className="cv2-content">
      <div className="cv2-field">
        <span className="cv2-field__value t-mono">type: {String(stateOf(detail).collectionType ?? '—')}</span>
      </div>
    </div>
  ),
  fullLayout: 'generic',
  status: { current: () => null },
  patchTitle: null,
  primaryActions: () => [],
  creation: null,
  creationDisabledReason: 'Collections are not creatable on this node.',
  capabilities: { workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: null },
  createVia: null,
  paletteCreate: null,
  collectionEmptyHint: null,
};

let installed = false;

/**
 * Install the tm8 kinds and add the task-level spawn affordance.
 * Idempotent — React StrictMode double-invokes effects in development.
 */
export function installTm8Kinds(): void {
  if (installed) return;
  installed = true;

  const registry = KIND_REGISTRY as unknown as Mutable;
  registry.work_session = workSession as unknown as KindEntry;
  registry.collection = collection as unknown as KindEntry;
  for (const k of ['work_session', 'collection'] as unknown as EntityKind[]) {
    if (!KIND_ORDER.includes(k)) KIND_ORDER.push(k);
  }

  // Append "Spawn agent" to the task entry's actions rather than replacing
  // them, so every action Atlas's team defines keeps working. The action only
  // raises an event: choosing a project and an agent persona is a decision the
  // user must make explicitly, and guessing "the first project" would be the
  // sort of invisible assumption this lane is meant to avoid.
  const task = registryFor('task') as unknown as {
    primaryActions: (d: EntityDetail) => PrimaryAction[];
  };
  const inherited = task.primaryActions.bind(task);
  task.primaryActions = (d: EntityDetail): PrimaryAction[] => [
    ...inherited(d),
    {
      id: 'tm8-spawn',
      label: 'Spawn agent',
      title: 'Start an agent session on this task',
      run: async () => {
        window.dispatchEvent(new CustomEvent(SPAWN_REQUEST_EVENT, { detail: { taskId: d.id, spaceId: d.spaceId } }));
      },
    },
  ];
}

/** Re-exported so the dialog can render a matching status pill. */
export function SessionStatusPill({ status }: { status: string }) {
  return <Pill tone={SESSION_TONE[status] ?? 'neutral'} pulse={status === 'running'}>{status}</Pill>;
}
