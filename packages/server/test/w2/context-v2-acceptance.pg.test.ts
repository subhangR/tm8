/**
 * Entity context v2 — the SHARED acceptance suite (Module 2, step S1).
 *
 * One suite for both agreed specs, per decision 01a0cf2d-8ae0:
 *   - c904 §5 tests 1–10  (budget semantics, doc 01a0cf2e-ba7d-7168-a6cf-9e7ebf912b0b)
 *   - c761 §10 tests 1–9  (the v2 shape,      doc 01a0cf33-c4ac-7588-905d-47880dfca67d)
 * Every test names the spec items it covers as `[c904 §5.N · c761 §10.M]`.
 *
 * It runs the REAL `entities.context` handler (the production facade registry)
 * over a REAL PostgreSQL scratch database, as `tm8_app` with claim-bound RLS,
 * against the pinned fixtures in `context-v2/fixtures.ts`. Database work is
 * measured by S2's `context-statement-counter.ts` (the one counter the module
 * shares), never inferred from output.
 *
 * v2 is requested explicitly with `schema=v2`. S5 made v2 the CLIENT default
 * (the agent-class and text CLI, and MCP, send `schema=v2`); the HTTP default
 * stays v1 for raw and non-agent callers until v1 is retired. Tests the product
 * cannot pass yet are `it.fails`, each naming the step that flips it to `it`:
 *   S2  select-before-load: every section loader tagged, only selected loaded
 *   S3  the v2 DTO, per-kind projection, omitted/notLoaded/errors, section paging
 *   S4  body ceiling, `--sections assignment --offset`, context_budget_too_small
 *   S5  text brief, MCP `expandOp`, rollout
 * A step that flips a test must flip it to plain `it` in the same PR. Every
 * v2 negative test carries a positive control, so no `it.fails` here "passes"
 * today merely because `schema=v2` is still an unknown key.
 *
 * Not covered here (named so the gap is visible):
 *   - c904 §5.7 / c761 §10.7 launch-snapshot equality needs ca8d's snapshot
 *     builder, which is outside Module 2 — `it.todo` below.
 *   - CLI behaviour (exit 2, minified print, `--section-bytes` usage error, the
 *     text brief) lives in `packages/cli/test/entity-context-v2.test.ts`.
 */
import { createHash } from 'node:crypto';

import type { OperationName } from '@tm8/contract';
import { getOperation } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { BODIES, F, IDENTITY, T_ACCEPTANCE, seedContextV2Fixtures } from './context-v2/fixtures.js';
import {
  UNTAGGED,
  contextTagOf,
  countStatements,
  type StatementCounter,
} from './context-statement-counter.js';

// ---------------------------------------------------------------------------
// The v2 contract, as the specs define it (S3 adds the real contract schema)
// ---------------------------------------------------------------------------

interface V2Ref {
  id: string;
  kind?: string;
  title?: string;
  status?: string;
  titleTruncated?: true;
  deleted?: true;
  unreadable?: true;
  resolved?: boolean;
}
interface V2ExpandOp { operation: string; params: Record<string, unknown> }
interface V2Omitted {
  section: string;
  kept: number;
  more: boolean;
  totalAtLeast?: number;
  reason: 'budget' | 'rowLimit' | 'fetchLimit';
  expand: string;
  expandOp?: V2ExpandOp;
}
interface V2NotLoaded { section: string; expand: string; expandOp?: V2ExpandOp }
interface V2Message {
  id: string;
  from?: string;
  fromTruncated?: true;
  at: string;
  text?: string;
  truncated?: true;
  replyTo?: string;
  toMe?: true;
  redacted?: true;
}
interface V2Assignment { text: string; bytes: number; complete: boolean; offset?: number; expand?: string }
interface V2 {
  schemaVersion: string;
  id: string;
  kind: string;
  title: string;
  version: number;
  status: string;
  asOfSeq: number;
  parent?: V2Ref | null;
  priority?: string;
  gate?: 'none' | { kind: 'pr_merged'; prs: Array<{ url: string; state: string; ci: unknown }>; more?: boolean };
  assignees?: Array<{ id: string; name: string; you?: true; by?: string; at?: string }>;
  assignment?: V2Assignment;
  acceptance?: Array<{ id: string; done: boolean; text: string }>;
  blockers?: V2Ref[];
  children?: V2Ref[];
  tasks?: V2Ref[];
  connections?: Array<{ type: string; dir: string; other: V2Ref; resolved?: boolean }>;
  messages?: V2Message[];
  outline?: Array<{ level: number; text: string; offset: number }>;
  agentTool?: string;
  model?: string;
  checkoutBranch?: string;
  startedAt?: string;
  omitted: V2Omitted[];
  notLoaded: V2NotLoaded[];
  errors: Array<{ section: string; code: string; retry: unknown }>;
  budget?: { requested: number; used: number };
  [key: string]: unknown;
}

/** §3.5 / c904 §2.10: every page and every read without `assignment`. */
const HEADER_KEYS = ['schemaVersion', 'id', 'kind', 'title', 'version', 'status', 'asOfSeq'];
const PAGE_ENVELOPE_KEYS = ['omitted', 'notLoaded', 'errors', 'budget'];
/** The list key(s) a section page may carry. */
const SECTION_KEYS: Record<string, string[]> = {
  hierarchy: ['children', 'parent'],
  children: ['children', 'parent'],
  messages: ['messages'],
  blockers: ['blockers'],
  connections: ['connections'],
  assignment: ['assignment', 'acceptance', 'outline'],
};
/**
 * Which `entities.context:<tag>`s load which section. S2 (#673) tags: root,
 * summary, parents, children, edges, messages, activity, seq, actions. The
 * v2-only tags (assignment, acceptance, blockers, connections) are S3's to add;
 * if it spells them differently, this map is the one place to change.
 */
const SECTION_TAGS: Record<string, string[]> = {
  assignment: ['assignment', 'acceptance'],
  hierarchy: ['parents', 'children'],
  children: ['children'],
  connections: ['connections', 'edges'],
  messages: ['messages'],
  actions: ['actions'],
  activity: ['activity'],
  blockers: ['blockers'],
};
/** c761 §3.2/§5: default row limits. */
const LIMIT = { children: 10, blockers: 10, connections: 10, taskMessages: 3, coreMessages: 10 };
/** Code points, the ellipsis INCLUDED (coordinator ruling on #674). */
const TEXT_CAP = { task: 280, core: 500, title: 80, from: 80 };
/** c761 §10.1 / Q28 = A. */
const FIXED_CORE_MAX = 1_024;
const ROW_OVERHEAD_MAX = 200;
const DEFAULT_TOTAL = 16_384;
/**
 * Lists stripped when measuring the fixed core (c761 §10.1, Q28 = A): the
 * minified DTO minus assignment text, acceptance text and EVERY list row —
 * taken literally, so assignees, omitted, notLoaded and errors are emptied too
 * (coordinator ruling on #674).
 */
