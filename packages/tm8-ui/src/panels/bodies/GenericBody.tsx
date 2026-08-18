import { useEffect, useState } from 'react';
import type {
  ArtifactPreviewSession,
  ArtifactsPreviewStartInput,
  CommandResult,
  EntityDetail,
  EntitySummary,
} from '@tm8/contract';
import type { ArtifactRevisionsList, ArtifactRevisionSummary } from '../../data/seam';
import type { ContentBlockRef } from '../../domain';
import { KindIcon } from '../../domain';
import { Chip, Eyebrow, Markdown } from '../../kit';
import { canThumbnail } from '../../files/AttachmentStrip';
import type { DownloadHref } from '../../files/FilesScreen';
import { EmptyBody } from '../detail/PanelStates';
import type { AuthoringCommands } from '../../authoring';
import { LoopControls } from '../../loops/LoopControls';
import { BlueprintBlock } from './BlueprintBlock';
import { PeerRowsBlock } from './PeerRowsBlock';
import { edgesOf } from './MemorySetBlock';
import { MembershipBlock, type MembershipAuthoring } from './MembershipBlock';
import type { EntityListPanelProps } from '../EntityListPanel';

/**
 * The artifact viewer's port (threaded from the host's seam assignment, like
 * `AuthoringCommands`): mint a preview capability, list the published
 * revisions, and fetch a revision's zip bytes. Structural subset of
 * `Seam['commands']` — a host assigns `seam.commands` with no cast.
 */
