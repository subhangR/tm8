// node --test integrations/case-engine/gate/
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, parseCliJson, parseVerdict } from "./case-gate.mjs";

const id = (n) => `01a17400-0000-7000-8000-${String(n).padStart(12, "0")}`;
const CASE = id(1);
const LICENCE = id(2);
const COSTS = id(3);
const REVIEW = id(4);
const DOC_LICENCE = id(10);
const DOC_COSTS = id(11);
const BLUEPRINT = id(12);

// An in-memory space answering the four reads case-gate makes.
function fakeSpace({ children = {}, produces = {}, versions = {}, messages = {}, human = [] }) {
  return (args) => {
    const [noun, verb, target] = args;
    if (noun === "entity" && verb === "children") return { items: children[target] || [], nextCursor: null };
    if (noun === "entity" && verb === "context" && args.includes("connections")) {
      return {
        connections: (produces[target] || []).map((d) => ({ type: "produces", dir: "out", other: { id: d, kind: "doc", title: `doc ${d.slice(-2)}` } })),
        omitted: [],
      };
    }
    if (noun === "entity" && verb === "context") {
      if (!(target in versions)) throw new Error(`not_found ${target}`);
      return { id: target, version: versions[target] };
    }
    if (noun === "message" && verb === "list") {
      // stored oldest first; the gate asks for newest first
      const items = [...(messages[target] || [])].reverse().map((body, i) => ({ id: `m${i}`, content: { body }, state: { author: { isAgent: !human.includes(body) } } }));
      return { items, nextCursor: null };
    }
    throw new Error(`unexpected read: ${args.join(" ")}`);
  };
}

const task = (tid, title) => ({ id: tid, kind: "task", title });
const board = {
  children: { [CASE]: [task(LICENCE, "Licence options"), task(COSTS, "Costs and documents"), task(REVIEW, "Review")] },
  produces: { [CASE]: [BLUEPRINT], [LICENCE]: [DOC_LICENCE], [COSTS]: [DOC_COSTS] },
  versions: { [DOC_LICENCE]: 2, [DOC_COSTS]: 3, [BLUEPRINT]: 1 },
};
const pass = `VERDICT: pass\nReviewed:\n- ${DOC_LICENCE} v2 — Licence options\n- ${DOC_COSTS} v3 — Costs\nFlags:\n- Trade licence fee: verify with DET\n`;

test("passes when the newest verdict is a pass naming every result doc at its current version", () => {
  const res = evaluateGate(CASE, fakeSpace({ ...board, messages: { [REVIEW]: ["Review started.", pass] } }));
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.reviewTask, REVIEW);
  assert.deepEqual(res.flags, ["Trade licence fee: verify with DET"]);
  assert.equal(res.reviewed.length, 2); // the blueprint, produced by the case itself, is not a result doc
});

test("refuses with no verdict, and with a fix as the newest verdict", () => {
  assert.match(evaluateGate(CASE, fakeSpace({ ...board, messages: { [REVIEW]: ["Review started."] } })).reason, /no VERDICT/);
  const fixAfterPass = { [REVIEW]: [pass, `VERDICT: fix — Costs: fee has no source\nReviewed:\n- ${DOC_LICENCE} v2\n- ${DOC_COSTS} v3`] };
  const res = evaluateGate(CASE, fakeSpace({ ...board, messages: fixAfterPass }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /not a pass: VERDICT: fix/);
});

test("refuses when the newest verdict was posted by a person, not an agent", () => {
  const res = evaluateGate(CASE, fakeSpace({ ...board, messages: { [REVIEW]: [pass] }, human: [pass] }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /not posted by an agent/);
});

test("refuses when a result doc changed after the pass", () => {
  const res = evaluateGate(CASE, fakeSpace({ ...board, versions: { ...board.versions, [DOC_COSTS]: 4 }, messages: { [REVIEW]: [pass] } }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /is v4, the verdict reviewed v3/);
});

test("refuses when a result doc is missing from the verdict, including one on a sub-subtask", () => {
  const nested = id(5);
  const nestedDoc = id(13);
  const space = fakeSpace({
    children: { ...board.children, [COSTS]: [task(nested, "Visa costs")] },
    produces: { ...board.produces, [nested]: [nestedDoc] },
    versions: { ...board.versions, [nestedDoc]: 1 },
    messages: { [REVIEW]: [pass] },
  });
  const res = evaluateGate(CASE, space);
  assert.equal(res.ok, false);
  assert.match(res.reason, new RegExp(`${nestedDoc}.*not listed`));
});

test("refuses with no Review subtask, two of them, or no result docs", () => {
  const noReview = { ...board, children: { [CASE]: [task(LICENCE, "Licence options")] } };
  assert.match(evaluateGate(CASE, fakeSpace(noReview)).reason, /no Review subtask/);
  const two = { ...board, children: { [CASE]: [...board.children[CASE], task(id(6), "Review round 2")] } };
  assert.match(evaluateGate(CASE, fakeSpace(two)).reason, /2 Review subtasks/);
  const empty = { ...board, produces: { [CASE]: [BLUEPRINT] }, messages: { [REVIEW]: ["VERDICT: pass"] } };
  assert.match(evaluateGate(CASE, fakeSpace(empty)).reason, /no specialist result docs/);
});

test("fails closed when a read errors", () => {
  const res = evaluateGate(CASE, () => {
    throw new Error("upstream_unavailable");
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /could not complete.*upstream_unavailable/);
});

test("a verdict counts only on the first line; 'pass' must be the word", () => {
  assert.equal(parseVerdict("Looks fine.\nVERDICT: pass"), null);
  assert.equal(parseVerdict("VERDICT: passable").verdict, "other");
  assert.equal(parseVerdict("verdict: Pass with flags").verdict, "pass");
  assert.equal(parseVerdict(`VERDICT: pass\n- ${DOC_COSTS}@v7`).reviewed.get(DOC_COSTS), 7);
});

test("parseCliJson drops the trailing journal line", () => {
  assert.deepEqual(parseCliJson('{"a":1}\n[journal: ~1k est chars-over-4 this session]\n'), { a: 1 });
});
