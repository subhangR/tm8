/**
 * Context-seeded creation flows (Layer 6, UX brief §6.3).
 *
 * "+" is everywhere and carries its context as a `CreateSeed`:
 *   - a channel "+"  → seedForChannel(...)  = create + attached_to the channel
 *   - a parent "+"   → seedForParent(...)   = create as child (hierarchy)
 *   - the palette    → already exists (Pulse) — same `createVia` seam.
 *
 * The modal renders ONLY the kind's registry creation-form schema (the Z3
 * Content fields — `registryFor(kind).creation`); everything else attaches
 * after creation via the grammar. Dispatch is the registry's `createVia`
 * (DEF-10 / DEV-1); child creation goes through the same generic
 * `createEntity` seam directly because `KindCreateInput` cannot carry a
 * `parentId` yet (registry gap flagged to Atlas).
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { create as createStore } from 'zustand';
import { useFacade } from '../../entity';
import { creatableKinds, registryFor, type CreationField } from '../../registry';
import { useNavStore } from '../../stores';
import { pushToast } from '../../subsystems/live';
import { describeError } from '../../subsystems/palette';
import type {
  CommandResult, CreateEntityInput, EntityId, EntityKind, SpaceId,
} from '../../types/contract';
import type { CollabFacade } from '../../facade';

// ---------------------------------------------------------------------------
// seeds
// ---------------------------------------------------------------------------

export interface CreateSeed {
  spaceId: SpaceId;
  /** Create + edge atomically (channel "+", promote). */
  attachTo?: { entityId: EntityId; edgeType: 'attached_to' | 'relates_to' };
  /** Create as a child of this same-kind parent (parent "+"). */
  parentId?: EntityId | null;
}

/** Channel "+" — the created entity is attached to the channel. */
export function seedForChannel(spaceId: SpaceId, channelId: EntityId): CreateSeed {
  return { spaceId, attachTo: { entityId: channelId, edgeType: 'attached_to' } };
}

/** Parent "+" — the created entity is born as a child. */
export function seedForParent(spaceId: SpaceId, parentId: EntityId): CreateSeed {
  return { spaceId, parentId };
}

/**
 * The one create dispatch for every seeded flow. Uses the registry's
 * canonical `createVia`; the child-seed variant calls the same generic
 * `createEntity` seam directly (KindCreateInput has no parentId — flagged).
 */
export async function createFromSeed(
  facade: CollabFacade,
  kind: EntityKind,
  seed: CreateSeed,
  title: string,
  content?: Record<string, unknown>,
): Promise<CommandResult> {
  const entry = registryFor(kind);
  if (!entry.createVia || !entry.creation) {
    throw new Error(entry.creationDisabledReason ?? `${entry.labelPlural} cannot be created here.`);
  }
  if (seed.parentId != null) {
    return facade.createEntity({
      spaceId: seed.spaceId,
      kind: kind as CreateEntityInput['kind'], // safe: createVia≠null excludes message/member
      title,
      parentId: seed.parentId,
      content,
      attachTo: seed.attachTo,
    });
  }
  return entry.createVia(facade, {
    spaceId: seed.spaceId, title, attachTo: seed.attachTo, content,
  });
}

// ---------------------------------------------------------------------------
// creation store — one open request at a time, imperative open
// ---------------------------------------------------------------------------

export interface CreationRequest { kind: EntityKind; seed: CreateSeed }

interface CreationState {
  request: CreationRequest | null;
  open: (kind: EntityKind, seed: CreateSeed) => void;
  close: () => void;
}

export const useCreationStore = createStore<CreationState>()((set) => ({
  request: null,
  open: (kind, seed) => set({ request: { kind, seed } }),
  close: () => set({ request: null }),
}));

/** Imperative entry point (mirrors `openPaletteWith`). */
export function openCreation(kind: EntityKind, seed: CreateSeed): void {
  useCreationStore.getState().open(kind, seed);
}

// ---------------------------------------------------------------------------
// the modal — registry schema fields ONLY
// ---------------------------------------------------------------------------

