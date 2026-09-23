#!/usr/bin/env node
/**
 * tm8-to-graphify — project the tm8 ENTITY graph into graphify's graph shape,
 * and join it to the CODE graph through commits.
 *
 * WHY. graphify maps code: files, symbols, imports, calls. tm8 maps work:
 * tasks, sessions, teammates, messages, commits. Each is blind to the other,
 * so "which code did this task actually change?" is answerable by neither —
 * it needs one edge that crosses, and that edge exists: a tm8 `commit` entity
 * carries a sha, and git knows which files that sha touched.
 *
 * THE JOIN IS EXTRACTED, NOT INFERRED. Every crossing edge this writes comes
 * from `git show --name-only <sha>` — a fact read from the repository, not a
 * similarity score. graphify's own vocabulary distinguishes the two and this
 * exporter honors it: work edges and commit->file edges are `EXTRACTED`;
 * nothing here emits `INFERRED`.
 *
 * WHAT IT DOES NOT DO. It does not embed, summarize, or send anything to a
 * model — the whole projection is deterministic and free, the same property
 * that makes graphify's AST pass free.
 *
 *   node scripts/tm8-to-graphify.mjs \
 *     --space <space-id> \
 *     --code graphify-out/graph.json \
 *     --out  graphify-out/tm8-work.json
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const SPACE = flag('space', process.env.TM8_SPACE_ID);
// Repo-root by default, NOT a package: a commit touches files anywhere, and a
// package-scoped code graph silently resolves most of them to nothing (measured:
// 21 shas resolved, 13 crossing edges against tm8-ui alone). graphify writes to
// `<path>/graphify-out`, which is gitignored and sits outside every package's
// tsconfig `include`, so it cannot reach a build.
const CODE = flag('code', 'graphify-out/graph.json');
const OUT = flag('out', 'graphify-out/tm8-work.json');
const LIMIT = flag('limit', '150');
const REPO = flag('repo', process.cwd());

if (!SPACE) {
  console.error('tm8-to-graphify: --space <space-id> required (or TM8_SPACE_ID)');
  process.exit(2);
}

/* -- 1 · read the work graph ------------------------------------------------ */

const raw = JSON.parse(
  execFileSync('tm8', ['graph', 'query', '--space', SPACE, '--limit', LIMIT, '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
);

/* -- 2 · read the code graph, and index it BY SOURCE FILE -------------------
   graphify derives a node id from the path, but the derivation is its own
   business; reading the mapping off the graph it already wrote means this
   exporter never has to reproduce that rule and never drifts from it. */

const code = JSON.parse(readFileSync(CODE, 'utf8'));
const codeIdByFile = new Map();
for (const n of code.nodes) {
  if (n.source_file && !codeIdByFile.has(n.source_file)) codeIdByFile.set(n.source_file, n.id);
}
/* The code graph may be scoped to one package, while git reports repo-relative
   paths. Index both spellings so a commit touching `packages/tm8-ui/src/x.ts`
   still finds the node a package-scoped graph filed under `src/x.ts`. */
const codeIdBySuffix = new Map();
for (const [file, id] of codeIdByFile) {
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const suffix = parts.slice(i).join('/');
    if (!codeIdBySuffix.has(suffix)) codeIdBySuffix.set(suffix, id);
  }
}
const resolveCode = (path) => {
  if (codeIdByFile.has(path)) return codeIdByFile.get(path);
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const hit = codeIdBySuffix.get(parts.slice(i).join('/'));
    if (hit !== undefined) return hit;
  }
  return null;
};

/* WHY A SECOND READ FOR COMMITS, AND ONLY FOR COMMITS.
   `graph query` and `entity get` do not project a commit the same way. The
   traversal returns `title: "commit"` and `state: { kind, fields: {} }` — no
   sha, no subject, nothing to join on — while a direct read of the same id
   returns the subject as the title and `state.sha`, `state.repository`,
   `state.message`, `state.committedAt`. Without the sha the crossing edge, the
   entire reason this exporter exists, is empty: measured on this space, 22
   commits in, 0 edges out.

   So: take the cheap field when the traversal carries it, and fall back to one
   bounded `entity get` per COMMIT only when it does not. That is at most one
   extra read per commit in the window, never per entity, and it disappears on
   its own the day the traversal projects commits properly — the count of
   fallbacks is printed so you can see when that happens. */
