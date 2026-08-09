import { useState } from 'react';
import type {
  ArtifactPreviewSession,
  ArtifactsPreviewStartInput,
  CommandResult,
  EntityDetail,
  EntitySummary,
} from '@tm8/contract';
import type { ContentBlockRef } from '../../domain';
import { KindIcon } from '../../domain';
import { Chip, Eyebrow, Markdown } from '../../kit';
import { canThumbnail } from '../../files/AttachmentStrip';
import type { DownloadHref } from '../../files/FilesScreen';
import { EmptyBody } from '../detail/PanelStates';
import type { AuthoringCommands } from '../../authoring';
import { LoopControls } from '../../loops/LoopControls';
import { PeerRowsBlock } from './PeerRowsBlock';
import { edgesOf } from './MemorySetBlock';

/**
 * The one command this body can execute (threaded from the host's seam
 * assignment, like `AuthoringCommands`): mint a preview capability so the
 * artifact-preview block's Run button renders the bundle. Structural subset
 * of `Seam['commands']` — a host assigns `seam.commands` with no cast.
 */
export interface ArtifactPreviewCommands {
  previewArtifact(id: string, input: ArtifactsPreviewStartInput): Promise<ArtifactPreviewSession>;
}

type GenericBodyCommands = Partial<
  ArtifactPreviewCommands & Pick<AuthoringCommands, 'patchEntity'>