function FieldInput({ field, value, onChange }: {
  field: CreationField;
  value: string;
  onChange: (v: string) => void;
}) {
  const common = {
    id: `cv2-create-${field.name}`,
    required: field.required,
    placeholder: field.placeholder,
    'aria-label': field.label,
  };
  if (field.type === 'textarea') {
    return <textarea {...common} className="cv2-create__input" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === 'select') {
    return (
      <select {...common} className="cv2-create__input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>{field.placeholder ?? 'Choose…'}</option>
        {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
  return <input {...common} type={type} className="cv2-create__input" value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** Collected field strings → typed content values (numbers stay numbers). */
export function contentFromValues(
  fields: CreationField[], values: Record<string, string>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (raw === undefined || raw === '') continue;
    content[f.name] = f.type === 'number' ? Number(raw) : raw;
  }
  return content;
}

export interface CreationModalProps {
  request: CreationRequest;
  onClose: () => void;
  onCreated?: (result: CommandResult) => void;
  /** Push a panel for the created entity (default true). */
  openAfter?: boolean;
}

export function CreationModal({ request, onClose, onCreated, openAfter = true }: CreationModalProps) {
  const facade = useFacade();
  const entry = registryFor(request.kind);
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const schema = entry.creation;
  if (!schema) {
    return (
      <div className="cv2-create" role="dialog" aria-label="Creation unavailable">
        <p className="cv2-create__disabled">{entry.creationDisabledReason ?? 'Not creatable.'}</p>
        <button type="button" className="cv2-actionbtn" onClick={onClose}>Close</button>
      </div>
    );
  }

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    createFromSeed(facade, request.kind, request.seed, title.trim(), contentFromValues(schema.fields, values))
      .then((result) => {
        pushToast({ kind: 'success', message: `Created ${title.trim()}`, entityId: result.entity?.id });
        onCreated?.(result);
        onClose();
        if (openAfter && result.entity) useNavStore.getState().pushPanel({ entityId: result.entity.id });
      })
      .catch((err) => {
        pushToast({ kind: 'error', message: `Create failed — ${describeError(err)}` });
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="cv2-create__backdrop" data-testid="creation-modal">
      <form
        className="cv2-create"
        role="dialog"
        aria-modal="true"
        aria-label={`New ${entry.label}`}
        onSubmit={submit}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <header className="cv2-create__head">
          <span className="cv2-create__glyph" aria-hidden="true">{entry.glyph}</span>
          <span className="cv2-create__title">New {entry.label}</span>
        </header>

        <label className="cv2-create__field">
          <span className="cv2-create__label">{schema.titleLabel}</span>
          <input
            ref={titleRef}
            className="cv2-create__input"
            value={title}
            required
            aria-label={schema.titleLabel}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        {schema.fields.map((field) => (
          <label key={field.name} className="cv2-create__field">
            <span className="cv2-create__label">{field.label}</span>
            <FieldInput
              field={field}
              value={values[field.name] ?? ''}
              onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
            />
          </label>
        ))}

        <footer className="cv2-create__actions">
          <button type="button" className="cv2-actionbtn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="cv2-actionbtn cv2-actionbtn--primary" disabled={busy || !title.trim()}>
            Create
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Mount once (the DndProvider does): renders the modal for open requests. */
export function CreationHost() {
  const request = useCreationStore((s) => s.request);
  const close = useCreationStore((s) => s.close);
  if (!request) return null;
  return <CreationModal request={request} onClose={close} />;
}

// ---------------------------------------------------------------------------
// the "+" affordance
// ---------------------------------------------------------------------------

export interface CreatePlusProps {
  seed: CreateSeed;
  /** Offered kinds; one kind opens the modal directly, several show a picker.
   *  Defaults to every registry-creatable kind. */
  kinds?: EntityKind[];
  label?: ReactNode;
  className?: string;
}

export function CreatePlus({ seed, kinds, label = '+', className }: CreatePlusProps) {
  const [picking, setPicking] = useState(false);
  const offered = kinds ?? creatableKinds().map((e) => e.kind);

  const pick = (kind: EntityKind): void => {
    setPicking(false);
    openCreation(kind, seed);
  };

  return (
    <span className={`cv2-createplus${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="cv2-createplus__btn"
        aria-label="Create here"
        aria-haspopup={offered.length > 1 ? 'menu' : undefined}
        onClick={() => (offered.length === 1 ? pick(offered[0]) : setPicking((p) => !p))}
      >
        {label}
      </button>
      {picking && offered.length > 1 && (
        <span className="cv2-createplus__menu" role="menu" aria-label="What to create">
          {offered.map((kind) => {
            const entry = registryFor(kind);
            return (
              <button
                key={kind}
                type="button"
                role="menuitem"
                className="cv2-createplus__item"
                onClick={() => pick(kind)}
              >
                <span aria-hidden="true">{entry.glyph}</span> {entry.label}
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}
