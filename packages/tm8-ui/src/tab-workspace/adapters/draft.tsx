/**
 * Draft host per kind (Spec A §9, Spec B §5.5, §8).
 *
 * `DraftHost` owns the runtime half for every kind: it restores the stored
 * values on mount, writes edits to the draft store (debounced there) and marks
 * the tab dirty, flags `submitting` while a create is in flight, and on
 * success dispatches `drafts.bind` (source `system`) — the runtime then turns
 * the tab into the entity tab in place, or toasts "Created <title>" with Open
 * if the tab was closed meanwhile.
 *
 * The body is the kind's existing creation door, never a new one:
 *  - generic kinds: the header-create form (`authoring/`, title plus the
 *    launch header when the kind declares `createHeader`), through the same
 *    `entities.create` path;
 *  - `file`: the upload door (`files/upload`), the file's bytes being its
 *    substance;
 *  - `skill`: `SkillCreateControl` (the skill-file door);
 *  - `work_session`: the launch sheet (`NewSessionScreen`);
 *  - `chat`: the chat-start flow (`ChatHomeSurface` in its solo composer).
 * `form` is the form builder (`FormDraftBody`, wired in the registry).
 * `artifact` and `project` have no create door in this client, so the
 * registry marks them not creatable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type FormEvent } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import {
  classifyFailure,
  creatableKind,
  createdIdOf,
  newEntityInput,
  placeholderTitleFor,
  RefusalCard,
  type RefusedFailure,
} from '../../authoring';
import { ChatHomeSurface } from '../../chat-home/ChatHomeSurface';
import { subscribeDrafts } from '../runtime/draftStore';
import { nodeKeyOf } from '../../data/launch-cache';
import { EMPTY_HEADER_DRAFT, getKind, headerDraftHasText, headerInputOf, type HeaderDraft } from '../../domain';
import { pickFiles } from '../../files/pick';
import { createFileUploadTask, safeUploadReason } from '../../files/upload';
import { NewSessionScreen } from '../../new-session';
import { HeaderFields } from '../../panels/detail/HeaderSection';
import { SkillCreateControl } from '../../skills/SkillCreateControl';
import { onDraftFocusRequest } from '../runtime/draftFocus';
import type { DraftTabRecord, KindId } from '../runtime/types';
import { useWorkspace } from '../view/context';
import { getKindAdapter } from './registry';
import '../view/creation.css';

export interface DraftHostProps {
  tab: DraftTabRecord;
  /** Stored values for this draft (null when none), read once on mount. */
  values: Record<string, unknown> | null;
  /** Store values (debounced) and mark the tab dirty. */
  onValues(values: Record<string, unknown>): void;
  /** Report a created entity; the host dispatches `drafts.bind` (source `system`). */
  onCreated(entityId: string, title: string): void;
  /** Cancel: close the draft tab (through the normal close flow). */
  onCancel(): void;
  /** ADDITIVE (W1-F): a create started (true) or failed (false); blocks double submits. */
  onSubmitting(submitting: boolean): void;
  /**
   * ADDITIVE (W1-F): created, but the door returns no entity id to bind (the
   * skill-file door). The host closes the tab and toasts "Created <title>".
   */
  onCreatedUnbound(title: string): void;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export function DraftHost({ tab }: { tab: DraftTabRecord }) {
  const { runtime } = useWorkspace();
  const adapter = getKindAdapter(tab.kind);
  // Values are read once per mount: a remount (tab switch, reload) restores
  // them, and so does a change the node pushed from another window or an
  // agent (Spec D §3) — its remote version is part of the read's key.
  const remoteVersion = useSyncExternalStore(
    subscribeDrafts,
    () => runtime.drafts.remoteVersionOf(tab.draftId),
  );
  const values = useMemo(() => runtime.drafts.get(tab.draftId), [runtime, tab.draftId, remoteVersion]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const { id: tabId, draftId, kind } = tab;
  const exists = useCallback(() => runtime.store.getState().tabs[tabId]?.type === 'draft', [runtime, tabId]);

  const onValues = useCallback(
    (next: Record<string, unknown>) => {
      // A late keystroke after the tab closed must not resurrect its values.
      if (!exists()) return;
      runtime.drafts.set(draftId, next);
      const current = runtime.store.getState().tabs[tabId];
      if (current?.type === 'draft' && !current.dirty) {
        runtime.dispatch({ command: 'workspace.drafts.markDirty', args: { tabId, dirty: true }, source: 'keyboard' });
      }
    },
    [runtime, tabId, draftId, exists],
  );

  const onSubmitting = useCallback(
    (submitting: boolean) => {
      if (!exists()) return;
      runtime.dispatch({ command: 'workspace.drafts.markDirty', args: { tabId, submitting }, source: 'system' });
    },
    [runtime, tabId, exists],
  );

  const onCreated = useCallback(
    (entityId: string, title: string) => {
      runtime.dispatch({
        command: 'workspace.drafts.bind',
        args: { tabId, entityId, kind, title },
        source: 'system',
      });
      // Spec A §9: a new entity outside the browser's filters stays open; say so,
      // and leave the filters alone. Only the text query can be judged here.
      const state = runtime.store.getState();
      const browser = state.browsers.main;
      const query = browser.kind === kind ? browser.perKind[kind]?.query.trim().toLowerCase() : '';
      if (state.tabs[tabId] && query && !title.toLowerCase().includes(query)) {
        runtime.hooks.toast({ text: `Created ${title} — it doesn't match the browser filters` });
      }
    },
    [runtime, tabId, kind],
  );

  const onCancel = useCallback(() => {
    runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId }, source: 'click' });
  }, [runtime, tabId]);

  const onCreatedUnbound = useCallback(
    (title: string) => {
      if (exists()) {
        runtime.dispatch({
          command: 'workspace.drafts.markDirty',
          args: { tabId, dirty: false, submitting: false },
          source: 'system',
        });
        runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId }, source: 'system' });
      }
      runtime.hooks.toast({ text: `Created ${title}` });
    },
    [runtime, tabId, exists],
  );

  // Spec A §16: opening a draft focuses its first field. A fresh mount does
  // that in the body; a `drafts.open` that REUSES this mounted draft (+ New on
  // an untouched one) gets no remount, so focus it here.
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(
    () =>
      onDraftFocusRequest((requested) => {
        if (requested !== tabId) return;
        const host = hostRef.current;
        if (!host) return;
        const field =
          host.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"]') ??
          host.querySelector<HTMLElement>('button:not(:disabled)');
        field?.focus();
      }),
    [tabId],
  );

  const Body = adapter.draftBody ?? GenericDraftBody;
  return (
    <div ref={hostRef} className="tws-draft" data-testid="tws-draft-host" data-kind={kind}>
      <Body
        key={remoteVersion}
        tab={tab}
        values={values}
        onValues={onValues}
        onCreated={onCreated}
        onCancel={onCancel}
        onSubmitting={onSubmitting}
        onCreatedUnbound={onCreatedUnbound}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function str(values: Record<string, unknown> | null, key: string): string {
  const value = values?.[key];
  return typeof value === 'string' ? value : '';
}

function headerOf(values: Record<string, unknown> | null): HeaderDraft {
  const value = values?.header;
  if (typeof value !== 'object' || value === null) return EMPTY_HEADER_DRAFT;
  const h = value as Record<string, unknown>;
  return {
    whenToUse: typeof h.whenToUse === 'string' ? h.whenToUse : '',
    summary: typeof h.summary === 'string' ? h.summary : '',
    keywords: typeof h.keywords === 'string' ? h.keywords : '',
  };
}

function noIdFailure(noun: string): RefusedFailure {
  return {
    kind: 'refused',
    cause: 'created, but the node did not return the new id',
    detail: 'The command succeeded and carried neither an entity nor a patch to read it from.',
    aftermath: `The ${noun} MAY exist — reload the list before trying again.`,
    code: 'no_id',
    retryable: false,
  };
}

/** The draft's heading row: "New task" on the content plane. */
function DraftHeading({ kind }: { kind: KindId }) {
  return <h2 className="tws-draft-title">{`New ${getKindAdapter(kind).noun.toLowerCase()}`}</h2>;
}

// ---------------------------------------------------------------------------
// Generic kinds: the header-create form, in a tab
// ---------------------------------------------------------------------------

function GenericDraftBody({ tab, values, onValues, onCreated, onCancel, onSubmitting }: DraftHostProps) {
  const { gate, spaceId } = useWorkspace();
  const config = getKind(tab.kind);
  const noun = config.label.toLowerCase();
  const placeholder = placeholderTitleFor(config.label);
  const [title, setTitle] = useState(() => str(values, 'title'));
  const [header, setHeader] = useState<HeaderDraft>(() => headerOf(values));
  const [failure, setFailure] = useState<RefusedFailure | null>(null);
  const firstField = useRef<HTMLInputElement | null>(null);
  const inFlight = useRef(false);
  const submitting = tab.submitting;

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const write = (next: { title: string; header: HeaderDraft }) =>
    onValues({ title: next.title, ...(config.createHeader ? { header: next.header } : {}) });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const kind = creatableKind(tab.kind as Parameters<typeof creatableKind>[0]);
    if (inFlight.current || submitting || kind === null) return;
    inFlight.current = true;
    setFailure(null);
    onSubmitting(true);
    const finalTitle = title.trim() || placeholder;
    try {
      const input = newEntityInput(spaceId as SpaceId, kind, finalTitle);
      const result = await gate.data.seam.commands.createEntity(
        config.createHeader && headerDraftHasText(header) ? { ...input, header: headerInputOf(header) } : input,
      );
      gate.data.reconcileCommand(result);
      const id = createdIdOf(result);
      if (id === null) {
        setFailure(noIdFailure(noun));
        onSubmitting(false);
        return;
      }
      onCreated(id, finalTitle);
    } catch (error) {
      const classified = classifyFailure(error, 'create');
      setFailure(
        classified.kind === 'refused'
          ? classified
          : { kind: 'refused', cause: classified.cause, detail: classified.detail, aftermath: 'Nothing was created.', code: 'version_conflict', retryable: false },
      );
      onSubmitting(false);
      // Point at the failing field: the title is the one field a create can refuse.
      firstField.current?.focus();
    } finally {
      inFlight.current = false;
    }
  };

  const errorId = `tws-draft-error-${tab.id}`;
  return (
    <form className="tws-draft-form" onSubmit={(event) => void submit(event)} aria-label={`New ${noun}`} data-testid="tws-draft-form">
      <DraftHeading kind={tab.kind} />
      <label className="au-dialog__field">
        <span className="au-dialog__label">
          Title<em className="au-dialog__optional"> · optional</em>
        </span>
        <input
          ref={firstField}
          className="au-dialog__input"
          value={title}
          placeholder={placeholder}
          disabled={submitting}
          aria-invalid={failure ? true : undefined}
          aria-describedby={failure ? errorId : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            write({ title: event.target.value, header });
          }}
          data-testid="tws-draft-title"
        />
      </label>
      {config.createHeader ? (
        <HeaderFields
          draft={header}
          disabled={submitting}
          onChange={(next) => {
            setHeader(next);
            write({ title, header: next });
          }}
        />
      ) : null}
      {failure ? (
        <div id={errorId}>
          <RefusalCard
            word={failure.cause}
            detail={failure.detail}
            aftermath={failure.aftermath}
            moves={failure.retryable ? [{ label: 'retry', onSelect: () => void submit() }] : []}
          />
        </div>
      ) : null}
      <DraftActions onCancel={onCancel} submitting={submitting} createLabel={`Create ${noun}`} />
    </form>
  );
}