const ROW_LISTS = [
  'acceptance', 'assignees', 'children', 'blockers', 'tasks', 'connections', 'messages', 'outline',
  'omitted', 'notLoaded', 'errors',
];

const bytes = (value: unknown): number =>
  Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Harness: production registry, real PG, counted statements
// ---------------------------------------------------------------------------

// One shared counter: a test that outlived its timeout would keep issuing reads
// into the next test's count, so the timeout is generous rather than tight.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const OWNER = {
  identityId: IDENTITY,
  accountId: '01a0c000-0000-7000-8000-0000000000fe',
  username: 'ctx-v2-owner',
  isNodeAdmin: false,
  isOwner: true,
};

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;
let counter: StatementCounter;
/** Statements with no `entities.context:<section>` tag (S2 made this zero). */
const untagged = (): string[] => counter.statements.filter((sql) => contextTagOf(sql) === UNTAGGED);

beforeAll(async () => {
  database = await createW1ScratchDatabase('ctx_v2');
  database.apply(migrationFiles());
  await seedContextV2Fixtures(database);
  pgDb = createDb(database.url);
  // Patches `pgDb` in place; the actions palette is tagged by S2's `taggedDb`.
  counter = countStatements(pgDb);
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, {
    db: pgDb,
    config: { host: '127.0.0.1', port: 0, databaseUrl: database.url } as unknown as ServerConfig,
    owner: async () => OWNER,
  });
}, 300_000);

afterAll(async () => {
  await pgDb?.end();
  await database?.destroy();
});

function request(opName: OperationName, params: Record<string, string>, query: URLSearchParams): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params,
    query,
    body: undefined,
    requestId: `ctx-v2-${opName}`,
    identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

async function call<T>(opName: OperationName, params: Record<string, string>, query: URLSearchParams): Promise<T> {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`missing handler: ${opName}`);
  return (await handler(request(opName, params, query))) as T;
}

interface Read<T> { view: T; json: string; bytes: number; statements: number; byTag: Record<string, number>; ms: number }

async function read<T>(id: string, query: string): Promise<Read<T>> {
  counter.reset();
  const started = performance.now();
  const view = await call<T>('entities.context', { id }, new URLSearchParams(query));
  const ms = performance.now() - started;
  const json = JSON.stringify(view);
  return { view, json, bytes: bytes(json), statements: counter.total(), byTag: counter.byTag(), ms };
}

/** A v1 read — today's default, unchanged by Module 2. */
const v1 = (id: string, query = ''): Promise<Read<Record<string, unknown>>> => read(id, query);

/** A v2 read, as the CLI and MCP send it (`schema=v2`; the HTTP default is still v1). */
const v2 = (id: string, query = ''): Promise<Read<V2>> =>
  read<V2>(id, query ? `schema=v2&${query}` : 'schema=v2');

const FLAG_TO_QUERY: Record<string, string> = {
  sections: 'sections',
  cursor: 'cursor',
  offset: 'offset',
  'edge-type': 'edgeType',
  'total-bytes': 'totalBytes',
};

/**
 * Run an advertised `expand` VERBATIM (c904 §2.8: no placeholders, server-filled
 * cursor/offset). The CLI flags are translated one-for-one to the query the
 * CLI would send; an unknown flag fails the test rather than being dropped.
 * `schema=v2` is added because the CLI adds it: since S5 a verbatim expand
 * yields v2 for every `--format json` and text caller with no `--schema` flag
 * (packages/cli/test/entity-context-v2.test.ts pins that argv → query). The
 * HTTP default is v1, so this helper models the CLI's query, not a bare GET.
 */
async function runExpand(expand: string): Promise<Read<V2>> {
  expect(expand, 'an expand never carries a placeholder').not.toMatch(/[<>]/);
  const match = /^tm8 entity context (\S+)((?: --[a-z-]+ \S+)*)$/.exec(expand);
  if (!match) throw new Error(`not a runnable entity-context expand: ${expand}`);
  const query = new URLSearchParams({ schema: 'v2' });
  const tokens = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i]!.replace(/^--/, '');
    const key = FLAG_TO_QUERY[flag];
    if (!key) throw new Error(`expand uses a flag entity context does not take: --${flag}`);
    query.set(key, tokens[i + 1]!);
  }
  return read<V2>(match[1]!, query.toString());
}

