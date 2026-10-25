#!/usr/bin/env node
// case-gate <case-task-id> — may this case's final pack be sent?
//
// Passes only when the newest VERDICT message on the case's Review subtask is an agent's pass AND it names,
// at their current version, every result doc a specialist subtask produces. Anything else refuses:
// no Review subtask, no verdict, a fix verdict, a result doc the verdict does not list, a result doc
// changed after the verdict, or a read that could not be completed. The gate fails closed.
//
// Prints one JSON line {ok, case, reviewTask, verdictMessage, reason, reviewed, flags} and exits
// 0 on pass, 1 on refuse, 2 on usage error. POST /pack in the WhatsApp bridge runs it before sending.
// The reviewer's verdict format is in ../reviewer/SKILL.md; the rule is in ./README.md.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REVIEW_TITLE = /^\s*review\b/i;
const MAX_DEPTH = 3; // case → subtask → sub-subtask → one more
const MAX_PAGES = 20;

// tm8 --format json prints the JSON, then may append a "[journal: …]" line.
export function parseCliJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cut = text.search(/\n\[journal:/);
    if (cut < 0) throw new Error("tm8 did not return JSON");
    return JSON.parse(text.slice(0, cut));
  }
}

export function cliRunner(bin = process.env.TM8_BIN || "tm8") {
  return (args) =>
    parseCliJson(
      execFileSync(bin, [...args, "--format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
}

// First line of the body decides the verdict.
export function parseVerdict(body) {
  const first = (body || "").trim().split("\n", 1)[0];
  const m = /^VERDICT:\s*(\w+)/i.exec(first);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const reviewed = new Map();
  for (const r of (body || "").matchAll(new RegExp(`(${UUID})\\s*@?\\s*v(\\d+)\\b`, "gi"))) {
    reviewed.set(r[1].toLowerCase(), Number(r[2]));
  }
  // "Flags:" block: its lines up to a blank line or the next "Heading:" line.
  const flags = [];
  let inFlags = false;
  for (const line of (body || "").split("\n")) {
    if (/^\s*Flags:\s*$/i.test(line)) inFlags = true;
    else if (inFlags && (!line.trim() || /^\s*\w[\w ]*:\s*$/.test(line))) break;
    else if (inFlags) {
      const f = line.replace(/^\s*[-*•]\s*/, "").trim();
      if (f.toLowerCase() !== "none") flags.push(f);
    }
  }
  return { verdict: word === "pass" ? "pass" : word === "fix" ? "fix" : "other", firstLine: first, reviewed, flags };
}

function listAll(run, args, max = MAX_PAGES) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < max; page++) {
    const res = run(cursor ? [...args, "--cursor", cursor] : args);
    items.push(...(res.items || []));
    cursor = res.nextCursor;
    if (!cursor) return items;
  }
  throw new Error(`more than ${max} pages for: tm8 ${args.join(" ")}`);
}

function subtasks(run, id) {
  return listAll(run, ["entity", "children", id, "--limit", "100"]).filter((c) => c.kind === "task");
}

function producedDocs(run, taskId) {
  const ctx = run(["entity", "context", taskId, "--sections", "connections", "--edge-type", "produces"]);
  if ((ctx.omitted || []).some((o) => /connections/.test(o.section || o.expand || ""))) {
    throw new Error(`task ${taskId} has more produces edges than one read returns; cannot check them all`);
  }
  return (ctx.connections || [])
    .filter((c) => c.type === "produces" && c.dir === "out" && c.other?.kind === "doc")
    .map((c) => ({ id: c.other.id.toLowerCase(), title: c.other.title, task: taskId }));
}

function docVersion(run, docId) {
  return run(["entity", "context", docId, "--sections", "summary"]).version;
}

// The newest message on the Review subtask whose first line starts with "VERDICT:".
function latestVerdict(run, reviewTaskId) {
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ["message", "list", reviewTaskId, "--order", "newest", "--limit", "50"];
    const res = run(cursor ? [...args, "--cursor", cursor] : args);
    for (const m of res.items || []) {
      if (m.state?.redactedAt) continue;
      const v = parseVerdict(m.content?.body);
      if (v) return { id: m.id, author: m.state?.author?.displayName ?? null, byAgent: m.state?.author?.isAgent === true, ...v };
    }
    cursor = res.nextCursor;
    if (!cursor) return null;
  }
  return null;
}

export function evaluateGate(caseId, run = cliRunner()) {
  const out = { ok: false, case: caseId, reviewTask: null, verdictMessage: null, reason: "", reviewed: [], flags: [] };
  const refuse = (reason) => ({ ...out, reason });
  try {
    const top = subtasks(run, caseId);
    const reviews = top.filter((t) => REVIEW_TITLE.test(t.title || ""));
    if (reviews.length === 0) return refuse("the case has no Review subtask");
    if (reviews.length > 1) return refuse(`the case has ${reviews.length} Review subtasks; keep one`);
    out.reviewTask = reviews[0].id;

    const verdict = latestVerdict(run, out.reviewTask);
    if (!verdict) return refuse("no VERDICT message on the Review subtask yet");
    out.verdictMessage = verdict.id;
    out.flags = verdict.flags;
    if (verdict.verdict !== "pass") return refuse(`latest verdict is not a pass: ${verdict.firstLine}`);
    if (!verdict.byAgent) return refuse("latest verdict was not posted by an agent (the reviewer session posts it)");

    // Every doc a specialist subtask (any depth under the case, Review excluded) produces.
    const docs = [];
    const walk = (tasks, depth) => {
      for (const t of tasks) {
        if (t.id === out.reviewTask) continue;
        docs.push(...producedDocs(run, t.id));
        if (depth < MAX_DEPTH) walk(subtasks(run, t.id), depth + 1);
      }
    };
    walk(top, 1);
    if (docs.length === 0) return refuse("no specialist result docs to review (no produces edges on the subtasks)");

    const problems = [];
    for (const d of docs) {
      const current = docVersion(run, d.id);
      const seen = verdict.reviewed.get(d.id);
      out.reviewed.push({ doc: d.id, title: d.title, task: d.task, version: current, reviewedVersion: seen ?? null });
      if (seen === undefined) problems.push(`result doc ${d.id} ("${d.title}") is not listed in the verdict`);
      else if (seen !== current) problems.push(`result doc ${d.id} ("${d.title}") is v${current}, the verdict reviewed v${seen}`);
    }
    if (problems.length) return refuse(`re-review needed: ${problems.join("; ")}`);
    return { ...out, ok: true, reason: `pass (${docs.length} result docs at their reviewed versions)` };
  } catch (err) {
    return refuse(`gate could not complete its checks: ${err?.message || err}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const caseId = process.argv[2];
  if (!caseId || !new RegExp(`^${UUID}$`, "i").test(caseId)) {
    process.stderr.write("usage: case-gate <case-task-id>\n");
    process.exit(2);
  }
  const res = evaluateGate(caseId);
  process.stdout.write(`${JSON.stringify(res)}\n`);
  process.exit(res.ok ? 0 : 1);
}