>;

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
  onSaved,
  downloadHref,
}: {
  detail: EntityDetail;
  blocks: readonly ContentBlockRef[];
  onOpenEntity?: (id: string) => void;
  commands?: GenericBodyCommands | null;
  onSaved?: (result: CommandResult) => void;
  /**
   * Resolves a file entity's bytes URL, from the host's attachment port — the
   * SAME resolver the attachment strip uses, so a file previews here exactly
   * when it thumbnails there. Absent ⇒ `file-preview` says it cannot fetch,
   * rather than building a URL this lane has no right to build.
   */
  downloadHref?: DownloadHref;
}) {
  if (blocks.length === 0) {
    return (
      <div className="pn-body">
        <EmptyBody
          glyph={<KindIcon kind={detail.kind} />}
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
          onSaved={onSaved}
          downloadHref={downloadHref}
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
  onSaved,
  downloadHref,
}: {
  detail: EntityDetail;
  block: ContentBlockRef;
  onOpenEntity?: (id: string) => void;
  commands?: GenericBodyCommands | null;
  onSaved?: (result: CommandResult) => void;
  downloadHref?: DownloadHref;
}) {
  const body = (() => {
    switch (block.block) {
      case 'fields':
        return <FieldsBlock detail={detail} />;
      case 'link-summary':
        return <LinkSummaryBlock detail={detail} />;
      case 'file-preview':
        return <FilePreviewBlock detail={detail} downloadHref={downloadHref} />;
      case 'artifact-preview':
        return <ArtifactPreviewBlock detail={detail} previewArtifact={commands?.previewArtifact} />;
      case 'loop-controls':
        return (
          <LoopControls
            detail={detail}
            commands={commands?.patchEntity ? { patchEntity: commands.patchEntity } : null}
            onSaved={onSaved}
          />
        );
      /* The same extracted block `ProfileBody` and `SubtreeBody` draw — one
         implementation, three bodies. A `loop` is the reason it is here: its
         RUN HISTORY *is* its inbound `triggered_by` edges (086 §4.4, "there is
         no separate run table"), and a loop must live in this body because it
         is the only one handed a command executor for its verbs. */
      case 'peer-rows':
        return (
          <PeerRowsBlock detail={detail} params={block.params ?? {}} onOpenEntity={onOpenEntity} />
        );
      case 'items':
        return <ItemsBlock detail={detail} block={block} onOpenEntity={onOpenEntity} />;
      case 'lifecycle':
        return <LifecycleBlock detail={detail} />;
      case 'notice':
        return <NoticeBlock block={block} />;
      default:
        return null;
    }
  })();
  if (!body) return null;
  /* `params.count` is honoured HERE too, the same way `ProfileBody` honours
     it, and for the same reason: the count is of the very edges the block
     draws below it, so the two can never disagree. A declared parameter this
     body ignored would be a silent lie in registry data. */
  const count = block.params?.count === true && typeof block.params.edgeType === 'string'
    ? edgesOf(detail, block.params).length
    : null;
  const label = block.label != null && count != null ? `${block.label} · ${count}` : block.label;
  return (
    <section className="pn-section" data-testid={`block-${block.block}`}>
      {label ? <Eyebrow faint>{label}</Eyebrow> : null}
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
      {/* A task's body is markdown — checklists, fenced commands, links. Drawn
          as a plain paragraph it came out as literal `##` and `-`, which is
          how the whole panel read for anything an agent wrote. */}
      {prose ? <Markdown source={prose} className="pn-prose" testId="pn-prose" /> : null}
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
 * FILE-PREVIEW — mime-gated, and now it actually PREVIEWS.
 *
 * It used to draw a captioned empty box reading "image preview · image/png"
 * next to the real image it was refusing to fetch — a label claiming the very
 * thing it was not doing. The bytes were always reachable; what was missing was
 * a resolver, because this lane may not build a transport URL itself. It takes
 * one now, from the same host port the attachment strip uses.
 *
 * TWO GATES, both borrowed rather than re-derived:
 *   · `canThumbnail` — the mime is an image AND is not `image/svg+xml`, which
 *     the node refuses to serve inline (stored-XSS guard). One copy of that
 *     rule, in `files/`, so the panel cannot drift from the strip or the server.
 *   · a resolved href — no resolver, or a resolver answering null, means the
 *     bytes are not reachable from this host and the box says so.
 *
 * `content.downloadUrl` stays as a second source because fixtures carry it and
 * a real detail does not; the resolver wins where both exist.
 */
function FilePreviewBlock({
  detail,
  downloadHref,
}: {
  detail: EntityDetail;
  downloadHref?: DownloadHref;
}) {
  const state = detail.state as unknown as Record<string, unknown>;
  const content = detail.content as unknown as Record<string, unknown>;
  const mime = typeof state.mimeType === 'string' ? state.mimeType : '';
  const fallbackUrl = typeof content.downloadUrl === 'string' ? content.downloadUrl : null;
  const href = (downloadHref ? downloadHref(detail.id) : null) ?? fallbackUrl;
  const shown = href !== null && canThumbnail(mime);

  return (
    <div className="pn-preview">
      {shown ? (
        <img
          className="pn-preview__img"
          data-testid="file-preview-image"
          src={href}
          alt={detail.title}
          loading="lazy"
          /* The size guard rides on the element as well as the stylesheet: a
             5000px photo must not blow out a 440px panel column even where
             this component renders without its CSS. */
          style={{ maxWidth: '100%', maxHeight: '360px', objectFit: 'contain' }}
        />
      ) : (
        <div className="pn-preview__box pn-preview__box--none">
          <span className="pn-preview__label">{noPreviewWords(mime, href !== null)}</span>
        </div>
      )}
      {href ? (
        <a className="pn-btn" href={href} download={detail.title}>
          Download ↓
        </a>
      ) : null}
    </div>
  );
}

/**
 * WHY there is no picture, in the caller's own terms. "We can't fetch it here"
 * and "this type has no preview" are different facts, and a single sentence
 * covering both would be true of neither.
 */
function noPreviewWords(mime: string, reachable: boolean): string {
  if (!reachable) return `no download URL for this file here${mime ? ` · ${mime}` : ''}`;
  if (/^image\/svg(\+xml)?$/i.test(mime.trim())) {
    return 'SVG is not shown inline — it is a script-bearing document, not a picture';
  }
  return `no preview for ${mime || 'this type'}`;
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
 * ITEMS — an `EntitySummary` chip list. `params.source` names which content
 * member holds them (defaults to `items`), which is how one block serves
 * collections, equipped spells and a member's work without knowing any of
 * those kinds.
 */
function ItemsBlock({
  detail,
  block,
  onOpenEntity,
}: {
  detail: EntityDetail;
  block: ContentBlockRef;
  onOpenEntity?: (id: string) => void;
}) {
  const content = detail.content as unknown as Record<string, unknown>;
  const key = typeof block.params?.source === 'string' ? block.params.source : 'items';
  const raw = content[key] ?? content.items ?? content.equipped ?? content.work;
  const items: EntitySummary[] = Array.isArray(raw) ? (raw as EntitySummary[]) : [];

  if (items.length === 0) {
    // A designed empty, not an accidental one: an empty collection is a real
    // state and must read as "nothing here yet", never as a failed load.
    return <p className="pn-section__empty">Nothing here yet.</p>;
  }
  return (
    <div className="pn-chiprow">
      {items.map((item) => (
        <Chip key={item.id} glyph={<KindIcon kind={item.kind} />} onClick={() => onOpenEntity?.(item.id)}>
          {item.title}
        </Chip>
      ))}
    </div>
  );
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