/** Run an `expandOp` (MCP, c904 Q19) through the registry, with MCP's `schema=v2` default. */
async function runExpandOp(op: V2ExpandOp): Promise<Read<V2>> {
  const { id, ...rest } = op.params as Record<string, unknown>;
  const query = new URLSearchParams({ schema: 'v2' });
  for (const [key, value] of Object.entries(rest)) {
    query.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  counter.reset();
  const view = await call<V2>(op.operation as OperationName, { id: String(id) }, query);
  const json = JSON.stringify(view);
  return { view, json, bytes: bytes(json), statements: counter.total(), byTag: counter.byTag(), ms: 0 };
}

/** Follow `omitted[section]` pages to the end, collecting rows. */
async function walkSection<R extends { id: string }>(first: V2, section: string, rowsOf: (v: V2) => R[] | undefined): Promise<R[]> {
  const rows = [...(rowsOf(first) ?? [])];
  let entry = first.omitted.find((o) => o.section === section);
  for (let guard = 0; entry?.more && guard < 20; guard += 1) {
    const page = await runExpand(entry.expand);
    assertPageShape(page.view, section);
    const pageRows = rowsOf(page.view) ?? [];
    const limit = section === 'messages' ? LIMIT.coreMessages : LIMIT[section as 'children' | 'blockers' | 'connections'];
    expect(pageRows.length, `${section} page within its row limit`).toBeLessThanOrEqual(limit ?? LIMIT.children);
    rows.push(...pageRows);
    entry = page.view.omitted.find((o) => o.section === section);
  }
  expect(entry?.more ?? false, `${section} pages terminate`).toBe(false);
  return rows;
}

function assertPageShape(view: V2, section: string): void {
  const allowed = new Set([...HEADER_KEYS, ...PAGE_ENVELOPE_KEYS, ...(SECTION_KEYS[section] ?? [section])]);
  for (const key of Object.keys(view)) expect(allowed, `page key ${key} (section ${section})`).toContain(key);
  for (const key of HEADER_KEYS) expect(view, `page header ${key}`).toHaveProperty(key);
  expect(Array.isArray(view.errors)).toBe(true);
}

/** Per-row flags that appear only on some rows (c761 §3.3). */
const OPTIONAL_ROW_FLAGS = new Set(['truncated', 'titleTruncated', 'fromTruncated', 'replyTo', 'toMe', 'deleted', 'redacted']);
const rowShape = (row: object | undefined): string =>
  Object.keys(row ?? {}).filter((k) => !OPTIONAL_ROW_FLAGS.has(k)).sort().join(',');

function fixedCore(view: V2): number {
  const clone = structuredClone(view) as Record<string, unknown>;
  const assignment = clone['assignment'] as V2Assignment | undefined;
  if (assignment) assignment.text = '';
  for (const key of ROW_LISTS) if (Array.isArray(clone[key])) clone[key] = [];
  const gate = clone['gate'];
  if (gate && typeof gate === 'object') (gate as { prs: unknown[] }).prs = [];
  return bytes(clone);
}

/**
 * The body ceiling of one read (c904 §2.4, as S4 formalised it): 16,384 − the
 * DTO with the body text and every list the BUDGET can empty (§2.6) emptied.
 * The never-drop lists (acceptance, notLoaded, errors, a chat's messages…) stay
 * in the envelope: a ceiling that ignored them would make the default read
 * overrun 16,384 B with nothing left to drop. Computed per read, so a page —
 * with no outline or acceptance — has its own, slightly larger ceiling.
 */
function ceilingOf(view: V2): number {
  const envelope = structuredClone(view) as Record<string, unknown>;
  (envelope['assignment'] as V2Assignment).text = '';
  const droppable = view.kind === 'chat' || view.kind === 'work_session'
    ? ['connections', 'children']
    : ['connections', 'children', 'messages'];
  for (const key of droppable) if (Array.isArray(envelope[key])) envelope[key] = [];
  return DEFAULT_TOTAL - bytes(envelope);
}

/** Every `expand` the view advertises: omitted, notLoaded and the body marker. */
function advertisedExpands(view: V2): string[] {
  return [
    ...view.omitted.map((o) => o.expand),
    ...view.notLoaded.map((n) => n.expand),
    ...(view.assignment?.expand ? [view.assignment.expand] : []),
  ];
}

// ---------------------------------------------------------------------------
// Fixture catalogue
// ---------------------------------------------------------------------------

const FIXTURES = [
  { name: 'T (task, 3.5 KB, 4 criteria)', id: F.T, kind: 'task', body: BODIES.T },
  { name: 'P (task, 8 KB, 10 children, 1 msg)', id: F.P, kind: 'task', body: BODIES.P },
  { name: 'D (doc, 40 KB)', id: F.D, kind: 'doc', body: BODIES.D },
  { name: 'X (task, 60 KB)', id: F.X, kind: 'task', body: BODIES.X },
  { name: 'MB (task, multi-byte 40 KB)', id: F.MB, kind: 'task', body: BODIES.MB },
  { name: 'WS (running session, working_on)', id: F.WS, kind: 'work_session', body: null },
  { name: 'CS (coordinator session)', id: F.CS, kind: 'work_session', body: null },
  { name: 'C (chat, 12 messages)', id: F.C, kind: 'chat', body: null },
  { name: 'PJ (project)', id: F.PJ, kind: 'project', body: null },
] as const;
/** Bodies at or under the ~15 KB ceiling (c904 §2.4). */
const SMALL_BODIES = FIXTURES.filter((f) => f.body !== null && bytes(f.body) <= 12_000);
/** Bodies over the ceiling: the continuation fixtures. */
const LARGE_BODIES = FIXTURES.filter((f) => f.body !== null && bytes(f.body) > 20_000);

// ===========================================================================
// v1: baseline and unchanged behaviour (plain `it` — these pass today)
// ===========================================================================

const shown = (view: Record<string, unknown>): string =>
  ['children', 'edges', 'messages'].map((k) => (view[k] as unknown[] | undefined)?.length ?? 0).join('/');

describe('v1 baseline and compatibility (must stay green through S5)', () => {
  it('records the v1 baseline per fixture: minified bytes, ~tok, statements, body complete', async () => {
    const rows: string[] = [
      '| fixture | v1 minified bytes | ~tok | statements (total) | statements by tag | body complete? | rows shown (children/edges/messages) | p50 / p95 ms |',
      '|---|---|---|---|---|---|---|---|',
    ];
    for (const fixture of FIXTURES) {
      const samples: number[] = [];
      let last: Read<Record<string, unknown>> | undefined;
      for (let i = 0; i < 7; i += 1) {
        last = await v1(fixture.id);
        samples.push(last.ms);
      }
      const r = last!;
      const content = r.view['content'] as { excerpt: string; truncated: boolean } | undefined;
      const complete = fixture.body === null
        ? 'n/a'
        : content && !content.truncated && content.excerpt === fixture.body ? 'yes' : 'no';
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length / 2)]!;
      const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!;
      const tags = Object.entries(r.byTag).map(([k, v]) => `${k} ${v}`).join(', ');
      rows.push(
        `| ${fixture.name} | ${r.bytes.toLocaleString('en-US')} | ${Math.round(r.bytes / 4).toLocaleString('en-US')} | ${r.statements} | ${tags} | ${complete} | ${shown(r.view)} | ${p50.toFixed(1)} / ${p95.toFixed(1)} |`,
      );
      expect(r.view['schemaVersion']).toBe('tm8.entity-context.v1');
    }
    // Printed for the PR description; latency is information only (c761 §10.8).
    console.log(`\n[context-v2 baseline] v1 default read, minified server DTO\n${rows.join('\n')}\n`);
  });

  it('pins the v1 defects v2 exists to fix (so a v1 change is loud, not silent)', async () => {
    // c904 §1 root cause 3: P's 8 KB body is cut at the 4,096 B section cap.
    const p = await v1(F.P);
    expect((p.view['content'] as { truncated: boolean }).truncated).toBe(true);
    // T's 3.5 KB body fits.
    const t = await v1(F.T);
    expect((t.view['content'] as { excerpt: string }).excerpt).toBe(BODIES.T);
    // v1 carries only acceptance COUNTS, never the criterion text (c904 §1.6).
    expect(t.json).not.toContain(T_ACCEPTANCE[0]!.text);
  });

  it('[c904 §5.9] v1 still accepts sectionBytes (v2 rejects it; v1 is unchanged)', async () => {
    const r = await v1(F.T, 'sections=summary&totalBytes=4096&sectionBytes=1024');
    expect(r.view['schemaVersion']).toBe('tm8.entity-context.v1');
  });

  it('[c761 §10.5] v1 `sections=summary` issues no hierarchy/edges/messages/activity SQL', async () => {
    const r = await v1(F.P, 'sections=summary');
    for (const tag of ['children', 'parents', 'edges', 'messages', 'activity', 'actions']) {
      expect(r.byTag[tag] ?? 0, tag).toBe(0);
    }
  });

  it('never surfaces the hidden peer in v1 either (RLS drops it before assembly)', async () => {
    const r = await v1(F.P, 'sections=hierarchy&totalBytes=32768&sectionBytes=8192');
    expect(r.json).not.toContain(F.H);
  });
});

