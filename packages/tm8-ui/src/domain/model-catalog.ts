/**
 * THE EDITABLE MODEL CATALOG — the built-in offering plus this browser's own
 * additions and edits.
 *
 * `LAUNCH_MODEL_CATALOG` in the contract is a COMPILE-TIME constant: the set of
 * models the node deliberately offers. That is the right default and the wrong
 * ceiling — `ExecutionSpawnInput.agentTool` and `.model` are both free strings,
 * so a node will happily run a model this UI has never heard of, and until now
 * the only way to offer one was to edit the contract and rebuild.
 *
 * WHERE THIS LIVES, AND THE HONEST CONSEQUENCE. localStorage, per node. It is a
 * PER-BROWSER setting: a model added here is not visible to teammates, to your
 * other devices, or to the CLI, and it does not survive clearing site data.
 * That is a deliberate trade for shipping without a schema change, and every
 * surface that renders it has to SAY so rather than let it look space-wide.
 * The upgrade path is a server-side catalog; nothing here forecloses it,
 * because the built-ins remain the contract's and only the delta is stored.
 *
 * ONLY THE DELTA IS STORED. Built-ins are never copied into storage — an
 * override records the fields that changed and a hidden flag records a
 * suppression. So a contract update to a built-in's label or note reaches
 * everyone on the next load instead of being frozen behind a stale copy, and
 * "reset" is implemented by deleting the delta rather than by remembering what
 * the original was.
 */
import { LAUNCH_MODEL_CATALOG, type LaunchModelCatalogEntry, type LaunchModelEffort } from '@tm8/contract';

/** The tools this UI knows how to launch. Free strings on the wire; a closed
    set here, because the launcher builds a different CLI invocation per tool. */
export const KNOWN_AGENT_TOOLS = ['claude-code', 'codex'] as const;
export type KnownAgentTool = (typeof KNOWN_AGENT_TOOLS)[number];

export interface CatalogModel {
  model: string;
  label: string;
  agentTool: string;
  note: string;
  provider: string;
  /** False for anything this browser added — drives the "custom" chip. */
  builtIn: boolean;
  /** True when a built-in has a local edit applied. Drives "reset". */
  overridden: boolean;
  /** Effort stops the model accepts (contract). ABSENT for a browser-added model: nobody measured it. */
  efforts?: readonly LaunchModelEffort[];
}

/** A user's addition. Kept minimal: everything else is derived or defaulted. */
interface CustomModel {
  model: string;
  label: string;
  agentTool: string;
  note?: string;
  provider?: string;
}

/** A user's edit to a BUILT-IN, stored as the changed fields only. */
interface BuiltInOverride {
  label?: string;
  note?: string;
  hidden?: boolean;
}

interface CatalogDelta {
  custom: CustomModel[];
  overrides: Record<string, BuiltInOverride>;
}

const CATALOG_VERSION = 'v1';
const KEY_PREFIX = `tm8.model-catalog.${CATALOG_VERSION}`;
const EMPTY: CatalogDelta = { custom: [], overrides: {} };

function keyFor(nodeKey: string): string {
  return `${KEY_PREFIX}.${nodeKey}`;
}

/** Guarded exactly like the launch cache: storage can throw on read OR write. */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readDelta(nodeKey: string): CatalogDelta {
  const store = storage();
  if (!store) return EMPTY;
  try {
    const raw = store.getItem(keyFor(nodeKey));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as CatalogDelta;
    return {
      custom: Array.isArray(parsed?.custom)
        ? parsed.custom.filter(
            (c): c is CustomModel =>
              !!c && typeof c.model === 'string' && c.model.trim() !== '' && typeof c.label === 'string',
          )
        : [],
      overrides:
        parsed?.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
    };
  } catch {
    try {
      store.removeItem(keyFor(nodeKey));
    } catch {
      /* nothing further to do */
    }
    return EMPTY;
  }
}

function writeDelta(nodeKey: string, delta: CatalogDelta): void {
  const store = storage();
  if (!store) return;
  try {
    if (delta.custom.length === 0 && Object.keys(delta.overrides).length === 0) {
      store.removeItem(keyFor(nodeKey));
    } else {
      store.setItem(keyFor(nodeKey), JSON.stringify(delta));
    }
  } catch {
    /* quota or policy — the built-in catalog still works */
  }
  notify();
}

// ---------------------------------------------------------------------------
// Subscription — so the launch picker sees an edit without a reload
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

