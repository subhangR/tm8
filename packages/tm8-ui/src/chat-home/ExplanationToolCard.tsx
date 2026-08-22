import { useId, useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { Mermaid } from '../kit';
import { EntityChip, type ChatEntityResolver } from './EntityChip';
import { extractEntityRefs } from './entity-refs';
import {
  durableOutputToolName,
  explanationPresentation,
  explanationToolName,
  type CodePresentation,
  type GraphPresentation,
} from './explanation-tools';
import { toolFailureReason } from './tool-error';
import type { ProjectedTurnPart } from './turn-model';

type ToolPart = Extract<ProjectedTurnPart, { kind: 'tool' }>;

/**
 * The reason line under a failed card's status.
 *
 * Rendered ONLY on error, and only when the payload actually carried a reason
 * — an empty reason line would be worse than none, implying the surface knows
 * something it does not. See `tool-error.ts` for why this exists at all.
 */
function FailureReason({ result }: { result: unknown }) {
  const reason = toolFailureReason(result);
  if (!reason) return null;
  return (
    <p className="tch-explain__failure" data-testid="tool-failure-reason">
      {reason.code ? <code className="tch-explain__failure-code">{reason.code}</code> : null}
      <span>{reason.message}</span>
    </p>
  );
}

export interface ExplanationToolCardProps {
  part: ToolPart;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
}

/** Returns null for ordinary tools so TurnParts can use its generic fallback. */
export function ExplanationToolCard(props: ExplanationToolCardProps) {
  const { part } = props;
  const explainName = explanationToolName(part.name);
  const durableName = durableOutputToolName(part.name);
  if (!explainName && !durableName) return null;

  if (durableName) return <DurableOutputCard {...props} name={durableName} />;
  const presentation = explanationPresentation(part.name, part.args, part.result);
  return (
    <ExplanationFrame part={part}>
      {presentation?.kind === 'diagram' ? (
        <section className="tch-explain__body" data-testid="explain-diagram">
          <PresentationHeading title={presentation.title} eyebrow="Mermaid diagram" />
          <Mermaid source={presentation.source} testId="chat-mermaid" />
          {presentation.caption ? <p className="tch-explain__caption">{presentation.caption}</p> : null}
          <details className="tch-explain__source">
            <summary>View Mermaid source</summary>
            <pre><code>{presentation.source}</code></pre>
          </details>
        </section>
      ) : presentation?.kind === 'graph' ? (
        <GraphCard
          graph={presentation}
          onOpenEntity={props.onOpenEntity}
        />
      ) : presentation?.kind === 'code' ? (
        <CodeCard code={presentation} />
      ) : presentation?.kind === 'asset' ? (
        <AssetCard
          asset={presentation}
          href={props.assetHref?.(presentation.fileEntityId as EntityId) ?? null}
          onOpenEntity={props.onOpenEntity}
        />
      ) : (
        <div className="tch-explain__pending" role="status">
          {part.state === 'error'
            ? 'This presentation could not be prepared.'
            : explainName === 'explain_code'
              ? 'Reading the exact code excerpt…'
              : explainName === 'explain_asset'
                ? 'Resolving the file preview…'
                : 'Preparing the presentation…'}
          {part.state === 'error' ? <FailureReason result={part.result} /> : null}
        </div>
      )}
    </ExplanationFrame>
  );
}

/**
 * These cards are CONTENT, not tool calls — a diagram, a code excerpt, a file,
 * a durable document — so they survive the removal of the tool boxes. What does
 * NOT survive is the tool chrome they wore: an `explain_diagram completed`
 * header and a "Tool details" payload dump. That is exactly what the transcript
 * is now rid of everywhere else, and keeping it here would leave the rule true
 * only where it was easy to keep. Nothing informative went with it — each body
 * already states its own pending and error wording, and `data-state` still
 * carries the state to CSS.
 */
function ExplanationFrame({
  part,
  children,
}: {
  part: ToolPart;
  children: React.ReactNode;
}) {
  return (
    <article className="tch-explain" data-state={part.state} data-testid="chat-explanation-card">
      {children}
    </article>
  );
}

function PresentationHeading({ title, eyebrow }: { title: string; eyebrow: string }) {
  return (
    <header className="tch-explain__heading">
      <span>{eyebrow}</span>
      <h3>{title}</h3>
    </header>
  );
}

function GraphCard({
  graph,
  onOpenEntity,
}: {
  graph: GraphPresentation;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const markerSeed = useId().replace(/[^a-z0-9_-]/gi, '');
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const persistedMarker = `${markerSeed}-persisted`;
  const inferredMarker = `${markerSeed}-inferred`;
  const pendingMarker = `${markerSeed}-pending`;
  return (
    <section className="tch-explain__body" data-testid="explain-graph">
      <PresentationHeading title={graph.title} eyebrow="Focused graph" />
      <div className="tch-xgraph__legend" aria-label="Relationship legend">
        <span data-basis="persisted">solid · persisted tm8 relationship</span>
        <span data-basis="inferred">dashed · agent-inferred explanation</span>
        {!graph.verified ? <span data-basis="pending">dotted · awaiting verification</span> : null}
      </div>
      <div className="tch-xgraph__stage">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`${graph.title}. ${graph.nodes.length} nodes and ${graph.edges.length} relationships.`}
          data-testid="explanation-graph-svg"
        >
          <defs>
            <marker id={persistedMarker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" />
            </marker>
            <marker id={inferredMarker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" />
            </marker>
            <marker id={pendingMarker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" />
            </marker>
          </defs>
          <g className="tch-xgraph__edges">
            {layout.edges.map((edge, index) => {
              const marker = edge.basis === 'persisted'
                ? persistedMarker
                : edge.basis === 'inferred' ? inferredMarker : pendingMarker;
              return (
                <g key={`${edge.from}:${edge.to}:${index}`} data-basis={edge.basis}>
                  <path d={edge.path} markerEnd={`url(#${marker})`} />
                  <text x={edge.labelX} y={edge.labelY}>{shorten(edge.label, 30)}</text>
                  <title>
                    {edge.basis === 'persisted'
                      ? `Persisted tm8 relationship: ${edge.label}`
                      : edge.basis === 'inferred'
                        ? `Agent-inferred explanatory link: ${edge.label}`
                        : `Persisted relationship awaiting verification: ${edge.label}`}
                  </title>
                </g>
              );
            })}
          </g>
          <g className="tch-xgraph__nodes">
            {layout.nodes.map((placed) => {
              const interactive = Boolean(placed.entityId && onOpenEntity);
              const open = () => {
                if (placed.entityId) onOpenEntity?.(placed.entityId as EntityId);
              };
              return (
                <g
                  key={placed.id}
                  transform={`translate(${placed.x}, ${placed.y})`}
                  data-entity={placed.entityId ? 'true' : undefined}
                  data-focus={placed.id === graph.focusNodeId ? 'true' : undefined}
                  role={interactive ? 'button' : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  onClick={interactive ? open : undefined}
                  onKeyDown={interactive ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      open();
                    }
                  } : undefined}
                >
                  <rect width={layout.nodeWidth} height={layout.nodeHeight} rx="7" />
                  <text className="tch-xgraph__node-label" x={layout.nodeWidth / 2} y="23">
                    {shorten(placed.label, 24)}
                  </text>
                  <text className="tch-xgraph__node-kind" x={layout.nodeWidth / 2} y="40">
                    {placed.entityId ? placed.kind ?? 'tm8 entity' : placed.kind ?? 'concept'}
                  </text>
                  <title>{placed.description ?? placed.label}{placed.entityId ? ' — open tm8 entity' : ' — explanatory concept'}</title>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {graph.caption ? <p className="tch-explain__caption">{graph.caption}</p> : null}
    </section>
  );
}

function CodeCard({ code }: { code: CodePresentation }) {
  const [expanded, setExpanded] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'unavailable'>('idle');
  const lines = code.code.split('\n');
  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      setCopyState('unavailable');
      return;
    }
    void clipboard.writeText(code.code).then(
      () => setCopyState('copied'),
      () => setCopyState('unavailable'),
    );
  };
  return (
    <section className="tch-explain__body tch-code" data-testid="explain-code">
      <div className="tch-code__head">
        <PresentationHeading
          title={code.title}
          eyebrow={code.sourceKind === 'repository' ? 'Repository excerpt' : 'Illustrative code'}
        />
        <div className="tch-code__actions">
          <span>{code.language}</span>
          <button type="button" onClick={copy}>{copyState === 'idle' ? 'Copy' : copyState}</button>
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>
      {code.path ? (
        <div className="tch-code__path">
          <code>{code.path}</code>
          <span>lines {code.startLine}–{code.endLine} of {code.totalLines}</span>
        </div>
      ) : null}
      {expanded ? (
        <div className="tch-code__scroll">
          <pre aria-label={`${code.title} source`}>
            <code>
              {lines.map((line, index) => {
                const lineNumber = code.startLine + index;
                const marks = code.highlights.filter((mark) => (
                  lineNumber >= mark.startLine && lineNumber <= mark.endLine
                ));
                const annotation = marks.find((mark) => mark.label && mark.endLine === lineNumber);
                return (
                  <span className="tch-code__row" data-highlight={marks[0]?.tone} key={lineNumber}>
                    <span className="tch-code__line" aria-hidden>{lineNumber}</span>
                    <span className="tch-code__source">{highlightLine(line, code.language)}</span>
                    {annotation?.label ? (
                      <span className="tch-code__annotation" data-tone={annotation.tone}>{annotation.label}</span>
                    ) : null}
                  </span>
                );
              })}
            </code>
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function AssetCard({
  asset,
  href,
  onOpenEntity,
}: {
  asset: Extract<ReturnType<typeof explanationPresentation>, { kind: 'asset' }>;
  href: string | null;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  if (!asset) return null;
  const image = /^image\//i.test(asset.mimeType) && !/^image\/svg(?:\+xml)?$/i.test(asset.mimeType);
  const audio = /^audio\//i.test(asset.mimeType);
  const video = /^video\//i.test(asset.mimeType);
  return (
    <section className="tch-explain__body tch-asset" data-testid="explain-asset">
      <div className="tch-asset__head">
        <PresentationHeading title={asset.title} eyebrow="tm8 file" />
        {onOpenEntity ? (
          <button type="button" onClick={() => onOpenEntity(asset.fileEntityId as EntityId)}>
            Open entity
          </button>
        ) : null}
      </div>
      {href && image ? <img src={href} alt={asset.alt} loading="lazy" /> : null}
      {href && audio ? <audio src={href} controls preload="metadata" aria-label={asset.alt} /> : null}
      {href && video ? <video src={href} controls preload="metadata" aria-label={asset.alt} /> : null}
      {!href || (!image && !audio && !video) ? (
        <div className="tch-asset__file">
          <span aria-hidden>◇</span>
          <div><strong>{asset.name}</strong><small>{asset.mimeType} · {formatBytes(asset.sizeBytes)}</small></div>
          {href ? <a href={href} target="_blank" rel="noreferrer">Download</a> : <em>bytes unavailable</em>}
        </div>
      ) : null}
      {asset.caption ? <p className="tch-explain__caption">{asset.caption}</p> : null}
    </section>
  );
}

function DurableOutputCard({
  part,
  name,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
}: ExplanationToolCardProps & { name: 'doc_create' | 'doc_update' | 'artifact_create' }) {
  const args = recordOf(part.args);
  const title = stringOf(args?.title) ?? stringOf(args?.name)
    ?? (name === 'artifact_create' ? 'Interactive artifact' : 'Explanation document');
  const description = stringOf(args?.description);
  const refs = extractEntityRefs(part.result, part.args).filter((ref) => !suppressEntityIds?.has(ref.id));
  return (
    <ExplanationFrame part={part}>
      <section className="tch-explain__body tch-durable" data-testid="durable-explanation-output">
        <PresentationHeading
          title={title}
          eyebrow={name === 'artifact_create'
            ? 'Durable interactive artifact'
            : name === 'doc_update' ? 'Durable document update' : 'Durable document'}
        />
        {description ? <p className="tch-explain__caption">{description}</p> : null}
        <span className="tch-durable__state" data-state={part.state}>
          {part.state === 'running'
            ? 'Creating durable output…'
            : part.state === 'error'
              ? name === 'doc_update' ? 'Document was not updated.' : 'Output was not created.'
              : name === 'doc_update' ? 'Document updated.' : 'Durable output created.'}
        </span>
        {part.state === 'error' ? <FailureReason result={part.result} /> : null}
        {refs.length > 0 ? (
          <div className="tch-durable__entities">
            {refs.map((ref) => (
              <EntityChip key={ref.id} refInfo={ref} resolve={resolveEntity} onOpen={onOpenEntity} />
            ))}
          </div>
        ) : null}
      </section>
    </ExplanationFrame>
  );
}


type PlacedGraphNode = GraphPresentation['nodes'][number] & { x: number; y: number };
type PlacedGraphEdge = GraphPresentation['edges'][number] & {
  path: string;
  labelX: number;
  labelY: number;
};

function layoutGraph(graph: GraphPresentation) {
  const width = 760;
  const height = graph.nodes.length > 10 ? 430 : 350;
  const nodeWidth = 142;
  const nodeHeight = 54;
  const centerX = width / 2;
  const centerY = height / 2;
  const focus = graph.focusNodeId ? graph.nodes.find((node) => node.id === graph.focusNodeId) : undefined;
  const orbit = focus ? graph.nodes.filter((node) => node.id !== focus.id) : graph.nodes;
  const nodes: PlacedGraphNode[] = [];
  if (focus) nodes.push({ ...focus, x: centerX - nodeWidth / 2, y: centerY - nodeHeight / 2 });
  orbit.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(orbit.length, 1);
    const ring = orbit.length > 10 && index % 2 === 1 ? 0.72 : 1;
    const radiusX = (width / 2 - nodeWidth / 2 - 24) * ring;
    const radiusY = (height / 2 - nodeHeight / 2 - 24) * ring;
    nodes.push({
      ...node,
      x: centerX + Math.cos(angle) * radiusX - nodeWidth / 2,
      y: centerY + Math.sin(angle) * radiusY - nodeHeight / 2,
    });
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: PlacedGraphEdge[] = graph.edges.flatMap((edge) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) return [];
    const sx = source.x + nodeWidth / 2;
    const sy = source.y + nodeHeight / 2;
    const tx = target.x + nodeWidth / 2;
    const ty = target.y + nodeHeight / 2;
    const self = source.id === target.id;
    return [{
      ...edge,
      path: self
        ? `M ${sx} ${sy - nodeHeight / 2} C ${sx + 70} ${sy - 95}, ${sx - 70} ${sy - 95}, ${sx - 4} ${sy - nodeHeight / 2}`
        : `M ${sx} ${sy} L ${tx} ${ty}`,
      labelX: self ? sx : (sx + tx) / 2,
      labelY: self ? sy - 84 : (sy + ty) / 2 - 7,
    }];
  });
  return { width, height, nodeWidth, nodeHeight, nodes, edges };
}

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'fn', 'for', 'from', 'function',
  'if', 'implements', 'import', 'in', 'interface', 'let', 'match', 'new', 'null', 'of',
  'package', 'private', 'protected', 'public', 'return', 'static', 'struct', 'super', 'switch',
  'this', 'throw', 'trait', 'true', 'try', 'type', 'undefined', 'use', 'var', 'while', 'yield',
]);

function highlightLine(line: string, language: string): React.ReactNode {
  if (language === 'text' || language === 'markdown') return line;
  const expression = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|#.*$|\/\*.*?\*\/|\b(?:\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b)/g;
  const output: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) output.push(line.slice(cursor, index));
    const value = match[0];
    const token = /^['"`]/.test(value)
      ? 'string'
      : /^(?:\/\/|#|\/\*)/.test(value)
        ? 'comment'
        : /^\d/.test(value)
          ? 'number'
          : KEYWORDS.has(value) ? 'keyword' : 'name';
    output.push(<span className={`tch-code__tok--${token}`} key={`${index}:${value}`}>{value}</span>);
    cursor = index + value.length;
  }
  if (cursor < line.length) output.push(line.slice(cursor));
  return output;
}



function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function recordOf(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function stringOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