// ===========================================================================
// S2 — select before load
// ===========================================================================

describe('S2 select-before-load', () => {
  // Flipped by S2 (#673): every statement the context read issues is tagged
  // with the section it loads (root/summary/ancestors/actors/actions included),
  // so the counter attributes ALL database work, not only the list loaders.
  it('[c904 §5.8 · c761 §10.5] every statement entities.context issues carries a section tag (S2)', async () => {
    for (const fixture of FIXTURES) {
      const r = await v1(fixture.id);
      expect(untagged().map((sql) => sql.slice(0, 80)), fixture.name).toEqual([]);
      expect(r.statements).toBeGreaterThan(0);
    }
  });

  // Flipped by S2 (#673): a v1 read with an explicit selection loads ONLY that
  // selection — no ancestor or summary work for sections that were not asked.
  it('[c761 §10.5] v1 `sections=messages` loads no hierarchy, edges, activity or actions (S2)', async () => {
    const r = await v1(F.C, 'sections=messages');
    expect(untagged()).toEqual([]);
    for (const section of ['hierarchy', 'connections', 'activity', 'actions']) {
      for (const tag of SECTION_TAGS[section]!) expect(r.byTag[tag] ?? 0, tag).toBe(0);
    }
  });
});

// ===========================================================================
// S3 — the v2 DTO, projection, paging
// ===========================================================================

