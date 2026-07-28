import type { EntityDetail, EntitySummary } from '@tm8/contract';
import type { ContentBlockRef } from '../../domain';
import { getKind } from '../../domain';
import { Chip, Eyebrow } from '../../kit';
import { EmptyBody } from '../detail/PanelStates';

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
}: {
  detail: EntityDetail;
  blocks: readonly ContentBlockRef[];
  onOpenEntity?: (id: string) => void;
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
        <ContentBlock key={`${block.block}:${i}`} detail={detail} block={block} onOpenEntity={onOpenEntity} />
      ))}
    </div>
  );
}

function ContentBlock({
  detail,
  block,
  onOpenEntity,
}: {
  detail: EntityDetail;
  block: ContentBlockRef;
  onOpenEntity?: (id: string) => void;
}) {
  const body = (() => {
    switch (block.block) {
      case 'fields':
        return <FieldsBlock detail={detail} />;
      case 'link-summary':
        return <LinkSummaryBlock detail={detail} />;
      case 'file-preview':
        return <FilePreviewBlock detail={detail} />;
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
        <Chip key={item.id} glyph={getKind(item.kind).chip.glyph} onClick={() => onOpenEntity?.(item.id)}>
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