const detailCache = new Map();
const commitDetail = (e) => {
  const cheap = e.state?.fields?.sha ?? e.state?.sha;
  if (cheap) return { sha: cheap, message: e.state?.message ?? e.title };
  if (/^[0-9a-f]{7,40}$/i.test(e.title)) return { sha: e.title, message: e.title };
  if (detailCache.has(e.id)) return detailCache.get(e.id);
  let got = null;
  try {
    const one = JSON.parse(
      execFileSync('tm8', ['entity', 'get', e.id, '--format', 'json'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
    );
    const body = one?.data ?? one;
    if (body?.state?.sha) {
      got = { sha: body.state.sha, message: body.state.message ?? body.title ?? e.title };
      refetched += 1;
    }
  } catch { /* a commit we cannot read is a commit we do not draw an edge from */ }
  detailCache.set(e.id, got);
  return got;
};

let crossed = 0;
let shaResolved = 0;
let shaMissing = 0;
let refetched = 0;
let shaUnknownToGit = 0;

/* -- 3 · project entities --------------------------------------------------- */

const short = (id) => String(id).replace(/-/g, '').slice(0, 12);
const nodeId = (e) => `tm8_${e.kind}_${short(e.id)}`;

const nodes = [];
const links = [];
const byId = new Map(raw.nodes.map((n) => [n.id, n]));

/* Conversation is VOLUME on its anchor, not a node per message — the same rule
   the graph canvas now applies, for the same reason: 112 of 150 entities in
   this space are messages belonging to two threads, and drawing each as a node
   buries the work under the chatter. The count is preserved on the anchor, so
   nothing is dropped. */
const convo = new Map();
for (const e of raw.nodes) {
  const anchor = e.state?.anchorId;
  if (typeof anchor !== 'string') continue;
  const row = convo.get(anchor) ?? { count: 0, voices: new Set() };
  row.count += 1;
  if (e.state?.author?.id) row.voices.add(e.state.author.id);
  convo.set(anchor, row);
}

const rolled = new Set(raw.nodes.filter((e) => typeof e.state?.anchorId === 'string').map((e) => e.id));

for (const e of raw.nodes) {
  if (rolled.has(e.id)) continue;
  const thread = convo.get(e.id);
  // A commit whose traversal title is the bare word "commit" gets its subject
  // from the same fallback the crossing edge uses; the read is cached, so this
  // costs nothing beyond what section 4 already pays. The short sha is prefixed
  // because that is what a person types: `graphify explain aa305935` finds
  // nothing if the label is only the subject line.
  let label = e.title;
  if (e.kind === 'commit') {
    const d = commitDetail(e);
    const subject = String(d?.message ?? e.title).split('\n')[0].trim();
    label = d?.sha ? `${String(d.sha).slice(0, 8)} ${subject}`.trim() : subject;
  }
  nodes.push({
    id: nodeId(e),
    label,
    file_type: 'concept',
    source_file: `tm8://${e.kind}/${e.id}`,
    source_location: '',
    _origin: 'tm8',
    tm8_kind: e.kind,
    ...(e.kind === 'commit' && commitDetail(e)?.sha ? { tm8_sha: commitDetail(e).sha } : {}),
    tm8_status: e.state?.status ?? null,
    tm8_activity_at: e.activityAt,
    ...(e.state?.teammate?.displayName ? { tm8_holder: e.state.teammate.displayName } : {}),
    ...(thread ? { tm8_messages: thread.count, tm8_voices: thread.voices.size } : {}),
  });
}

for (const e of raw.edges) {
  if (rolled.has(e.sourceId) || rolled.has(e.targetId)) continue;
  const s = byId.get(e.sourceId);
  const t = byId.get(e.targetId);
  if (!s || !t) continue;
  links.push({
    source: nodeId(s),
    target: nodeId(t),
    relation: e.type,
    context: 'tm8 edge',
    confidence: 'EXTRACTED',
    source_file: `tm8://${s.kind}/${s.id}`,
    source_location: '',
    weight: 1.0,
    _origin: 'tm8',
  });
}

/* -- 4 · THE CROSSING EDGE: commit -> the files it touched ------------------ */

for (const e of raw.nodes) {
  if (e.kind !== 'commit') continue;
  const detail = commitDetail(e);
  const sha = detail?.sha ?? null;
  if (!sha) { shaMissing += 1; continue; }
  let files;
  try {
    // stderr is silenced deliberately: a sha recorded by tm8 but absent from
    // THIS checkout (a branch never fetched here, a rewritten history) is an
    // ordinary outcome, not an error to shout about. It is counted instead.
    files = execFileSync('git', ['-C', REPO, 'show', '--name-only', '--pretty=format:', sha],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { shaUnknownToGit += 1; continue; }
  shaResolved += 1;
  for (const f of files) {
    const target = resolveCode(f);
    if (target === null) continue;
    links.push({
      source: nodeId(e),
      target,
      relation: 'touches',
      context: `git show ${String(sha).slice(0, 8)}`,
      confidence: 'EXTRACTED',
      source_file: f,
      source_location: '',
      weight: 1.0,
      _origin: 'tm8-git',
    });
    crossed += 1;
  }
}

/* -- 5 · write ------------------------------------------------------------- */

const out = {
  input_tokens: 0,
  output_tokens: 0,
  failed_sources: [],
  extracted_sources: [`tm8://space/${SPACE}`],
  nodes,
  links,
  directed: code.directed ?? false,
  multigraph: false,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));

console.log(`tm8-to-graphify`);
console.log(`  entities read     ${raw.nodes.length} (${rolled.size} messages rolled onto anchors)`);
console.log(`  work nodes        ${nodes.length}`);
console.log(`  work links        ${links.length - crossed}`);
console.log(`  commit->file      ${crossed} crossing edges from ${shaResolved} resolved sha(s)` +
            (shaMissing ? `, ${shaMissing} with no sha at all` : '') +
            (shaUnknownToGit ? `, ${shaUnknownToGit} whose sha this checkout does not have` : ''));
console.log(`  commit sha source ${refetched} re-read via \`entity get\`` +
            (refetched ? ' (the traversal does not project commit state; this goes to 0 once it does)' : ''));
if (crossed === 0 && shaResolved > 0) {
  console.log(`  NOTE: shas resolved but no file matched the code graph — is ${CODE}`);
  console.log(`        scoped to one package while these commits touch others?`);
}
console.log(`  LLM tokens spent  0`);
console.log(`  wrote             ${OUT}`);