describe('S3 the v2 DTO', () => {
  it('[c904 §5.1 · c761 §10.1] budget.used is the minified DTO length and ≤ requested, for every fixture (S3a)', async () => {
    for (const fixture of FIXTURES) {
      const r = await v2(fixture.id);
      expect(r.view.schemaVersion, fixture.name).toBe('tm8.entity-context.v2');
      expect(r.view.budget, fixture.name).toEqual({ requested: DEFAULT_TOTAL, used: r.bytes });
      expect(r.bytes, fixture.name).toBeLessThanOrEqual(DEFAULT_TOTAL);
    }
  });

  it('[c761 §10.1] size gate: fixed core ≤ 1.5 KB, ref rows ≤ 200 B + title, message rows ≤ 200 B + text (S3a)', async () => {
    for (const fixture of [...FIXTURES, { name: 'G (gated)', id: F.G }, { name: 'U (unreadable parent)', id: F.U }]) {
      const { view } = await v2(fixture.id);
      expect(fixedCore(view), `${fixture.name} fixed core`).toBeLessThanOrEqual(FIXED_CORE_MAX);
      const refs = [...(view.children ?? []), ...(view.blockers ?? []), ...(view.tasks ?? []),
        ...(view.connections ?? []).map((c) => c.other), ...(view.parent ? [view.parent] : [])];
      for (const ref of refs) {
        expect([...(ref.title ?? '')].length, `${fixture.name} title cap`).toBeLessThanOrEqual(TEXT_CAP.title);
        expect(bytes(ref) - bytes(ref.title ?? ''), `${fixture.name} ref row ${ref.id}`).toBeLessThanOrEqual(ROW_OVERHEAD_MAX);
      }
      for (const row of view.connections ?? []) {
        expect(bytes(row) - bytes(row.other.title ?? ''), `${fixture.name} connection row`).toBeLessThanOrEqual(ROW_OVERHEAD_MAX);
      }
      for (const message of view.messages ?? []) {
        expect([...(message.from ?? '')].length, `${fixture.name} from cap`).toBeLessThanOrEqual(TEXT_CAP.from);
        expect(bytes(message) - bytes(message.text ?? ''), `${fixture.name} message row`).toBeLessThanOrEqual(ROW_OVERHEAD_MAX);
      }
    }
  });

  it('[c904 §5.1] a caller budget above the core holds exactly, and trims rows, never the core (S3)', async () => {
    // P carries an 8,004 B body, so its never-drop core is above 8,192: that
    // budget is BELOW the core and S4 answers it with 422 + minimumBytes
    // (c904 §2.9). Every budget from the KB-rounded minimum up must hold
    // exactly, trimming rows to omitted[] with reason budget, never the core.
    const full = await v2(F.P);
    let minimum = 0;
    try {
      await v2(F.P, 'totalBytes=8192');
    } catch (caught) {
      const error = caught as { code?: string; details?: Record<string, unknown> };
      expect(error.code).toBe('context_budget_too_small');
      minimum = error.details!['minimumBytes'] as number;
    }
    expect(minimum, 'P core exceeds 8192').toBeGreaterThan(8_192);
    for (const requested of [Math.ceil(minimum / 1024) * 1024, 12_288]) {
      const r = await v2(F.P, `totalBytes=${requested}`);
      expect(r.bytes).toBeLessThanOrEqual(requested);
      expect(r.view.budget).toEqual({ requested, used: r.bytes });
      expect(r.view.assignment).toEqual(full.view.assignment);
      expect(r.view.acceptance).toEqual(full.view.acceptance);
      const trimmed = r.view.omitted.filter((o) => o.reason === 'budget');
      if (r.bytes < full.bytes) expect(trimmed.length).toBeGreaterThan(0);
      for (const o of trimmed) expect(o.more).toBe(true);
    }
  });

  it('[c904 §5.2 · c761 §10.3] assignment and acceptance are never absent; bodies ≤ ceiling arrive complete (S3a)', async () => {
    for (const fixture of SMALL_BODIES) {
      const { view } = await v2(fixture.id);
      expect(view.assignment, fixture.name).toEqual({ text: fixture.body, bytes: bytes(fixture.body!), complete: true });
      expect(Array.isArray(view.acceptance), fixture.name).toBe(true);
    }
    const t = await v2(F.T);
    expect(t.view.acceptance).toEqual(T_ACCEPTANCE.map(({ id, done, text }) => ({ id, done, text })));
    // P: v1 cut this body at 4,096 B; v2 carries all 8,004 B.
    const p = await v2(F.P);
    expect(p.view.assignment?.bytes).toBe(8_004);
    expect(p.view.assignment?.complete).toBe(true);
  });

  it('[c904 §5.5 · c761 §10.2] no false empties: P shows all 10 children, open first then most recent (S3a)', async () => {
    const { view } = await v2(F.P);
    const kept = view.children ?? [];
    const entry = view.omitted.find((o) => o.section === 'children');
    // Either rows, or kept:0 + more:true + an expand — never a silent [].
    expect(kept.length > 0 || (entry?.kept === 0 && entry.more)).toBe(true);
    const all = await walkSection(view, 'children', (v) => v.children);
    // open (working) children by most recent first, then the done ones.
    const open = [9, 8, 6, 5, 4, 2, 1, 0].map((i) => F.pChildren[i]);
    const done = [7, 3].map((i) => F.pChildren[i]);
    expect(all.map((c) => c.id)).toEqual([...open, ...done]);
    for (const child of all) {
      expect(Object.keys(child).sort()).toEqual(
        expect.arrayContaining(['id', 'kind', 'status', 'title']),
      );
    }
  });

  it('[c761 §10.2] a running session shows its working_on task; connections are never silently 0 (S3a)', async () => {
    const { view } = await v2(F.WS);
    expect(view.kind).toBe('work_session');
    expect(view.tasks).toEqual([
      { id: F.T, kind: 'task', title: 'Align: byte budgets that never drop the assignment', status: 'working' },
    ]);
    expect(view.parent).toEqual({ id: F.CS, kind: 'work_session', title: 'Module 2 coordinator', status: 'running' });
    expect(view).toMatchObject({ agentTool: 'claude-code', model: 'claude-opus-5-5[1m]', checkoutBranch: 'tm8/01a0cf17-ff23' });
    // in_project is not loaded by default — but it is ADVERTISED, never dropped.
    const connections = view.notLoaded.find((n) => n.section === 'connections');
    expect(connections?.expand).toBeDefined();
    const page = await runExpand(connections!.expand);
    const types = (page.view.connections ?? []).map((c) => c.type);
    expect(types).toEqual(expect.arrayContaining(['working_on']));
  });

  it('[c761 §3.2] per-kind messages: chat keeps the latest 10 of 12 at ≤500 chars, oldest→newest (S3a)', async () => {
    const { view } = await v2(F.C);
    const messages = view.messages ?? [];
    expect(messages).toHaveLength(LIMIT.coreMessages);
    expect(messages.map((m) => m.id)).toEqual(F.chatMessages.slice(2));
    const times = messages.map((m) => Date.parse(m.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const m of messages) {
      expect([...(m.text ?? '')].length).toBeLessThanOrEqual(TEXT_CAP.core);
      if (m.truncated) expect(m.text?.length).toBeGreaterThan(0);
    }
    expect(messages.some((m) => m.truncated === true)).toBe(true);
    expect(view.omitted.find((o) => o.section === 'messages')).toMatchObject({ kept: 10, more: true, reason: 'rowLimit' });
    // A chat has no edges and no actions (c761 §3.2).
    expect(view.connections).toBeUndefined();
  });

  it('[c761 §3.2] per-kind messages: a task keeps the latest 3 at ≤280 chars (S3a)', async () => {
    const { view } = await v2(F.P);
    expect((view.messages ?? []).map((m) => m.id)).toEqual([F.pMessage]);
    for (const m of view.messages ?? []) expect([...(m.text ?? '')].length).toBeLessThanOrEqual(TEXT_CAP.task);
    const ws = await v2(F.WS);
    expect((ws.view.messages ?? []).map((m) => m.id)).toEqual(F.wsMessages);
    for (const m of ws.view.messages ?? []) expect([...(m.text ?? '')].length).toBeLessThanOrEqual(TEXT_CAP.core);
  });

  it('[c761 §3.2] a project is a card: children and edges notLoaded, no count query (S3a)', async () => {
    const r = await v2(F.PJ);
    expect(r.view.kind).toBe('project');
    expect(r.view.children).toBeUndefined();
    expect(r.view.notLoaded.map((n) => n.section)).toEqual(expect.arrayContaining(['hierarchy', 'connections']));
    for (const tag of [...SECTION_TAGS['hierarchy']!, ...SECTION_TAGS['connections']!]) {
      if (tag === 'parents') continue; // the nearest parent ref is core
      expect(r.byTag[tag] ?? 0, tag).toBe(0);
    }
  });

  it('[c904 §5.4 · c761 §10.4] every advertised expand runs verbatim, bounded, same row shape, no gaps or overlaps (S3)', async () => {
    for (const fixture of [...FIXTURES, { name: 'G', id: F.G }]) {
      const first = await v2(fixture.id);
      for (const expand of advertisedExpands(first.view)) {
        if (expand.startsWith('tm8 action list')) continue; // own test: #669
        if (expand.includes('--offset')) continue; // body pages: S4 test
        const page = await runExpand(expand);
        expect(page.bytes, expand).toBeLessThanOrEqual(DEFAULT_TOTAL);
        expect(page.view.id, expand).toBe(expand.split(' ')[3]);
        const section = /--sections (\S+)/.exec(expand)?.[1];
        if (section && expand.includes('--cursor')) assertPageShape(page.view, section);
      }
      // Paged lists reassemble exactly: every row once, none missing.
      for (const [section, key] of [['children', 'children'], ['messages', 'messages'], ['blockers', 'blockers']] as const) {
        const entry = first.view.omitted.find((o) => o.section === section);
        if (!entry?.more) continue;
        const rows = await walkSection(first.view, section, (v) => v[key] as Array<{ id: string }> | undefined);
        const ids = rows.map((r) => r.id);
        expect(new Set(ids).size, `${fixture.name} ${section} overlap`).toBe(ids.length);
        // Row shape identical to the default read's rows (optional flags aside).
        const shape = rowShape((first.view[key] as object[] | undefined)?.[0]);
        for (const row of rows) expect(rowShape(row), `${fixture.name} ${section} row shape`).toBe(shape);
      }
    }
    // The chat's 12 messages reassemble across pages, each exactly once.
    const chat = await v2(F.C);
    const all = await walkSection(chat.view, 'messages', (v) => v.messages);
    expect(all.map((m) => m.id).sort()).toEqual([...F.chatMessages].sort());
  });

  // S5: the expand is run as its callers run it, and every one of them asks
  // for the bounded tm8.actions.v2 page: `tm8 action list` does for agent and
  // text callers (packages/cli/test/action.test.ts), MCP defaults actions.list
  // to schema v2 (packages/mcp/test/tools.test.ts), and the wire expandOp names
  // `schema: 'v2'` itself. `actions.list` with NO schema stays the v1 inventory
  // for raw-HTTP and non-agent `--format json` callers during the rollout
  // release (c761 §9, with its stderr notice) — so it is not what runs here.
  it('[c761 §10.4] the actions expand is advertised only in its bounded form and runs verbatim (S3 + #669 bounded action list)', async () => {
    const { view } = await v2(F.T);
    const actions = view.notLoaded.find((n) => n.section === 'actions');
    expect(actions?.expand).toBe(`tm8 action list --for ${F.T}`);
    expect(actions?.expandOp).toEqual({ operation: 'actions.list', params: { contextEntityId: F.T, schema: 'v2' } });
    counter.reset();
    const query = new URLSearchParams(actions!.expandOp!.params as Record<string, string>);
    const result = await call<{ schema?: string }>('actions.list', {}, query);
    expect(result.schema).toBe('tm8.actions.v2');
    // #669's CI gate: one bounded page ≤ 1.5 KB.
    expect(bytes(result)).toBeLessThanOrEqual(1_536);
  });

  it('[c904 §5.6 · c761 §10.6] a hidden peer yields no row, no count, no more — no marker at all (S3a)', async () => {
    const r = await v2(F.P);
    expect(r.json).not.toContain(F.H);
    const children = r.view.omitted.find((o) => o.section === 'children');
    // Exactly 10 readable children = the row limit: nothing more to page.
    expect(children?.more ?? false).toBe(false);
    expect(children?.totalAtLeast).toBeUndefined();
    const page = await v2(F.P, 'sections=hierarchy');
    expect(page.json).not.toContain(F.H);
    expect(page.view.children).toHaveLength(LIMIT.children);
  });

  it('[c904 §5.6 · c761 §10.6] a root-named unreadable parent renders {id, unreadable:true} (S3a)', async () => {
    const { view } = await v2(F.U);
    expect(view.parent).toEqual({ id: F.RP, unreadable: true });
  });

  it('[c761 §10.6] blockers and gate PRs appear in the core (S3a)', async () => {
    const { view } = await v2(F.G);
    expect(view.blockers).toEqual([
      { id: F.B, title: 'Blocker: open dependency of G', status: 'open', resolved: false },
    ]);
    expect(view.gate).toMatchObject({
      kind: 'pr_merged',
      prs: [{ url: 'https://github.com/example/tm8/pull/9001', state: 'open', ci: expect.anything() }],
    });
    const t = await v2(F.T);
    expect(t.view.blockers).toEqual([]);
    expect(t.view.gate).toBe('none');
  });

  it('[c904 §5.6 · c761 §10.6] a failing list loader lands in errors[], never silently absent (S3a)', async () => {
    const control = await v2(F.G);
    expect(control.view.errors).toEqual([]);
    try {
      counter.failOn('blockers');
      counter.failOn('messages');
      const { view } = await v2(F.G);
      const sections = view.errors.map((e) => e.section).sort();
      expect(sections).toEqual(expect.arrayContaining(['blockers']));
      for (const e of view.errors) {
        expect(typeof e.code).toBe('string');
        expect(e).toHaveProperty('retry');
      }
      // The core that did load is intact.
      expect(view.assignment?.text).toBe('G body');
    } finally {
      counter.clearFaults();
    }
  });

  it('[c904 §5.6] a root, body or acceptance failure fails the whole read (S3a)', async () => {
    const control = await v2(F.T);
    expect(control.view.schemaVersion).toBe('tm8.entity-context.v2');
    for (const tag of ['root', 'assignment', 'acceptance']) {
      counter.failOn(tag);
      try {
        // If body/acceptance ride on the root statement (no tag of their own),
        // the fault never fires and the root case below covers them; if they
        // have their own statement, its failure must fail the read.
        await v2(F.T).then(
          () => expect(counter.statements.some((sql) => contextTagOf(sql) === tag), `${tag} loaded, failed, yet the read succeeded`).toBe(false),
          (error: Error) => expect(error.message).toContain(`injected fault: entities.context:${tag}`),
        );
      } finally {
        counter.clearFaults();
      }
    }
    counter.failOn('root');
    try {
      await expect(v2(F.T)).rejects.toThrow('injected fault: entities.context:root');
    } finally {
      counter.clearFaults();
    }
  });

  it('[c904 §5.7 · c761 §10.7] two reads at the same asOfSeq, as the same actor, are byte-identical (S3a)', async () => {
    for (const fixture of FIXTURES) {
      const first = await v2(fixture.id);
      const second = await v2(fixture.id);
      expect(second.view.asOfSeq, fixture.name).toBe(first.view.asOfSeq);
      expect(second.json, fixture.name).toBe(first.json);
      expect(first.json, fixture.name).not.toContain('fetchedAt');
    }
  });

  // c904 §5.7 second half / c761 §10.7: the launch snapshot (ca8d) embeds the
  // canonical minified DTO; it must equal a fresh read at the same asOfSeq.
  // ca8d's snapshot builder is outside Module 2 — this becomes an `it` there.
  it.todo('[c904 §5.7 · c761 §10.7] the launch-snapshot DTO equals an immediate read (ca8d)');

  it('[c904 §5.8] under the v2 default, no statement runs for a section left in notLoaded[] (S3a)', async () => {
    for (const fixture of [...FIXTURES, { name: 'G', id: F.G }]) {
      const r = await v2(fixture.id);
      expect(untagged(), fixture.name).toEqual([]);
      for (const { section } of r.view.notLoaded) {
        for (const tag of SECTION_TAGS[section] ?? [section]) {
          if (section === 'hierarchy' && tag === 'parents') continue; // nearest parent is core
          expect(r.byTag[tag] ?? 0, `${fixture.name}: ${section} is notLoaded but ${tag} ran`).toBe(0);
        }
      }
      // activity is dropped from v2 entirely (c761 Q22).
      expect(r.byTag['activity'] ?? 0, fixture.name).toBe(0);
    }
  });

  it('[c761 §10.5] v2 `--sections X` skips loading everything but X (S3a)', async () => {
    const hierarchy = await v2(F.P, 'sections=hierarchy');
    for (const section of ['messages', 'connections', 'actions', 'activity', 'assignment']) {
      for (const tag of SECTION_TAGS[section]!) expect(hierarchy.byTag[tag] ?? 0, `hierarchy read ran ${tag}`).toBe(0);
    }
    const messages = await v2(F.C, 'sections=messages');
    for (const section of ['hierarchy', 'connections', 'actions', 'activity', 'assignment', 'blockers']) {
      for (const tag of SECTION_TAGS[section]!) expect(messages.byTag[tag] ?? 0, `messages read ran ${tag}`).toBe(0);
    }
  });

  it('[c761 §10.8] statements per call: v2 default < v1 default, and `--sections assignment` the fewest (S3a)', async () => {
    const report: string[] = [];
    for (const fixture of FIXTURES) {
      const old = await v1(fixture.id);
      const now = await v2(fixture.id);
      expect(now.statements, `${fixture.name}: v2 ${now.statements} vs v1 ${old.statements}`).toBeLessThan(old.statements);
      const perSection: Record<string, number> = {};
      for (const section of ['assignment', 'hierarchy', 'blockers', 'connections', 'messages']) {
        perSection[section] = (await v2(fixture.id, `sections=${section}`)).statements;
      }
      const assignment = perSection['assignment']!;
      expect(assignment, fixture.name).toBeLessThanOrEqual(Math.min(now.statements, ...Object.values(perSection)));
      report.push(`| ${fixture.name} | ${old.statements} | ${now.statements} | ${assignment} | ${old.bytes} | ${now.bytes} |`);
    }
    console.log(`\n[context-v2] statements and bytes, v1 vs v2\n| fixture | v1 stmts | v2 stmts | v2 assignment stmts | v1 bytes | v2 bytes |\n|---|---|---|---|---|---|\n${report.join('\n')}\n`);
  });

  it('[c904 §5.10] explicit `--sections hierarchy` returns the header, errors[], and a WORKING assignment expand (S3a)', async () => {
    const r = await v2(F.P, 'sections=hierarchy');
    assertPageShape(r.view, 'hierarchy');
    // The body is never shown as empty: it is absent AND advertised.
    expect(r.view).not.toHaveProperty('assignment');
    expect(r.view.errors).toEqual([]);
    const assignment = r.view.notLoaded.find((n) => n.section === 'assignment');
    expect(assignment?.expand).toBe(`tm8 entity context ${F.P} --sections assignment`);
    const body = await runExpand(assignment!.expand);
    expect(body.view.assignment).toEqual({ text: BODIES.P, bytes: bytes(BODIES.P), complete: true });
  });

  it('[c761 §3.2 · c904 §2.8] a message root: full body, anchor ref; its own expand is `entity context <message-id>` (S3a)', async () => {
    const chat = await v2(F.C);
    const cut = (chat.view.messages ?? []).find((m) => m.truncated);
    expect(cut).toBeDefined();
    const full = await runExpand(`tm8 entity context ${cut!.id}`);
    expect(full.view.kind).toBe('message');
    const index = F.chatMessages.indexOf(cut!.id);
    expect(full.view.assignment?.text).toBe(BODIES.message('chat turn', index));
    expect(full.view['anchor']).toMatchObject({ id: F.C });
  });
});

// ===========================================================================
// S4 — the body ceiling, offset pages, context_budget_too_small
// ===========================================================================

describe('S4 body ceiling and caller budget', () => {
  it('records minimumBytes per fixture: 1024 either fits or is the 422 with a minimum above it (S4)', async () => {
    const rows: string[] = [];
    for (const fixture of FIXTURES) {
      try {
        const fits = await v2(fixture.id, 'totalBytes=1024');
        expect(fits.bytes, fixture.name).toBeLessThanOrEqual(1024);
        rows.push(`| ${fixture.name} | fits (${fits.bytes}) | — |`);
      } catch (caught) {
        const error = caught as { code?: string; details?: Record<string, unknown> };
        expect(error.code, fixture.name).toBe('context_budget_too_small');
        expect(error.details!['minimumBytes'] as number, fixture.name).toBeGreaterThan(1024);
        rows.push(`| ${fixture.name} | ${String(error.details!['minimumBytes'])} | ${String(error.details!['next'] ?? '—')} |`);
      }
    }
    console.log(['', '[context-v2 S4] minimumBytes per fixture', '| fixture | minimumBytes | next |', '|---|---|---|', ...rows, ''].join('\n'));
  });

  it('[c904 §5.2 · c761 §10.3] a body over the ceiling is cut with complete:false and reassembles byte-identically, multi-byte included (S4)', async () => {
    for (const fixture of LARGE_BODIES) {
      const first = await v2(fixture.id);
      const a = first.view.assignment!;
      expect(a.complete, fixture.name).toBe(false);
      expect(a.bytes, fixture.name).toBe(bytes(fixture.body!));
      expect(a.offset, fixture.name).toBe(0);
      expect(a.expand, fixture.name).toMatch(new RegExp(`^tm8 entity context ${fixture.id} --sections assignment --offset \\d+$`));
      const ceiling = bytes(a.text);
      expect(ceiling, `${fixture.name} ceiling ≈ 16 KB − envelope`).toBeLessThan(DEFAULT_TOTAL);
      expect(ceiling, fixture.name).toBeGreaterThan(12_000);

      const whole = Buffer.from(fixture.body!, 'utf8');
      let text = a.text;
      let offset = 0;
      let next = a.expand;
      for (let guard = 0; next && guard < 10; guard += 1) {
        const nextOffset = Number(/--offset (\d+)$/.exec(next)![1]);
        // No gap, no overlap: the next page starts where this one ended.
        expect(nextOffset, `${fixture.name} contiguous`).toBe(offset + bytes(text));
        // The cut never splits a character: the byte at the offset is a lead byte.
        expect((whole[nextOffset]! & 0xc0) !== 0x80, `${fixture.name} offset ${nextOffset} on a code point`).toBe(true);
        const page = await runExpand(next);
        assertPageShape(page.view, 'assignment');
        const p = page.view.assignment!;
        expect(p.offset, fixture.name).toBe(nextOffset);
        // Each page is ≤ its own read's ceiling, and the page itself ≤ 16 KB.
        expect(bytes(p.text), `${fixture.name} page ≤ ceiling`).toBeLessThanOrEqual(ceilingOf(page.view));
        expect(page.bytes, `${fixture.name} page ≤ default total`).toBeLessThanOrEqual(DEFAULT_TOTAL);
        expect(p.text, fixture.name).not.toContain('�');
        offset = nextOffset;
        text = p.text;
        next = p.complete ? undefined : p.expand;
      }
      // Reassemble every page and compare hashes.
      const pages: string[] = [a.text];
      let cursor = a.expand;
      while (cursor) {
        const page = await runExpand(cursor);
        pages.push(page.view.assignment!.text);
        cursor = page.view.assignment!.complete ? undefined : page.view.assignment!.expand;
      }
      expect(sha256(pages.join('')), `${fixture.name} sha256`).toBe(sha256(fixture.body!));
    }
  });

  it('[c904 §5.2] the multi-byte fixture straddles the ceiling: the cut is walked back ≤ 3 bytes to a code point (S4)', async () => {
    const { view } = await v2(F.MB);
    const a = view.assignment!;
    // c904 §2.4: ceiling = 16,384 − the core envelope with every droppable list empty.
    const ceiling = ceilingOf(view);
    const cut = Buffer.byteLength(a.text, 'utf8');
    const whole = Buffer.from(BODIES.MB, 'utf8');
    expect(cut).toBeLessThanOrEqual(ceiling);
    // MB has no newline, so a line boundary cannot explain a larger walk-back.
    expect(ceiling - cut).toBeLessThanOrEqual(3);
    expect((whole[cut]! & 0xc0) !== 0x80).toBe(true);
    expect(BODIES.MB.startsWith(a.text)).toBe(true);
    expect(a.expand).toBe(`tm8 entity context ${F.MB} --sections assignment --offset ${cut}`);
  });

  it('[c761 §3.2 · c904 §2.3] a cut doc carries its outline (≤ ~1 KB, truncated marker) (S3a, ahead of S4)', async () => {
    const { view } = await v2(F.D);
    expect(view.assignment?.complete).toBe(false);
    expect(Array.isArray(view.outline)).toBe(true);
    expect(view.outline!.length).toBeGreaterThan(0);
    expect(bytes(view.outline)).toBeLessThanOrEqual(1_200);
    const whole = Buffer.from(BODIES.D, 'utf8');
    for (const h of view.outline!) {
      expect(h.level).toBeGreaterThanOrEqual(1);
      expect(whole.subarray(h.offset).toString('utf8').replace(/^#+\s*/, '').startsWith(h.text)).toBe(true);
    }
  });

  it('[c904 §5.3] --total-bytes 1024 on T is 422 context_budget_too_small with the EXACT minimum, and `next` succeeds (S4)', async () => {
    const control = await v2(F.T);
    expect(control.view.schemaVersion).toBe('tm8.entity-context.v2');
    let error: { code?: string; status?: number; details?: Record<string, unknown>; next?: string } | undefined;
    try {
      await v2(F.T, 'totalBytes=1024');
    } catch (caught) {
      error = caught as typeof error;
    }
    expect(error?.code).toBe('context_budget_too_small');
    expect(error?.status).toBe(422);
    const details = error!.details!;
    expect(details['requestedBytes']).toBe(1024);
    const minimum = details['minimumBytes'] as number;
    expect(details['core']).toEqual(expect.arrayContaining(['root', 'assignment', 'acceptance', 'blockers']));
    // Exact: the minimum itself succeeds, one byte less does not.
    const atMinimum = await v2(F.T, `totalBytes=${Math.max(1024, minimum)}`);
    expect(atMinimum.bytes).toBeLessThanOrEqual(minimum);
    if (minimum - 1 >= 1024) await expect(v2(F.T, `totalBytes=${minimum - 1}`)).rejects.toMatchObject({ code: 'context_budget_too_small' });
    // `next` rounds up to the KB and runs verbatim.
    const next = (details['next'] ?? error!.next) as string;
    expect(next).toBe(`tm8 entity context ${F.T} --total-bytes ${Math.ceil(minimum / 1024) * 1024}`);
    const retried = await runExpand(next);
    expect(retried.view.assignment?.text).toBe(BODIES.T);
  });

  it('[c904 §2.5] a caller budget never cuts the body: X at 16 KB and at 32 KB carries the same ceiling cut (S3a, ahead of S4)', async () => {
    const small = await v2(F.X, 'totalBytes=16384');
    const large = await v2(F.X, 'totalBytes=32768');
    expect(large.view.assignment).toEqual(small.view.assignment);
  });

  it('[c904 §5.9] v2 rejects sectionBytes as a usage error; the same v2 read without it succeeds (S3a, ahead of S4)', async () => {
    // 8 KB, not 4 KB: since S4 a budget under T's core is a 422, not a read.
    const control = await v2(F.T, 'totalBytes=8192');
    expect(control.view.schemaVersion).toBe('tm8.entity-context.v2');
    await expect(v2(F.T, 'totalBytes=8192&sectionBytes=1024')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/total-only|totalBytes|total-bytes/),
    });
  });
});

// ===========================================================================
// S5 — MCP expandOp
// ===========================================================================

describe('S5 MCP expandOp', () => {
  it('[c904 §5.4 · c904 Q19] every omitted/notLoaded entry carries an expandOp that returns what its expand returns (S5)', async () => {
    for (const fixture of [...FIXTURES, { name: 'G', id: F.G }]) {
      const { view } = await v2(fixture.id);
      for (const entry of [...view.omitted, ...view.notLoaded]) {
        expect(entry.expandOp, `${fixture.name} ${entry.section}`).toMatchObject({
          operation: expect.any(String),
          params: expect.any(Object),
        });
        if (entry.expand.startsWith('tm8 action list')) {
          expect(entry.expandOp!.operation).toBe('actions.list');
          continue;
        }
        const viaOp = await runExpandOp(entry.expandOp!);
        const viaCli = await runExpand(entry.expand);
        expect(viaOp.json, `${fixture.name} ${entry.section}`).toBe(viaCli.json);
      }
    }
  });
});