function DraftActions({
  onCancel,
  submitting,
  createLabel,
  onCreate,
}: {
  onCancel(): void;
  submitting: boolean;
  createLabel?: string;
  /** Absent with a `createLabel`: the button submits the enclosing form. */
  onCreate?: () => void;
}) {
  return (
    <div className="au-dialog__actions tws-draft-actions">
      <button type="button" onClick={onCancel} disabled={submitting} data-testid="tws-draft-cancel">
        Cancel
      </button>
      {createLabel ? (
        <button
          type={onCreate ? 'button' : 'submit'}
          className="au-dialog__primary"
          onClick={onCreate}
          aria-busy={submitting}
          disabled={submitting}
          data-testid="tws-draft-create"
        >
          {submitting ? 'Creating…' : createLabel}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// file: the upload door
// ---------------------------------------------------------------------------

function FileDraftBody({ tab, onCreated, onCancel, onSubmitting }: DraftHostProps) {
  const { gate, spaceId } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const chooseRef = useRef<HTMLButtonElement | null>(null);
  const submitting = tab.submitting;

  useEffect(() => {
    chooseRef.current?.focus();
  }, []);

  const choose = async () => {
    if (submitting) return;
    const [file] = await pickFiles({ multiple: false });
    if (!file) return;
    setError(null);
    onSubmitting(true);
    try {
      const uploaded = await createFileUploadTask({ files: gate.data.seam.files, file, spaceId: spaceId as SpaceId }).result;
      onCreated(uploaded.fileEntityId, file.name);
    } catch (cause) {
      setError(`${file.name}: ${safeUploadReason(cause)}`);
      onSubmitting(false);
      chooseRef.current?.focus();
    }
  };

  return (
    <div className="tws-draft-form" data-testid="tws-draft-file">
      <DraftHeading kind={tab.kind} />
      <p className="tws-draft-note">A file is created from its bytes: choose one to upload.</p>
      {error ? (
        <p className="tws-draft-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="au-dialog__actions tws-draft-actions">
        <button type="button" onClick={onCancel} disabled={submitting} data-testid="tws-draft-cancel">
          Cancel
        </button>
        <button
          ref={chooseRef}
          type="button"
          className="au-dialog__primary"
          onClick={() => void choose()}
          aria-busy={submitting}
          disabled={submitting}
          data-testid="tws-draft-create"
        >
          {submitting ? 'Uploading…' : 'Choose file…'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// skill: the skill-file door
// ---------------------------------------------------------------------------

function idFrom(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  const entity = r.entity as Record<string, unknown> | undefined;
  for (const candidate of [r.entityId, r.skillId, entity?.id]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function SkillDraftBody({ tab, onValues, onCreated, onCancel, onCreatedUnbound }: DraftHostProps) {
  const { gate, spaceId } = useWorkspace();
  const port = gate.data.seam.commands.skills;
  return (
    // The skill form is uncontrolled: any edit marks the draft dirty (its
    // values are not restorable across a remount).
    <div className="tws-draft-form" data-testid="tws-draft-skill" onInput={() => onValues({})}>
      <DraftHeading kind={tab.kind} />
      {port ? (
        <SkillCreateControl
          spaceId={spaceId}
          port={port}
          autoOpen
          onCancel={onCancel}
          onCreated={(name, result) => {
            const id = idFrom(result);
            if (id) onCreated(id, name);
            else onCreatedUnbound(name);
          }}
        />
      ) : (
        <>
          <p className="tws-draft-note">This node does not offer skill authoring.</p>
          <DraftActions onCancel={onCancel} submitting={false} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// work_session: the launch sheet
// ---------------------------------------------------------------------------

function LaunchDraftBody({ values, onValues, onCreated, onCancel, onSubmitting, tab }: DraftHostProps) {
  const { gate, spaceId } = useWorkspace();
  const noop = useCallback(() => undefined, []);
  return (
    <div className="tws-draft-launch" data-testid="tws-draft-launch">
      <NewSessionScreen
        spaceId={spaceId as SpaceId}
        commands={gate.data.seam.commands}
        spawn={gate.data.spawn}
        launch={gate.data.launch}
        serverBaseUrl={gate.serverBaseUrl}
        onSessionReady={noop}
        initialDraft={str(values, 'draft')}
        initialTitle={str(values, 'title')}
        onValuesChange={(next) => onValues(next)}
        onBusyChange={onSubmitting}
        onSpawned={(id, title) => onCreated(id, title)}
      />
      <DraftActions onCancel={onCancel} submitting={tab.submitting} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// chat: the chat-start flow
// ---------------------------------------------------------------------------

function ChatDraftBody({ tab, onValues, onCreated, onCancel }: DraftHostProps) {
  const { gate, spaceId } = useWorkspace();
  const nodeKey = nodeKeyOf(gate.serverBaseUrl);
  const noun = getKindAdapter(tab.kind).noun.toLowerCase();
  const onThreadSelected = useCallback(
    (id: EntityId | null) => {
      // Fires on the send that creates the chat; a cold start passes null.
      if (id) onCreated(id, noun);
    },
    [onCreated, noun],
  );
  return (
    // The composer keeps its own draft in the chat store (Spec B §8); any
    // keystroke marks this draft tab dirty.
    <div className="tws-draft-chat" data-testid="tws-draft-chat" onInput={() => onValues({})}>
      <ChatHomeSurface
        seam={gate.data.seam}
        spaceId={spaceId}
        nodeKey={nodeKey}
        skillOptions={gate.data.skillOptions}
        soloConversation
        coldStart="composer"
        onThreadSelected={onThreadSelected}
      />
      <DraftActions onCancel={onCancel} submitting={tab.submitting} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry seam
// ---------------------------------------------------------------------------

/**
 * The kind-specific draft body, or undefined for the generic header-create
 * form. Read by `adapters/registry.ts` (`KindAdapter.draftBody`).
 */
export function draftBodyFor(kind: KindId): ComponentType<DraftHostProps> | undefined {
  if (kind === 'work_session') return LaunchDraftBody;
  if (kind === 'chat') return ChatDraftBody;
  const form = getKind(kind).createForm;
  if (form === 'file-upload') return FileDraftBody;
  if (form === 'skill-file') return SkillDraftBody;
  return undefined;
}