export function subscribeModelCatalog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Monotonic; `useSyncExternalStore`-friendly and cheap to compare. */
export function modelCatalogVersion(): number {
  return version;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function applyOverride(entry: LaunchModelCatalogEntry, over: BuiltInOverride | undefined): CatalogModel {
  return {
    model: entry.model,
    label: over?.label ?? entry.label,
    note: over?.note ?? entry.note,
    agentTool: entry.agentTool,
    provider: entry.provider,
    builtIn: true,
    overridden: over !== undefined && (over.label !== undefined || over.note !== undefined),
    efforts: entry.efforts,
  };
}

/**
 * The catalog as it stands: built-ins (minus suppressed, plus edits) then this
 * browser's own, in insertion order. `includeHidden` is for the settings screen,
 * which has to show a suppressed built-in in order to offer to restore it.
 */
export function modelCatalog(nodeKey: string, includeHidden = false): CatalogModel[] {
  const delta = readDelta(nodeKey);
  const builtIns = LAUNCH_MODEL_CATALOG.filter(
    (entry) => includeHidden || delta.overrides[entry.model]?.hidden !== true,
  ).map((entry) => applyOverride(entry, delta.overrides[entry.model]));
  const custom = delta.custom.map<CatalogModel>((c) => ({
    model: c.model,
    label: c.label,
    agentTool: c.agentTool,
    note: c.note ?? 'added in this browser',
    provider: c.provider ?? 'custom',
    builtIn: false,
    overridden: false,
  }));
  return [...builtIns, ...custom];
}

/** True when this built-in is currently suppressed. */
export function isModelHidden(nodeKey: string, model: string): boolean {
  return readDelta(nodeKey).overrides[model]?.hidden === true;
}

/** Offerable models for a tool — what the launch picker renders. */
export function catalogModelsFor(nodeKey: string, agentTool: string | null | undefined): CatalogModel[] {
  if (!agentTool) return [];
  return modelCatalog(nodeKey).filter((entry) => entry.agentTool === agentTool);
}

// ---------------------------------------------------------------------------
// Writes — each returns a refusal string, or null on success
// ---------------------------------------------------------------------------

/**
 * Validation is a REFUSAL WITH A REASON, not a boolean: every caller renders
 * the string, so an add that cannot proceed says which rule stopped it.
 */
export function addCustomModel(nodeKey: string, input: CustomModel): string | null {
  const model = input.model.trim();
  const label = input.label.trim();
  if (model === '') return 'A model id is required — it is the string passed to the agent CLI.';
  if (label === '') return 'A display label is required — the picker shows the label, not the id.';
  if (input.agentTool.trim() === '') return 'Pick the agent tool this model runs under.';
  const delta = readDelta(nodeKey);
  if (LAUNCH_MODEL_CATALOG.some((e) => e.model === model)) {
    return `${model} is already a built-in model — edit it instead of adding a second one.`;
  }
  if (delta.custom.some((c) => c.model === model)) {
    return `${model} has already been added in this browser.`;
  }
  writeDelta(nodeKey, {
    ...delta,
    custom: [
      ...delta.custom,
      {
        model,
        label,
        agentTool: input.agentTool.trim(),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
      },
    ],
  });
  return null;
}

/** Edits either a custom model or a built-in; the storage shape differs. */
export function editModel(
  nodeKey: string,
  model: string,
  patch: { label?: string; note?: string },
): string | null {
  const label = patch.label?.trim();
  if (label !== undefined && label === '') return 'A display label is required.';
  const delta = readDelta(nodeKey);
  const custom = delta.custom.find((c) => c.model === model);
  if (custom) {
    writeDelta(nodeKey, {
      ...delta,
      custom: delta.custom.map((c) =>
        c.model === model
          ? { ...c, ...(label !== undefined ? { label } : {}), ...(patch.note !== undefined ? { note: patch.note.trim() } : {}) }
          : c,
      ),
    });
    return null;
  }
  if (!LAUNCH_MODEL_CATALOG.some((e) => e.model === model)) return `${model} is not in the catalog.`;
  const existing = delta.overrides[model] ?? {};
  writeDelta(nodeKey, {
    ...delta,
    overrides: {
      ...delta.overrides,
      [model]: {
        ...existing,
        ...(label !== undefined ? { label } : {}),
        ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
      },
    },
  });
  return null;
}

/**
 * Hides a BUILT-IN or deletes a CUSTOM one.
 *
 * A built-in is never deleted, because it is not ours to delete — it comes back
 * on the next contract update regardless, so pretending otherwise would be a
 * control whose effect silently expires.
 */
export function removeModel(nodeKey: string, model: string): string | null {
  const delta = readDelta(nodeKey);
  if (delta.custom.some((c) => c.model === model)) {
    writeDelta(nodeKey, { ...delta, custom: delta.custom.filter((c) => c.model !== model) });
    return null;
  }
  if (!LAUNCH_MODEL_CATALOG.some((e) => e.model === model)) return `${model} is not in the catalog.`;
  writeDelta(nodeKey, {
    ...delta,
    overrides: { ...delta.overrides, [model]: { ...(delta.overrides[model] ?? {}), hidden: true } },
  });
  return null;
}

/** Drops the local delta for one model: un-hides and discards any edit. */
export function resetModel(nodeKey: string, model: string): void {
  const delta = readDelta(nodeKey);
  if (!(model in delta.overrides)) return;
  const overrides = { ...delta.overrides };
  delete overrides[model];
  writeDelta(nodeKey, { ...delta, overrides });
}

/** Drops every local change on this node. */
export function resetModelCatalog(nodeKey: string): void {
  writeDelta(nodeKey, { custom: [], overrides: {} });
}

/** How many local changes exist — the settings screen states this plainly. */
export function localChangeCount(nodeKey: string): number {
  const delta = readDelta(nodeKey);
  return delta.custom.length + Object.keys(delta.overrides).length;
}