export interface ArtifactPreviewCommands {
  previewArtifact(id: string, input: ArtifactsPreviewStartInput): Promise<ArtifactPreviewSession>;
  /** Amendment 12 pair — the revision switcher's read and download's bytes. */
  listArtifactRevisions(id: string): Promise<ArtifactRevisionsList>;
  exportArtifactRevision(id: string, revisionNumber: number): Promise<Blob>;
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
  membership,
  membersHost,
}: {
  detail: EntityDetail;
  blocks: readonly ContentBlockRef[];
  onOpenEntity?: (id: string) => void;
  commands?: GenericBodyCommands | null;
  onSaved?: (result: CommandResult) => void;
  /**
   * Authoring for the `membership` block — the same intent-only split the
   * subtree body uses for its sections. Absent ⇒ read-only, never dead
   * controls.
   */
  membership?: MembershipAuthoring | null;
  /**
   * The list-tile host for the membership block's OUTGOING side, composed
   * once by the detail panel — see `MembershipBlock.itemsHost`. Absent ⇒
   * members render as chips.
   */
  membersHost?: EntityListPanelProps | null;
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
          membership={membership}
          membersHost={membersHost}
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
  membership,
  membersHost,
}: {
  detail: EntityDetail;
  block: ContentBlockRef;
  onOpenEntity?: (id: string) => void;
  commands?: GenericBodyCommands | null;
  onSaved?: (result: CommandResult) => void;
  downloadHref?: DownloadHref;
  membership?: MembershipAuthoring | null;
  membersHost?: EntityListPanelProps | null;
}) {
  const body = (() => {
    switch (block.block) {
      case 'fields':
        return <FieldsBlock detail={detail} />;
      case 'link-summary':
        return <LinkSummaryBlock detail={detail} />;
      case 'file-preview':
        return <FilePreviewBlock detail={detail} downloadHref={downloadHref} />;
      /* The blueprint canvas, folded from the row itself — see its docblock
         for why it needs nothing from the host but `onOpenEntity`. */
      case 'blueprint':
        return <BlueprintBlock detail={detail} onOpenEntity={onOpenEntity} />;
      case 'artifact-preview':
        /* Keyed by entity id: a panel that re-points to another artifact must
           reset the viewer's whole run state (selected revision, mint timer,
           fullscreen) rather than mint the OLD artifact's revision number
           against the new id. */
        return <ArtifactPreviewBlock key={detail.id} detail={detail} commands={commands ?? undefined} />;
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
      /* Collection membership over `contains`, writeable (add/remove) when the
         host wires authoring — the collection row's ITEMS is this block with
         `direction: 'outgoing'`. The inert `items` chip list above remains for
         content members that are genuinely read-only (equipped spells, a
         member's work). */
      case 'membership':
        return (
          <MembershipBlock
            detail={detail}
            params={block.params ?? {}}
            onOpenEntity={onOpenEntity}
            authoring={membership}
            itemsHost={membersHost}
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

/** Re-mint this far before the capability lapses, so the frame never dies mid-view. */
const REMINT_MARGIN_MS = 60_000;
/**
 * Floor under the re-mint delay. A session can arrive already inside the
 * margin — or already past it (the fixture's deterministic clock is in the
 * past by construction) — and a delay clamped to zero would re-mint in a
 * tight loop rather than on a cadence.
 */
const REMINT_FLOOR_MS = 30_000;

/**
 * The server's own zip naming (`zipFilename`), mirrored so the two agree.
 * The empty-name fallback deliberately differs from the server's — §15.2
 * bans quoted kind literals in this file, and a filename is not worth an
 * exemption in the scanner.
 */
function zipFilename(name: string, revisionNumber: number): string {
  const base = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/]/g, '_').trim().slice(0, 80) || 'bundle';
  return `${base}-r${revisionNumber}.zip`;
}

/**
 * ARTIFACT VIEWER — the rendered bundle, in-block, under one thin row of the
 * controls that act on it (revision, restart, fullscreen, download).
 *
 * THE BLOCK IS THE FRAME (owner ruling 2026-08-18). It used to open with a
 * bordered banner carrying the publisher line and the third-party caution, and
 * the section above it carried a `PREVIEW` eyebrow — together ~200px of a panel
 * whose entire purpose is the page below. Both are gone; the sentence they
 * carried moved onto the frame's own `title`, which is the accessible name of
 * the element actually running the code (see `frameTitle`).
 *
 * AUTORUNS when the detail opens (owner ruling 2026-08-16, superseding the
 * §9.5 click-gate; the block mounts only inside the artifact DETAIL panel, so
 * list and feed tiles still execute nothing). The sandbox posture is
 * UNCHANGED and is the whole security model: `sandbox="allow-scripts"` and
 * NOTHING else — never `allow-same-origin` (with allow-scripts a frame could
 * strip its own sandbox), never top-navigation/popups/downloads/forms/modals.
 * `previewUrl` is an OPAQUE server-minted capability used verbatim: this file
 * never parses or builds one, and it renders from whatever origin the node
 * chose — the block cannot tell and must not care. A node that answers
 * without `previewUrl` gets the refusal text, never a broken frame; a mount
 * with no command executor says so in words.
 *
 * The capability expires (~600s), so a successful mint schedules its own
 * replacement at `expiresAt` minus a margin and swaps the frame src in place —
 * a panel left open must still show a live page, not a silently dead one.
 *
 * The accepted residual (TM8-ARTIFACTS-DESIGN §12.1): a hostile bundle can
 * draw a pixel-perfect fake tm8 login and POST keystrokes anywhere — open
 * network inside the frame is server policy. The publisher line and the
 * third-party wording are the compensating control for exactly that; they now
 * ride the frame's accessible name instead of a banner, so they are reachable
 * on the element at risk rather than merely adjacent to it.
 */
function ArtifactPreviewBlock({
  detail,
  commands,
}: {
  detail: EntityDetail;
  commands?: GenericBodyCommands;
}) {
  const previewArtifact = commands?.previewArtifact;
  const listArtifactRevisions = commands?.listArtifactRevisions;
  const exportArtifactRevision = commands?.exportArtifactRevision;

  const state = detail.state as unknown as Record<string, unknown>;
  const content = detail.content as unknown as Record<string, unknown>;
  const description = typeof content.description === 'string' ? content.description : null;
  const currentRevision = typeof state.revisionNumber === 'number' ? state.revisionNumber : null;
  const fileCount = typeof content.fileCount === 'number' ? content.fileCount : null;
  const totalBytes = typeof content.totalSizeBytes === 'number' ? content.totalSizeBytes : null;

  const [run, setRun] = useState<
    | { phase: 'starting' }
    | { phase: 'running'; previewUrl: string; revisionNumber: number }
    | { phase: 'error'; message: string }
  >({ phase: 'starting' });
  /** `null` = the artifact's current revision (the server's default). */
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [revisions, setRevisions] = useState<ArtifactRevisionSummary[] | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);

  useEffect(() => {
    if (!previewArtifact) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `revisionToRequest` is undefined ONLY on the very first mint of a
    // latest-revision view — the server resolves "current" once, and every
    // TTL re-mint then PINS the revision that answer named. Without the pin,
    // a concurrent publish would make a background re-mint silently swap the
    // page under the viewer; tracking latest stays an explicit act (the
    // switcher, or Restart). Under React StrictMode's dev double-mount the
    // first mint runs twice — the orphaned session is never rendered and the
    // server reaps it at TTL, so no cleanup path is owed here.
    const mint = async (revisionToRequest: number | undefined, isFirst: boolean) => {
      if (isFirst) setRun({ phase: 'starting' });
      try {
        const session = await previewArtifact(detail.id, {
          clientMutationId: crypto.randomUUID(),
          ...(revisionToRequest != null ? { revisionNumber: revisionToRequest } : {}),
        });
        if (cancelled) return;
        if (!session.previewUrl) {
          setRun({ phase: 'error', message: 'This node did not mint a preview URL, so the bundle cannot be rendered here.' });
          return;
        }
        setRun({ phase: 'running', previewUrl: session.previewUrl, revisionNumber: session.revisionNumber });
        // A re-mint keeps the frame alive across the TTL; on failure the
        // catch below reports it instead of leaving a dead frame that still
        // looks rendered. A malformed expiresAt falls to the floor cadence
        // rather than to setTimeout(NaN)'s run-now loop.
        const untilMargin = Date.parse(session.expiresAt) - Date.now() - REMINT_MARGIN_MS;
        timer = setTimeout(
          () => void mint(session.revisionNumber, false),
          Number.isFinite(untilMargin) ? Math.max(untilMargin, REMINT_FLOOR_MS) : REMINT_FLOOR_MS,
        );
      } catch (err) {
        if (!cancelled) setRun({ phase: 'error', message: err instanceof Error ? err.message : 'preview could not be started' });
      }
    };
    void mint(selectedRevision ?? undefined, true);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [detail.id, selectedRevision, restartNonce, previewArtifact]);

  useEffect(() => {
    if (!listArtifactRevisions) return;
    let cancelled = false;
    listArtifactRevisions(detail.id).then(
      (page) => { if (!cancelled) setRevisions(page.revisions); },
      // A failed history read degrades to "no switcher", not to a dead viewer:
      // the frame renders from the current revision either way.
      () => { if (!cancelled) setRevisions(null); },
    );
    return () => { cancelled = true; };
  }, [detail.id, listArtifactRevisions]);

  useEffect(() => {
    if (!fullscreen) return;
    // Keydown reaches this document only while focus sits OUTSIDE the frame —
    // a cross-origin sandboxed iframe swallows its own keys and cannot be
    // listened into. The Exit-fullscreen button stays visible for that case.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  /**
   * The one revision number the whole chrome speaks with — and the one
   * Download fetches. When a frame is live this is the MINT-TIME revision
   * (`run.revisionNumber`), never the detail-fetch-time state: the two can
   * diverge across a concurrent publish, and a download that disagrees with
   * the page on screen is the review finding this line closes (F1).
   */
  const shownRevision = run.phase === 'running' ? run.revisionNumber : selectedRevision ?? currentRevision;

  const onDownload = async () => {
    if (!exportArtifactRevision) return;
    const revisionNumber = shownRevision;
    if (revisionNumber == null) return;
    setExporting(true);
    setExportError(null);
    try {
      const blob = await exportArtifactRevision(detail.id, revisionNumber);
      // RAW BYTES → object URL → anchor click. The URL is revoked immediately:
      // the click has already handed the blob to the download, and a leaked
      // object URL pins the whole zip in memory for the panel's lifetime.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = zipFilename(detail.title, revisionNumber);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'export failed');
    } finally {
      setExporting(false);
    }
  };

  const facts: string[] = [];
  if (fileCount != null) facts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (totalBytes != null) facts.push(formatBytes(totalBytes));

  /**
   * The provenance sentence, now carried by the FRAME rather than by a banner
   * above it (owner ruling 2026-08-18: the chrome was eating the viewport the
   * artifact exists to fill). It is still the accessible name of the very
   * element that runs the third-party code — a screen reader announces it on
   * entry and a pointer surfaces it on hover — so §12.1's compensating control
   * keeps naming the publisher and disowning the content; what it no longer
   * does is claim 200px of a 900px panel to say so on every phase.
   */
  const frameTitle = [
    `artifact preview · ${detail.title}`,
    `published by ${detail.createdBy.displayName} (${detail.createdBy.isAgent ? 'agent' : 'human'})`,
    ...(shownRevision != null ? [`revision ${shownRevision}`] : []),
    ...facts,
    "third-party content — this page is the artifact's own code, not tm8 UI; never enter tm8 credentials into it",
  ].join(' · ');

  return (
    <div className={`pn-preview pn-preview--viewer${fullscreen ? ' pn-preview--fullscreen' : ''}`}>
      <div className="pn-preview__chrome">
        {revisions !== null && revisions.length > 0 ? (
          <select
            className="pn-preview__revpick"
            aria-label="revision"
            value={String(selectedRevision ?? currentRevision ?? revisions[0]!.revisionNumber)}
            onChange={(e) => setSelectedRevision(Number(e.target.value))}
          >
            {revisions.map((r) => (
              <option key={r.revisionNumber} value={String(r.revisionNumber)}>
                {`rev ${r.revisionNumber}${r.revisionNumber === currentRevision ? ' · current' : ''}`}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="pn-btn"
          disabled={previewArtifact === undefined || run.phase === 'starting'}
          title="Mint a fresh preview and reload the frame."
          onClick={() => setRestartNonce((n) => n + 1)}
        >
          {run.phase === 'starting' ? 'Starting…' : 'Restart ▷'}
        </button>
        <button
          type="button"
          className="pn-btn"
          aria-pressed={fullscreen}
          onClick={() => setFullscreen((f) => !f)}
        >
          {fullscreen ? 'Exit fullscreen' : 'Fullscreen ⛶'}
        </button>
        <button
          type="button"
          className="pn-btn"
          disabled={exportArtifactRevision === undefined || exporting || shownRevision == null}
          title={exportArtifactRevision === undefined ? 'Export is not wired here.' : 'Download this revision as a zip.'}
          onClick={() => void onDownload()}
        >
          {exporting ? 'Saving…' : 'Download ⇩'}
        </button>
      </div>
      {previewArtifact === undefined ? (
        <div className="pn-preview__box pn-preview__box--none">
          <span className="pn-preview__label">
            Preview is not wired here — this mount has no command executor, so the bundle stays unexecuted.
          </span>
        </div>
      ) : run.phase === 'running' ? (
        <iframe
          className="pn-preview__frame"
          title={frameTitle}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={run.previewUrl}
        />
      ) : (
        <div className="pn-preview__box pn-preview__box--none">
          <span className="pn-preview__label">
            {run.phase === 'starting' ? 'starting preview…' : run.message}
          </span>
        </div>
      )}
      {description ? <p className="pn-prose">{description}</p> : null}
      {exportError ? <p className="pn-section__empty">{exportError}</p> : null}
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
