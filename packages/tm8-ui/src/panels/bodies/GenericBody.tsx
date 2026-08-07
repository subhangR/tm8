import { useState } from 'react';
import type {
  AddCollectionItemInput,
  ArtifactPreviewSession,
  ArtifactsPreviewStartInput,
  CommandContext,
  CommandResult,
  EntityDetail,
  EntitySummary,
  Page,
} from '@tm8/contract';
import type { ContentBlockRef } from '../../domain';
import { getKind } from '../../domain';
import { Chip, Eyebrow } from '../../kit';
import { CollectionPicker, type PickerReads } from './CollectionPicker';
import { EmptyBody } from '../detail/PanelStates';

/**
 * The one command this body can execute (threaded from the host's seam
 * assignment, like `AuthoringCommands`): mint a preview capability so the
 * artifact-preview block's Run button renders the bundle. Structural subset
 * of `Seam['commands']` — a host assigns `seam.commands` with no cast.
 */
export interface ArtifactPreviewCommands {
  previewArtifact(id: string, input: ArtifactsPreviewStartInput): Promise<ArtifactPreviewSession>;
}

/**
 * The membership writers, as a STRUCTURAL SUBSET of `Seam['commands']` — a
 * host assigns `seam.commands` with no cast, exactly as it does for the
 * preview command above. Both are optional: a surface that wires neither gets
 * the read-only list, which is why `manage` checks for the functions rather
 * than trusting the registry flag alone.
 */
export interface CollectionItemCommands {
  addCollectionItem(collectionId: string, input: AddCollectionItemInput): Promise<CommandResult>;
  removeCollectionItem(
    collectionId: string,
    entityId: string,
    ctx?: CommandContext,
  ): Promise<CommandResult & { removed: boolean }>;
}

/**
 * The reads the managed items block needs — structural subset of
 * `Seam['reads']`, so a host assigns `seam.reads` with no cast. `entity` and
 * `children` expand a `tree` row; `query` populates the add-items picker.
 */
export interface CollectionItemReads extends PickerReads {
  entity(id: string): Promise<EntityDetail>;
  children(id: string): Promise<Page<EntitySummary>>;
}

/**
 * THE GENERIC ARCHETYPE — a renderer over an ORDERED LIST OF CONTENT BLOCKS.
 *
 * This is the mechanism that lets nine core kinds plus EVERY custom kind share
 * one body with no per-kind component. The registry says which blocks, in
 * what order, with what labels; this file knows only how to draw each block
 * TYPE. So a new display need is a new block or a new block parameter —
 * data — never a branch (L2), and a custom kind lands here for free: a
 * registry miss returns the `c:*` row and its generic blocks render whatever
 * scalar content arrived.
 *
 * Every block reads the detail STRUCTURALLY — "does this content have a
 * `body`?" — never "is this a doc?". That is what keeps the file free of the
 * kind literals §15.2 fails the build on, and it is also why an unknown kind
 * cannot white-screen: absent members simply render nothing.
 */

export function GenericBody({
  detail,
  blocks,
  onOpenEntity,
  commands,
  reads,
}: {
  detail: EntityDetail;
  blocks: readonly ContentBlockRef[];
  onOpenEntity?: (id: string) => void;
  commands?: Partial<ArtifactPreviewCommands & CollectionItemCommands> | null;
  reads?: CollectionItemReads | null;
}) {
  if (blocks.length === 0) {
    return (
      <div className="pn-body">
        <EmptyBody
          glyph={getKind(detail.kind).chip.glyph}
          sentence="This kind renders universal fields only — title, kind and scalar content. Nothing is invented."
        />
      </div>
    );
  }
  return (
    <div className="pn-body" id="tabpanel-content" role="tabpanel" aria-labelledby="tab-content">
      {blocks.map((block, i) => (
        <ContentBlock
          key={`${block.block}:${i}`}
          detail={detail}
          block={block}
          onOpenEntity={onOpenEntity}
          commands={commands}
          reads={reads}
        />
      ))}
    </div>
  );
}

