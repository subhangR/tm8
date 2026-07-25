/**
 * DEF-1/2/3 — command input validation (contract §4 preamble): every command
 * rejects malformed input with a precise `invalid_input` BEFORE touching the
 * world. Unknown fields always reject (patch-partial commands included — an
 * unnamed key is a typo, not a no-op), enums are closed, types are checked,
 * and rejected commands leave the entity byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { isCollabError } from '../../types/contract';
import type {
  CompleteTaskInput, CreateEdgeInput, CreateEntityInput, CreateTaskInput,
  GrantPointsInput, LinkPrInput, MoveEntityInput, PatchEntityInput,
  PatchTaskInput, PlacementInput, PostMessageInput, PullInput, ReactionInput,
  SavedViewInput, TaskAxisInput, TrackingRefreshInput, WorkInput,
} from '../../types/contract';
import { createRig } from './helpers';

async function expectInvalid(p: Promise<unknown>, msgPart: RegExp): Promise<void> {
  try {
    await p;
    expect.unreachable('should have rejected with invalid_input');
  } catch (e) {
    expect(isCollabError(e)).toBe(true);
    if (isCollabError(e)) {
      expect(e.code).toBe('invalid_input');
      expect(e.status).toBe(400);
      expect(e.message).toMatch(msgPart);
    }
  }
}

describe('setWork — the DEF-1/2/3 repros', () => {
  it('rejects the wrong field name workStatus instead of silently wiping state (DEF-1)', async () => {
    const { facade, ids } = createRig();
    const before = await facade.getEntity(ids.t105);
    await expectInvalid(
      facade.setWork(ids.t105, { workStatus: 'done' } as unknown as WorkInput),
      /setWork: missing required field "status"/,
    );
    const after = await facade.getEntity(ids.t105);
    // EntityState invariant holds: workStatus still present and unchanged.
    expect(after.state).toEqual(before.state);
    expect(after.version).toBe(before.version);
    if (after.state.kind === 'task') expect(typeof after.state.workStatus).toBe('string');
  });

  it('rejects an out-of-range status enum (DEF-2: banana)', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.setWork(ids.t102, { status: 'banana' } as unknown as WorkInput),
      /setWork: "status" must be one of open\|pulled\|working\|in_review\|done\|blocked\|cancelled, got "banana"/,
    );
  });

  it('rejects unknown extra fields and wrong types', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.setWork(ids.t102, { status: 'working', speed: 'fast' } as unknown as WorkInput),
      /setWork: unknown field "speed"/,
    );
    await expectInvalid(
      facade.setWork(ids.t102, { status: 42 } as unknown as WorkInput),
      /"status" must be one of/,
    );
    await expectInvalid(
      facade.setWork(ids.t102, { status: 'working', startedAt: 'yesterdayish' } as unknown as WorkInput),
      /"startedAt" must be an ISO timestamp/,
    );
  });

  it('still accepts a valid input with the context envelope', async () => {
    const { facade, ids } = createRig();
    const res = await facade.setWork(ids.t102, { status: 'working', note: null, actorId: ids.forge, clientMutationId: 'cmid-vw-1' });
    expect(res.entity?.id).toBe(ids.t102);
  });
});

describe('task create/patch family', () => {
  it('createTask rejects missing required fields, bad enums, malformed nested shapes', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(facade.createTask({ spaceId: ids.space } as CreateTaskInput), /missing required field "title"/);
    await expectInvalid(facade.createTask({ title: 'x' } as CreateTaskInput), /missing required field "spaceId"/);
    await expectInvalid(
      facade.createTask({ spaceId: ids.space, title: 'x', priority: 'critical' } as unknown as CreateTaskInput),
      /"priority" must be one of low\|medium\|high\|urgent/,
    );
    await expectInvalid(
      facade.createTask({ spaceId: ids.space, title: 'x', axes: { type: 5 } } as unknown as CreateTaskInput),
      /"axes.type" must be a string/,
    );
    await expectInvalid(
      facade.createTask({ spaceId: ids.space, title: 'x', acceptanceCriteria: [{ done: true }] } as unknown as CreateTaskInput),
      /missing required field "acceptanceCriteria\[0\].text"/,
    );
    await expectInvalid(
      facade.createTask({ spaceId: ids.space, title: 'x', attachTo: { entityId: ids.chBuild, edgeType: 'tracks' } } as unknown as CreateTaskInput),
      /"attachTo.edgeType" must be one of attached_to\|relates_to/,
    );
    await expectInvalid(
      facade.createTask({ spaceId: ids.space, title: 'x', assignee: ids.mira } as unknown as CreateTaskInput),
      /unknown field "assignee"/,
    );
  });

  it('patchTask is patch-partial but still rejects unknown keys and wrong types', async () => {
    const { facade, ids } = createRig();
    const before = await facade.getEntity(ids.t104);
    await expectInvalid(
      facade.patchTask(ids.t104, { expectedVersion: before.version, status: 'working' } as unknown as PatchTaskInput),
      /patchTask: unknown field "status"/,
    );
    await expectInvalid(facade.patchTask(ids.t104, { title: 'no guard' } as PatchTaskInput), /missing required field "expectedVersion"/);
    await expectInvalid(
      facade.patchTask(ids.t104, { expectedVersion: '1' } as unknown as PatchTaskInput),
      /"expectedVersion" must be a finite number/,
    );
    await expectInvalid(
      facade.patchTask(ids.t104, { expectedVersion: before.version, workStatus: 'paused' } as unknown as PatchTaskInput),
      /"workStatus" must be one of/,
    );
    const after = await facade.getEntity(ids.t104);
    expect(after.version).toBe(before.version);
    expect(after.state).toEqual(before.state);
  });
});

describe('generic entity routes (DEV-1) — kind-typed content keys', () => {
  it('createEntity rejects unsupported kinds and unknown content keys per kind', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.createEntity({ spaceId: ids.space, kind: 'banana', title: 'x' } as unknown as CreateEntityInput),
      /"kind" must be one of/,
    );
    await expectInvalid(
      facade.createEntity({ spaceId: ids.space, kind: 'doc', title: 'Notes', content: { body: 'hello', status: 'draft' } }),
      /unknown field "content.status"/,
    );
    await expectInvalid(
      facade.createEntity({ spaceId: ids.space, kind: 'doc', title: 'Notes', content: { format: 'asciidoc' } }),
      /"content.format" must be one of markdown\|mermaid\|excalidraw/,
    );
    await expectInvalid(
      facade.createEntity({ spaceId: ids.space, kind: 'file', title: 'a.png', content: { sizeBytes: 'big' } }),
      /"content.sizeBytes" must be a finite number/,
    );
  });

  it('patchEntity rejects mistyped/unknown content keys before any write', async () => {
    const { facade, ids } = createRig();
    const doc = await facade.getEntity(ids.docSpec);
    await expectInvalid(
      facade.patchEntity(ids.docSpec, { expectedVersion: doc.version, content: { body: 42 } }),
      /"content.body" must be a string/,
    );
    await expectInvalid(
      facade.patchEntity(ids.docSpec, { expectedVersion: doc.version, content: { workStatus: 'done' } }),
      /unknown field "content.workStatus"/,
    );
    const task = await facade.getEntity(ids.t104);
    await expectInvalid(
      facade.patchEntity(ids.t104, { expectedVersion: task.version, content: { status: 'banana' } }),
      /unknown field "content.status"/,
    );
    const after = await facade.getEntity(ids.docSpec);
    expect(after.version).toBe(doc.version);
  });

  it('moveEntity requires an explicit parentId (null allowed) and numeric position', async () => {
    const { facade, ids } = createRig();
    const t = await facade.getEntity(ids.t103a);
    await expectInvalid(
      facade.moveEntity(ids.t103a, { position: 0, expectedVersion: t.version } as MoveEntityInput),
      /missing required field "parentId"/,
    );
    await expectInvalid(
      facade.moveEntity(ids.t103a, { parentId: ids.t103, position: 'first', expectedVersion: t.version } as unknown as MoveEntityInput),
      /"position" must be a finite number/,
    );
    const res = await facade.moveEntity(ids.t103a, { parentId: null, position: 99, expectedVersion: t.version, actorId: ids.subhang });
    expect(res.entity?.parentId).toBeNull();
  });
});

describe('edges, placements, undo', () => {
  it('createEdge/patchEdge reject missing endpoints and props', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.createEdge({ srcId: ids.t101, dstId: ids.docSpec } as CreateEdgeInput),
      /missing required field "type"/,
    );
    await expectInvalid(
      facade.patchEdge('edge_whatever', {} as unknown as Parameters<typeof facade.patchEdge>[1]),
      /missing required field "props"/,
    );
  });

  it('placements rejects a bad intent and unknown fields', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.placements({ sourceId: ids.docSpec, targetId: ids.t101, intent: 'staple' } as unknown as PlacementInput),
      /"intent" must be one of attach\|assign\|depend\|subtask\|embed\|reparent/,
    );
    await expectInvalid(
      facade.placements({ sourceId: ids.docSpec, targetId: ids.t101, intent: 'attach', force: true } as unknown as PlacementInput),
      /unknown field "force"/,
    );
  });

  it('undo rejects a malformed token and unknown ctx fields', async () => {
    const { facade } = createRig();
    await expectInvalid(facade.undo(42 as unknown as string), /token must be a string or an UndoToken/);
    await expectInvalid(
      facade.undo('undo_x', { who: 'me' } as unknown as Parameters<typeof facade.undo>[1]),
      /unknown field "who"/,
    );
  });

  it('context-only commands reject unknown envelope fields', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.deleteEntity(ids.t103b, { reason: 'cleanup' } as unknown as Parameters<typeof facade.deleteEntity>[1]),
      /deleteEntity: unknown field "reason"/,
    );
    const stillThere = await facade.getEntity(ids.t103b);
    expect(stillThere.deletedAt).toBeNull();
  });
});

describe('messages, reactions, points, completion', () => {
  it('postMessage/patchMessage validate body and mention shapes', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(facade.postMessage({ anchorId: ids.chGeneral } as PostMessageInput), /missing required field "body"/);
    await expectInvalid(
      facade.postMessage({ anchorId: ids.chGeneral, body: 'hi', mentions: [{ entityId: 5 }] } as unknown as PostMessageInput),
      /"mentions\[0\].entityId" must be a string/,
    );
    await expectInvalid(
      facade.postMessage({ anchorId: ids.chGeneral, body: 'hi', mentions: [{ entityId: ids.mira, kind: 'robot', display: '@mira' }] } as unknown as PostMessageInput),
      /"mentions\[0\].kind" must be one of member\|team_member/,
    );
    await expectInvalid(
      facade.patchMessage(ids.forgeProgressMessage, { text: 'edited' } as unknown as Parameters<typeof facade.patchMessage>[1]),
      /missing required field "body"/,
    );
    await expectInvalid(
      facade.patchMessage(ids.forgeProgressMessage, { body: 'edited', text: 'x' } as unknown as Parameters<typeof facade.patchMessage>[1]),
      /unknown field "text"/,
    );
  });

  it('setReaction validates the closed reaction set and the enabled flag', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.setReaction(ids.docSpec, { reaction: 'love', enabled: true } as unknown as ReactionInput),
      /"reaction" must be one of like\|dislike\|star/,
    );
    await expectInvalid(
      facade.setReaction(ids.docSpec, { reaction: 'like' } as ReactionInput),
      /missing required field "enabled"/,
    );
    await expectInvalid(
      facade.setReaction(ids.docSpec, { reaction: 'like', enabled: 'yes' } as unknown as ReactionInput),
      /"enabled" must be a boolean/,
    );
  });

  it('grantPoints and completeTask validate amounts, reasons and completer lists', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.grantPoints(ids.forge, { amount: 'ten', reason: 'grant' } as unknown as GrantPointsInput),
      /"amount" must be a finite number/,
    );
    await expectInvalid(
      facade.grantPoints(ids.forge, { amount: 5, reason: 'bribe' } as unknown as GrantPointsInput),
      /"reason" must be one of grant\|award\|seed/,
    );
    const t = await facade.getEntity(ids.t101);
    await expectInvalid(
      facade.completeTask(ids.t101, { expectedVersion: t.version, completerIds: ids.forge } as unknown as CompleteTaskInput),
      /"completerIds" must be an array/,
    );
    await expectInvalid(
      facade.completeTask(ids.t101, { completerIds: [ids.forge] } as CompleteTaskInput),
      /missing required field "expectedVersion"/,
    );
  });
});

describe('pull, link-pr, tracking, axes, saved views', () => {
  it('pullEntity requires a numeric pinnedVersion', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(facade.pullEntity(ids.docSpec, {} as PullInput), /missing required field "pinnedVersion"/);
    await expectInvalid(
      facade.pullEntity(ids.docSpec, { pinnedVersion: 'v4' } as unknown as PullInput),
      /"pinnedVersion" must be a finite number/,
    );
  });

  it('linkPr and trackingRefresh validate their shapes', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(facade.linkPr(ids.t101, {} as LinkPrInput), /missing required field "url"/);
    await expectInvalid(facade.linkPr(ids.t101, { url: 248 } as unknown as LinkPrInput), /"url" must be a string/);
    await expectInvalid(
      facade.trackingRefresh({ entityIds: ids.pr241 } as unknown as TrackingRefreshInput),
      /"entityIds" must be an array/,
    );
  });

  it('task axes and saved views validate enums and required fields', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(
      facade.createTaskAxis(ids.space, { name: 'lane', axisValues: [], kind: 'custom', position: 0 } as unknown as TaskAxisInput),
      /"kind" must be one of default\|manual/,
    );
    await expectInvalid(
      facade.createTaskAxis(ids.space, { axisValues: [], kind: 'manual', position: 0 } as TaskAxisInput),
      /missing required field "name"/,
    );
    await expectInvalid(
      facade.createSavedView(ids.space, { name: 'Mine', shareMode: 'public', query: { spaceId: ids.space } } as unknown as SavedViewInput),
      /"shareMode" must be one of private\|space/,
    );
    await expectInvalid(
      facade.createSavedView(ids.space, { name: 'Mine', shareMode: 'private' } as SavedViewInput),
      /missing required field "query"/,
    );
    await expectInvalid(
      facade.updateSavedView(ids.viewDocsTree, { title: 'renamed' } as unknown as Partial<SavedViewInput>),
      /unknown field "title"/,
    );
  });
});

describe('non-object inputs', () => {
  it('rejects null/array/scalar inputs outright', async () => {
    const { facade, ids } = createRig();
    await expectInvalid(facade.setWork(ids.t102, null as unknown as WorkInput), /input must be an object/);
    await expectInvalid(facade.patchEntity(ids.docSpec, [] as unknown as PatchEntityInput), /input must be an object/);
  });
});