function ContentBlock({
  detail,
  block,
  onOpenEntity,
  commands,
  reads,
}: {
  detail: EntityDetail;
  block: ContentBlockRef;
  onOpenEntity?: (id: string) => void;
  commands?: Partial<ArtifactPreviewCommands & CollectionItemCommands> | null;
  reads?: CollectionItemReads | null;
}) {
  const body = (() => {
    switch (block.block) {
      case 'fields':
        return <FieldsBlock detail={detail} />;
      case 'link-summary':
        return <LinkSummaryBlock detail={detail} />;
      case 'file-preview':
        return <FilePreviewBlock detail={detail} />;
      case 'artifact-preview':
        return <ArtifactPreviewBlock detail={detail} previewArtifact={commands?.previewArtifact} />;
      case 'items':
        return (
          <ItemsBlock
            detail={detail}
            block={block}
            onOpenEntity={onOpenEntity}
            commands={commands}
            reads={reads}
          />
        );
      case 'lifecycle':
        return <LifecycleBlock detail={detail} />;
      case 'notice':
        return <NoticeBlock block={block} />;
      default:
        return null;
    }
  })();
  if (!body) return null;
  return (
    <section className="pn-section" data-testid={`block-${block.block}`}>
      {block.label ? <Eyebrow faint>{block.label}</Eyebrow> : null}
      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Keys that are structure, not content — never rendered as a field row. */
const NON_FIELD_KEYS = new Set(['kind', 'items', 'equipped', 'work', 'mentions', 'attachments', 'fields']);

/**
 * FIELDS — typed key/value rows off `EntityContent`/`EntityState`.
 *
 * Two sources merge: the content's own scalars, and (for custom kinds) the
 * `fields` record the server carries for `c:*` entities. Long prose members
 * (`body`, `description`) get their own full-width row rather than a cramped
 * value cell, because a 32KB doc body in a key/value table is unreadable.
 */
function FieldsBlock({ detail }: { detail: EntityDetail }) {
  const content = detail.content as unknown as Record<string, unknown>;
  const custom = isRecord(content.fields) ? content.fields : {};
  const prose = typeof content.body === 'string' ? content.body : typeof content.description === 'string' ? content.description : null;

  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries({ ...content, ...custom })) {
    if (NON_FIELD_KEYS.has(key)) continue;
    if (key === 'body' || key === 'description') continue;
    const rendered = renderScalar(value);
    if (rendered != null) rows.push([key, rendered]);
  }

  if (rows.length === 0 && !prose) return null;
  return (
    <>
      {prose ? <p className="pn-prose">{prose}</p> : null}
      {rows.length > 0 ? (
        <dl className="pn-fields">
          {rows.map(([key, value]) => (
            <div className="pn-fields__row" key={key}>
              <dt className="pn-fields__key">{humanizeKey(key)}</dt>
              <dd className="pn-fields__value">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}

/**
 * LINK-SUMMARY — the external-reference row (a PR's repo/number/state, a
 * commit's sha and message). Rendered from whichever of those members the
 * content actually carries, so PRs and commits share it without either being
 * named.
 */
function LinkSummaryBlock({ detail }: { detail: EntityDetail }) {
  const state = detail.state as unknown as Record<string, unknown>;
  const repo = typeof state.repository === 'string' ? state.repository : null;
  const number = typeof state.number === 'number' ? `#${state.number}` : null;
  const sha = typeof state.sha === 'string' ? state.sha.slice(0, 7) : null;
  const url = typeof state.url === 'string' ? state.url : null;
  const stale = state.stale === true;

  if (!repo && !sha) return null;
  return (
    <div className="pn-linkrow">
      <span className="pn-linkrow__ref">{[repo, number ?? sha].filter(Boolean).join(' ')}</span>
      {/* The connector's OWN staleness flag — a different fact from delivery
          facets or session liveness, and it gets its own word. */}
      {stale ? <span className="pn-linkrow__stale">stale — refetch to update</span> : null}
      {url ? (
        <a className="pn-linkrow__open" href={url} target="_blank" rel="noreferrer">
          open ↗
        </a>
      ) : null}
    </div>
  );
}

/**
 * FILE-PREVIEW — mime-gated. A preview is only claimed for types that can
 * actually be previewed; everything else gets an honest "no preview" with the
 * download affordance still present.
 */
function FilePreviewBlock({ detail }: { detail: EntityDetail }) {
  const state = detail.state as unknown as Record<string, unknown>;
  const content = detail.content as unknown as Record<string, unknown>;
  const mime = typeof state.mimeType === 'string' ? state.mimeType : '';
  const downloadUrl = typeof content.downloadUrl === 'string' ? content.downloadUrl : null;
  const previewable = mime.startsWith('image/');

  return (
    <div className="pn-preview">
      <div className={previewable ? 'pn-preview__box' : 'pn-preview__box pn-preview__box--none'}>
        <span className="pn-preview__label">
          {previewable ? `image preview · ${mime}` : `no preview for ${mime || 'this type'}`}
        </span>
      </div>
      {downloadUrl ? (
        <a className="pn-btn" href={downloadUrl} download>
          Download ↓
        </a>
      ) : null}
    </div>
  );
}

/**
 * ARTIFACT-PREVIEW — metadata, and a Run button that EXECUTES (the two
 * security decisions that gated this — second origin + accepted iframe
 * residual — were ratified 2026-07-31; TM8-ARTIFACTS-DESIGN §9/§12.1).
 *
 * Preview never autoruns (§9.5): the iframe does not exist until the user
 * clicks Run, so list and feed rendering execute nothing and the metadata is
 * visible BEFORE execution. The frame is `sandbox="allow-scripts"` and
 * NOTHING else — never `allow-same-origin` (with allow-scripts a frame could
 * strip its own sandbox), never top-navigation/popups/downloads/forms — and
 * the src is the server-minted capability URL on the PREVIEW origin,
 * verbatim. This file never builds a preview URL itself: a node without the
 * second-origin listener answers without `previewUrl`, and the honest render
 * is the refusal text, not a broken frame.
 */
function ArtifactPreviewBlock({
  detail,
  previewArtifact,
}: {
  detail: EntityDetail;
  previewArtifact?: ArtifactPreviewCommands['previewArtifact'];
}) {
  const state = detail.state as unknown as Record<string, unknown>;
  const content = detail.content as unknown as Record<string, unknown>;
  const description = typeof content.description === 'string' ? content.description : null;
  const revision = typeof state.revisionNumber === 'number' ? state.revisionNumber : null;
  const fileCount = typeof content.fileCount === 'number' ? content.fileCount : null;
  const totalBytes = typeof content.totalSizeBytes === 'number' ? content.totalSizeBytes : null;

  const [run, setRun] = useState<
    | { phase: 'idle' }
    | { phase: 'starting' }
    | { phase: 'running'; previewUrl: string; expiresAt: string }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  const facts: string[] = [];
  if (revision != null) facts.push(`revision ${revision}`);
  if (fileCount != null) facts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (totalBytes != null) facts.push(formatBytes(totalBytes));

  const onRun = async () => {
    if (!previewArtifact) return;
    setRun({ phase: 'starting' });
    try {
      const session = await previewArtifact(detail.id, {
        clientMutationId: crypto.randomUUID(),
      });
      if (session.previewUrl) {
        setRun({ phase: 'running', previewUrl: session.previewUrl, expiresAt: session.expiresAt });
      } else {
        setRun({ phase: 'error', message: 'This node does not run a preview origin, so the bundle cannot be rendered here.' });
      }
    } catch (err) {
      setRun({ phase: 'error', message: err instanceof Error ? err.message : 'preview could not be started' });
    }
  };

  return (
    <div className="pn-preview">
      {run.phase === 'running' ? (
        <iframe
          className="pn-preview__frame"
          title={`artifact preview · ${detail.title}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={run.previewUrl}
          style={{ width: '100%', minHeight: '320px', border: '1px solid var(--border, #444)', borderRadius: '4px', background: '#fff' }}
        />
      ) : (
        <div className="pn-preview__box pn-preview__box--none">
          <span className="pn-preview__label">
            {detail.title}
            {facts.length > 0 ? ` · ${facts.join(' · ')}` : ''}
          </span>
        </div>
      )}
      {description ? <p className="pn-prose">{description}</p> : null}
      {run.phase === 'error' ? <p className="pn-section__empty">{run.message}</p> : null}
      <button
        type="button"
        className="pn-btn"
        disabled={previewArtifact === undefined || run.phase === 'starting'}
        title={previewArtifact === undefined ? 'Preview is not wired here.' : 'Render this bundle in a sandboxed frame.'}
        onClick={() => void onRun()}
      >
        {run.phase === 'running' ? 'Restart ▷' : run.phase === 'starting' ? 'Starting…' : 'Run ▷'}
      </button>
    </div>
  );
}

/** Human-readable byte size — kept local so the block stays self-contained. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * ITEMS — an `EntitySummary` list. `params.source` names which content member
 * holds them (defaults to `items`), which is how one block serves collections,
 * equipped spells and a member's work without knowing any of those kinds.
 *
 * TWO PARAMETERS CHANGE THE SHAPE, and both default OFF so every other kind
 * using this block keeps the read-only chip row it has today:
 *
 *  - `manage` — remove and drag-reorder. Only a curated set can be edited in
 *    place; a member's `work` list is derived, and offering a remove button on
 *    derived rows would advertise a write with nothing behind it.
 *  - `tree` — rows expand. A nested COLLECTION expands by its own membership,
 *    anything else by its hierarchy children, so a collection of tasks shows
 *    their subtasks without a second block and without this file naming a kind
 *    (it asks the content structurally: does it carry `items`?).
 */
function ItemsBlock({
  detail,
  block,
  onOpenEntity,
  commands,
  reads,
}: {
  detail: EntityDetail;
  block: ContentBlockRef;
  onOpenEntity?: (id: string) => void;
  commands?: Partial<CollectionItemCommands> | null;
  reads?: CollectionItemReads | null;
}) {
  const content = detail.content as unknown as Record<string, unknown>;
  const key = typeof block.params?.source === 'string' ? block.params.source : 'items';
  const raw = content[key] ?? content.items ?? content.equipped ?? content.work;
  const items: EntitySummary[] = Array.isArray(raw) ? (raw as EntitySummary[]) : [];

  const tree = block.params?.tree === true;
  // Manage is a JOINT condition: the registry must ask for it AND the host
  // must have wired the writers. Rendering a remove button off the registry
  // flag alone would produce the enabled-inert affordance `define()` throws
  // over — an control that looks live and does nothing.
  const manage = block.params?.manage === true
    && typeof commands?.addCollectionItem === 'function'
    && typeof commands?.removeCollectionItem === 'function';

  if (items.length === 0) {
    // A designed empty, not an accidental one: an empty collection is a real
    // state and must read as "nothing here yet", never as a failed load.
    return <p className="pn-section__empty">Nothing here yet.</p>;
  }
  if (!manage && !tree) {
    return (
      <div className="pn-chiprow">
        {items.map((item) => (
          <Chip key={item.id} glyph={getKind(item.kind).chip.glyph} onClick={() => onOpenEntity?.(item.id)}>
            {item.title}
          </Chip>
        ))}
      </div>
    );
  }
  return (
    <ManagedItems
      collectionId={detail.id}
      spaceId={detail.spaceId}
      items={items}
      manage={manage}
      tree={tree}
      onOpenEntity={onOpenEntity}
      commands={commands}
      reads={reads}
    />
  );
}

/**
 * The interactive item list.
 *
 * REORDER RENUMBERS THE WHOLE LIST, deliberately. `content.items` is a list of
 * entity summaries and carries no curated position, so the midpoint a drag
 * would normally send cannot be computed from what the client holds — after
 * one reorder the real positions are floats the client never saw, and any
 * index-derived guess lands the row somewhere else. Renumbering 1..N is the
 * only ordering this client can produce that is CORRECT rather than usually
 * right, and it has the side benefit of returning positions to canonical form.
 * The cost is one write per item; curated lists are small, and the honest
 * cheaper fix is a bulk reorder operation, not a cleverer guess here.
 *
 * The list is optimistic: it reorders locally first so the row lands under the
 * cursor, and restores the previous order if the writes reject. Waiting for N
 * round trips before moving anything would make a drag feel broken.
 */
function ManagedItems({
  collectionId,
  spaceId,
  items,
  manage,
  tree,
  onOpenEntity,
  commands,
  reads,
}: {
  collectionId: string;
  spaceId: string;
  items: readonly EntitySummary[];
  manage: boolean;
  tree: boolean;
  onOpenEntity?: (id: string) => void;
  commands?: Partial<CollectionItemCommands> | null;
  reads?: CollectionItemReads | null;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * The optimistic view, STAMPED WITH THE SERVER STATE IT WAS BUILT ON.
   *
   * The `base` is what makes this correct. An optimistic list cannot be
   * validated by comparing it to the server's — a remove and a reorder both
   * make them differ ON PURPOSE, so any such comparison throws away the very
   * update it was meant to protect. (It did: an earlier form here kept the
   * copy only while the lengths matched, which silently discarded every
   * optimistic REMOVE and put the row straight back.)
   *
   * So the copy is held against the snapshot it was derived from, and dropped
   * the moment the server's own list changes — which is exactly when the echo
   * has landed and server truth should win.
   */
  const [optimistic, setOptimistic] = useState<
    { base: string; rows: readonly EntitySummary[] } | null
  >(null);
  const serverIds = items.map((i) => i.id).join(',');
  const shown = optimistic && optimistic.base === serverIds ? optimistic.rows : items;
  const setOrder = (rows: readonly EntitySummary[] | null): void => {
    setOptimistic(rows === null ? null : { base: serverIds, rows });
  };

  async function commitOrder(next: readonly EntitySummary[]): Promise<void> {
    const previous = shown;
    setOrder(next);
    setBusy(true);
    setFailure(null);
    try {
      // Sequential, not concurrent: these all write the same collection, and
      // firing them together lets the server interleave them into an order
      // that is not the one dropped.
      for (let i = 0; i < next.length; i += 1) {
        await commands?.addCollectionItem?.(collectionId, {
          entityId: next[i]!.id,
          position: i + 1,
        });
      }
    } catch (error) {
      setOrder(previous);
      setFailure(reorderFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    const previous = shown;
    setOrder(previous.filter((i) => i.id !== id));
    setBusy(true);
    setFailure(null);
    try {
      await commands?.removeCollectionItem?.(collectionId, id);
    } catch (error) {
      setOrder(previous);
      setFailure(removeFailure(error));
    } finally {
      setBusy(false);
    }
  }

  function drop(targetId: string): void {
    if (!dragging || dragging === targetId) return;
    const from = shown.findIndex((i) => i.id === dragging);
    const to = shown.findIndex((i) => i.id === targetId);
    setDragging(null);
    if (from < 0 || to < 0) return;
    const next = [...shown];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    void commitOrder(next);
  }

  async function add(entity: EntitySummary): Promise<void> {
    setPicking(false);
    setBusy(true);
    setFailure(null);
    try {
      // No `position`: append is the server's to resolve. See the seam doc —
      // a client that computes max+1 races every other client appending.
      await commands?.addCollectionItem?.(collectionId, { entityId: entity.id });
    } catch (error) {
      setFailure(addFailure(entity.title, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pn-itemlist" data-testid="collection-items">
      {manage && reads ? (
        picking ? (
          <CollectionPicker
            spaceId={spaceId}
            excludeIds={shown.map((i) => i.id)}
            label="Add to this collection"
            reads={reads}
            onPick={add}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <button
            type="button"
            className="pn-itemlist__add"
            disabled={busy}
            onClick={() => setPicking(true)}
          >
            ＋ Add items
          </button>
        )
      ) : null}
      {failure ? <p className="pn-section__error" role="status">{failure}</p> : null}
      {shown.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          manage={manage}
          tree={tree}
          busy={busy}
          onOpenEntity={onOpenEntity}
          onRemove={() => void remove(item.id)}
          onDragStart={() => setDragging(item.id)}
          onDropOn={() => drop(item.id)}
          reads={reads}
        />
      ))}
    </div>
  );
}

/**
 * One row, with its own expansion state.
 *
 * Children load LAZILY and once. A collection can hold anything, so eagerly
 * resolving every row's subtree would issue a request per member on open — for
 * a list whose whole purpose is to be long.
 */
function ItemRow({
  item,
  manage,
  tree,
  busy,
  onOpenEntity,
  onRemove,
  onDragStart,
  onDropOn,
  reads,
}: {
  item: EntitySummary;
  manage: boolean;
  tree: boolean;
  busy: boolean;
  onOpenEntity?: (id: string) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDropOn: () => void;
  reads?: CollectionItemReads | null;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<EntitySummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  // A row is expandable only if something could actually be under it. Without
  // a reader wired there is nothing to fetch, so no caret is drawn rather than
  // one that expands into a permanent blank.
  const expandable = tree && Boolean(reads);

  async function toggle(): Promise<void> {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (children || loading || !reads) return;
    setLoading(true);
    try {
      // Structural, not kind-keyed: a nested collection's members live in its
      // own `content.items`, everything else's live in the hierarchy. Asking
      // the detail first and falling back keeps the kind literal out of here.
      const detail = await reads.entity(item.id);
      const nested = (detail.content as unknown as Record<string, unknown>).items;
      if (Array.isArray(nested)) {
        setChildren(nested as EntitySummary[]);
      } else {
        const page = await reads.children(item.id);
        setChildren(page.items);
      }
    } catch {
      // An expansion that cannot load says so by staying empty with a reason,
      // never by throwing through the panel.
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pn-item">
      <div
        className="pn-item__row"
        draggable={manage}
        onDragStart={manage ? onDragStart : undefined}
        onDragOver={manage ? (e) => e.preventDefault() : undefined}
        onDrop={manage ? (e) => { e.preventDefault(); onDropOn(); } : undefined}
      >
        {expandable ? (
          <button
            type="button"
            className="pn-item__caret"
            aria-expanded={open}
            aria-label={open ? `Collapse ${item.title}` : `Expand ${item.title}`}
            onClick={() => void toggle()}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : null}
        <Chip glyph={getKind(item.kind).chip.glyph} onClick={() => onOpenEntity?.(item.id)}>
          {item.title}
        </Chip>
        {manage ? (
          <button
            type="button"
            className="pn-item__remove"
            aria-label={`Remove ${item.title} from this collection`}
            disabled={busy}
            onClick={onRemove}
          >
            ×
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="pn-item__children">
          {loading ? <p className="pn-section__empty">Loading…</p> : null}
          {!loading && (children?.length ?? 0) === 0
            ? <p className="pn-section__empty">Nothing under this.</p>
            : null}
          {(children ?? []).map((child) => (
            <Chip
              key={child.id}
              glyph={getKind(child.kind).chip.glyph}
              onClick={() => onOpenEntity?.(child.id)}
            >
              {child.title}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * L6: name what failed and what the user can do, never a raw transport string.
 * The two are separate sentences because the recoveries differ — a rejected
 * reorder has been rolled back and can be retried, a rejected remove leaves
 * the item exactly where it was.
 */
function reorderFailure(error: unknown): string {
  return `Could not save the new order (${errorSentence(error)}). The list has been put back.`;
}

function addFailure(title: string, error: unknown): string {
  return `Could not add "${title}" (${errorSentence(error)}). Nothing was changed.`;
}

function removeFailure(error: unknown): string {
  return `Could not remove that item (${errorSentence(error)}). It is still in the collection.`;
}

function errorSentence(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'the server refused';
}

/** LIFECYCLE — status + version provenance (template key/version/hash). */
function LifecycleBlock({ detail }: { detail: EntityDetail }) {
  const content = detail.content as unknown as Record<string, unknown>;
  const parts = [
    renderScalar(content.templateKey),
    renderScalar(content.templateVersion),
    renderScalar(content.resolvedHash),
  ].filter((v): v is string => v != null);
  if (parts.length === 0) return null;
  return <p className="pn-lifecycle">{parts.join(' · ')}</p>;
}

/** NOTICE — a static honest explanation of why a region is empty or limited. */
function NoticeBlock({ block }: { block: ContentBlockRef }) {
  const text = typeof block.params?.text === 'string' ? block.params.text : null;
  if (!text) return null;
  return <p className="pn-notice">{text}</p>;
}

// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Scalars only. `null` returns null (the row is skipped) rather than the
 * string "null" — a missing value is not a value, and printing "null" into a
 * field table is the small end of the same dishonesty as printing "0" for
 * unmeasured presence.
 */
function renderScalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}
