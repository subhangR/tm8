/**
 * Craft workspaces (Craft redesign doc 01a1255d §3, §4; migration 321) against
 * a REAL database: one hidden workspace per (space, identity, craft), its tab
 * commands, the open-crafts list, pruning of pages that left the craft, and
 * which agents may command it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getOperation, type OperationName } from '@tm8/contract';

import type { DbClaims, Querier } from '../../src/db/types.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import { HandlerRegistry } from '../../src/facade/index.js';
import type { RequestContext } from '../../src/http/types.js';
import { WorkspaceBridge } from '../../src/workspace/bridge.js';
import { memberForClaims } from '../../src/workspace/handlers.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../events/pg-harness.js';

const url = TEST_DATABASE_URL;
type Data = Record<string, unknown>;
const describeIfPg = url === undefined ? describe.skip : describe;

interface Tab { id: string; kind: string; entityId: string; pinned: boolean }
interface Ws { workspaceId: string | null; craftId: string; revision: number; open: boolean; position: number; state: { tabs: Tab[]; activeTabId: string } }
interface Result { status: string; reason?: string; tabId?: string; outcome?: string; workspace: Ws }

describeIfPg('craft workspaces over real Postgres (doc 01a1255d §3, §4)', () => {
  let db: TestDb;
  let spaceId: string;
  let member: string;
  let craft: string;
  let other: string;
  let nested: string;
  let page: string;
  let graphPage: string;
  let stray: string;
  let chatAbout: string;
  let chatElsewhere: string;
  let chatSomeoneElse: string;
  let sessionAbout: string;
  let sessionLater: string;
  let sessionUnderChat: string;
  let teammate: string;
  const human = `identity_${randomUUID()}`;
  const stranger = `identity_${randomUUID()}`;
  const bridge = new WorkspaceBridge();
  const registry = new HandlerRegistry();
  const asHuman = { kind: 'bearer', identityId: human, authKind: 'cli' } as const;
  const asChat = (chatId: string) => ({ kind: 'bearer', identityId: human, authKind: 'agent_runtime', runtimeChatId: chatId }) as const;
  const asSession = (workSessionId: string) => ({ kind: 'bearer', identityId: human, authKind: 'agent', workSessionId }) as const;
  const claims = (): DbClaims => ({ identityId: human, nodeAdmin: false, requestId: `req_${randomUUID()}` });
  const frames: Data[] = [];

  interface Call { as?: RequestContext['identity']; params?: Record<string, string>; method?: string }
  const call = async (op: OperationName, body?: unknown, opts: Call = {}): Promise<Data> =>
    ((await registry.get(op)!({
      op: getOperation(op), opName: op, params: { spaceId, ...opts.params }, query: new URLSearchParams(),
      body, requestId: `req_${randomUUID()}`, identity: opts.as ?? asHuman, headers: {}, method: opts.method ?? 'POST', path: '/',
    } as unknown as RequestContext)) as { data: Data }).data;
  const cmd = async (craftId: string, command: string, args?: unknown, opts: Call & { requestId?: string; expectedRevision?: number } = {}) =>
    (await call('workspace.crafts.command', {
      requestId: opts.requestId ?? randomUUID(), command, ...(args === undefined ? {} : { args }),
      ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
    }, { ...opts, params: { craftId } })) as unknown as Result;
  const get = async (craftId: string) => (await call('workspace.crafts.get', undefined, { method: 'GET', params: { craftId } })) as unknown as Ws;
  const list = async () => (await call('workspace.crafts.list', undefined, { method: 'GET' })) as unknown as { items: Ws[]; openCap: number };
  const entities = (ws: Ws) => ws.state.tabs.map((t) => t.entityId);

  const rpc = async <T>(fn: string, args: unknown[]) => db.rpc<T>(claims(), fn, args);
  const createCraft = async (title: string) => (await rpc<{ entity: { id: string } } | { id: string }>('public.create_craft_entity', [spaceId, title, null, '', null, null, `cmid_${randomUUID()}`]));
  const idOf = (r: unknown): string => ((r as { entity?: { id: string } }).entity?.id ?? (r as { id: string }).id);
  const contains = async (src: string, dst: string) => rpc('public.write_edge', [src, dst, 'contains', {}, null, `cmid_${randomUUID()}`]);
  const raw = async (kind: string, parent: string | null = null) => db.asOwner(async (q) => {
    const id = randomUUID();
    await q.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by) values ($1, $2, $3, $4, 0, $5)`, [id, spaceId, kind, parent, member]);
    return id;
  });
  const about = async (src: string, dst: string) => db.asOwner((q) =>
    q.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'about', $4)`, [spaceId, src, dst, member]));
  /** A chat as start_chat makes it: entity, chats row and (when `on`) its `about` edge in ONE transaction. */
  const chat = async (on: string | null, by = human) => db.asOwner(async (q) => {
    const id = randomUUID();
    await q.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by) values ($1, $2, 'chat', null, 0, $3)`, [id, spaceId, member]);
    await q.query(
      `insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool, chat_mode, workdir_mode, cwd,
                                native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
       values ($1, $2, 'Craft chat', $3, 'claude-opus-5', 'anthropic', 'claude-code', 'craft', 'scratch', '/tmp/craft-chat',
               gen_random_uuid(), $4, $5, $6)`,
      [id, spaceId, teammate, by, member, `craft-chat-${randomUUID()}`],
    );
    if (on !== null) {
      await q.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'about', $4)`, [spaceId, id, on, member]);
    }
    return id;
  });
  /** A work session the human started, with its `about` edge written in the same transaction. */
  const sessionOn = async (on: string) => db.asOwner(async (q) => {
    const id = randomUUID();
    await q.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by) values ($1, $2, 'work_session', null, 0, $3)`, [id, spaceId, member]);
    await q.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'about', $4)`, [spaceId, id, on, member]);
    return id;
  });
  const stored = async (craftId: string) => (await db.asOwner((q) => q.query<{ revision: string; open: boolean; last_agent_change_at: Date | null }>(
    `select revision, open, last_agent_change_at from public.workspaces where space_id = $1 and scope_entity_id = $2`, [spaceId, craftId])))[0];

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: human }, 'public.upsert_user_profile', ['Crafter', null, null]);
    spaceId = (await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', ['Craft space', 'craft workspace proof', 'private', null, null])).space.id;
    member = (await memberForClaims(db, { identityId: human }, spaceId))!;
    craft = idOf(await createCraft('Craft A'));
    other = idOf(await createCraft('Craft B'));
    nested = idOf(await createCraft('Nested craft'));
    page = idOf(await rpc('public.create_document', [spaceId, 'Page doc', null, 'body', 'markdown', null, null, null, null, `cmid_${randomUUID()}`]));
    graphPage = idOf(await rpc('public.create_graph_entity', [spaceId, 'Page graph', null, 'flow', '[]', '[]', '{}', null, null, null, `cmid_${randomUUID()}`]));
    stray = idOf(await rpc('public.create_document', [spaceId, 'Not a page', null, 'body', 'markdown', null, null, null, null, `cmid_${randomUUID()}`]));
    await contains(craft, page);
    await contains(craft, graphPage);
    await contains(craft, nested);
    teammate = await raw('team_member');
    await db.asOwner((q) => q.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, 'Crafter', 'worker', 'persona')`, [teammate, member]));
    await db.rpc({ identityId: stranger }, 'public.upsert_user_profile', ['Stranger', null, null]);
    chatAbout = await chat(craft);
    chatElsewhere = await chat(other);
    chatSomeoneElse = await chat(craft, stranger);
    sessionAbout = await sessionOn(craft); // 321: a work session may be `about` something
    sessionLater = await raw('work_session');
    sessionUnderChat = await raw('work_session');
    await db.asOwner((q) => q.query('update public.entities set parent_id = $1 where id = $2', [chatAbout, sessionUnderChat]).catch(() => undefined));

    const service = new WorkspaceService({ db, bridge });
    registerEventHandlers(registry, { db, config: {} as never, workspace: bridge, workspaceService: service, owner: () => Promise.resolve({
      identityId: human, accountId: '00000000-0000-0000-0000-000000000000', username: 'h', isNodeAdmin: false, isOwner: true,
    }) });
    const win = { id: 'conn-craft', identity: { kind: 'auto-owner', identityId: human }, isOpen: true, send: (t: string) => frames.push(JSON.parse(t) as Data), close() {} };
    bridge.register(win as never, human, member, {
      type: 'workspace.register', instanceId: 'win-craft', windowId: 'win-craft', focused: true, visible: true, view: 'tabs', mounted: true, revision: 0, spaceId,
    } as never);
  });

  afterAll(async () => {
    await db?.end();
  });

  it('a craft with no row reads as the overview alone, pinned and closed', async () => {
    const ws = await get(craft);
    expect(ws).toMatchObject({ workspaceId: null, craftId: craft, revision: 0, open: false });
    expect(ws.state).toEqual({ tabs: [{ id: craft, kind: 'craft', entityId: craft, pinned: true }], activeTabId: craft });
    await expect(get(stray)).rejects.toMatchObject({ code: 'not_found', details: { reason: 'craft_not_found' } });
  });

  it('tabs.open opens a direct page (reusing an open one), a nested craft as one tab, and refuses anything else', async () => {
    frames.length = 0;
    const opened = await cmd(craft, 'tabs.open', { kind: 'doc', entityId: page });
    expect(opened).toMatchObject({ status: 'applied', outcome: 'created', workspace: { revision: 1 } });
    expect(opened.workspace.state.activeTabId).toBe(opened.tabId);
    expect(frames).toMatchObject([{ type: 'craft.workspace', spaceId, workspace: { craftId: craft, revision: 1 }, cause: { command: 'tabs.open', actorClass: 'human' } }]);
    expect(await cmd(craft, 'tabs.open', { kind: 'doc', entityId: page })).toMatchObject({ status: 'no_op', outcome: 'reused', tabId: opened.tabId });
    expect(await cmd(craft, 'tabs.open', { kind: 'design', entityId: nested, activate: false })).toMatchObject({ status: 'applied', outcome: 'created' });
    expect(await cmd(craft, 'tabs.open', { kind: 'doc', entityId: stray })).toMatchObject({ status: 'rejected', reason: 'not_a_page' });
    expect(await cmd(craft, 'tabs.open', { kind: 'task', entityId: page })).toMatchObject({ status: 'rejected', reason: 'unsupported_kind' });
    expect(await cmd(craft, 'tabs.open', { kind: 'graph', entityId: page })).toMatchObject({ status: 'rejected', reason: 'invalid_arguments' });
    expect(await cmd(craft, 'tabs.open', { kind: 'doc', entityId: randomUUID() })).toMatchObject({ status: 'rejected', reason: 'entity_unavailable' });
    expect(await cmd(craft, 'tabs.open', { entityId: page })).toMatchObject({ status: 'rejected', reason: 'invalid_arguments' });
    const ws = await get(craft);
    expect(entities(ws)).toEqual([craft, page, nested]);
    expect(ws.state.tabs.map((t) => t.kind)).toEqual(['craft', 'doc', 'craft']);
  });

  it('the overview is pinned: never closed, never moved, nothing before it', async () => {
    expect(await cmd(craft, 'tabs.close', { tabId: craft })).toMatchObject({ status: 'rejected', reason: 'pinned' });
    expect(await cmd(craft, 'tabs.move', { entityId: craft, beforeTabId: null })).toMatchObject({ status: 'rejected', reason: 'pinned' });
    expect(await cmd(craft, 'tabs.move', { entityId: nested, beforeTabId: craft })).toMatchObject({ status: 'rejected', reason: 'pinned' });
    const ws = await get(craft);
    const pageTab = ws.state.tabs[1]!.id;
    expect(await cmd(craft, 'tabs.move', { entityId: nested, beforeTabId: pageTab })).toMatchObject({ status: 'applied' });
    expect(entities((await get(craft)))).toEqual([craft, nested, page]);
    expect(await cmd(craft, 'tabs.activate', { entityId: nested })).toMatchObject({ status: 'applied' });
    expect(await cmd(craft, 'tabs.close', { entityId: nested })).toMatchObject({ status: 'applied' });
    const after = await get(craft);
    expect(entities(after)).toEqual([craft, page]);
    expect(after.state.activeTabId).toBe(after.state.tabs[1]!.id);
    expect(await cmd(craft, 'tabs.close', { entityId: nested })).toMatchObject({ status: 'rejected', reason: 'tab_not_found' });
  });

  it('a stale expectedRevision is a conflict; a retried requestId is the recorded answer', async () => {
    const ws = await get(craft);
    expect(await cmd(craft, 'tabs.activate', { tabId: craft }, { expectedRevision: ws.revision - 1 }))
      .toMatchObject({ status: 'conflict', reason: 'revision_conflict' });
    const requestId = randomUUID();
    const first = await cmd(craft, 'tabs.open', { kind: 'graph', entityId: graphPage }, { requestId });
    expect(await cmd(craft, 'tabs.open', { kind: 'graph', entityId: graphPage }, { requestId })).toEqual(first);
  });

  it('a page whose contains edge is deleted loses its tab in the database at once', async () => {
    const edge = await db.asOwner((q) => q.query<{ id: string }>(`select id from public.edges where src_id = $1 and dst_id = $2 and type = 'contains'`, [craft, graphPage]));
    const before = (await stored(craft))!;
    await rpc('public.delete_edge', [edge[0]!.id, null, `cmid_${randomUUID()}`]);
    const after = (await stored(craft))!;
    expect(Number(after.revision)).toBe(Number(before.revision) + 1);
    const row = (await db.asOwner((q) => q.query<{ state: { tabs: Tab[]; activeTabId: string } }>(
      `select state from public.workspaces where space_id = $1 and scope_entity_id = $2`, [spaceId, craft])))[0]!;
    expect(row.state.tabs.map((t) => t.entityId)).toEqual([craft, page]);
    expect(row.state.tabs.map((t) => t.id)).toContain(row.state.activeTabId);
    frames.length = 0;
    const ws = await get(craft);
    expect(entities(ws)).toEqual([craft, page]);
    expect(ws.revision).toBe(Number(after.revision));
    expect(frames).toEqual([]);
  });

  it('a soft-deleted page is pruned on read and SAVED: by list, and by a command even when refused, never as an agent', async () => {
    const extra = async () => {
      const id = idOf(await rpc('public.create_document', [spaceId, 'Passing page', null, 'body', 'markdown', null, null, null, null, `cmid_${randomUUID()}`]));
      await contains(craft, id);
      expect(await cmd(craft, 'tabs.open', { kind: 'doc', entityId: id, activate: false })).toMatchObject({ status: 'applied' });
      return id;
    };
    const gone = async (id: string) => db.asOwner((q) => q.query('update public.entities set deleted_at = now() where id = $1', [id]));
    const p1 = await extra();
    const p2 = await extra();
    expect((await stored(craft))!.last_agent_change_at).toBeNull();

    await gone(p1);
    let rev = Number((await stored(craft))!.revision);
    frames.length = 0;
    const listed = (await list()).items.find((w) => w.craftId === craft)!;
    expect(entities(listed)).toEqual([craft, page, p2]);
    expect(Number((await stored(craft))!.revision)).toBe(rev + 1);
    expect(listed.revision).toBe(rev + 1);
    expect(frames).toMatchObject([{ type: 'craft.workspace', workspace: { craftId: craft, revision: rev + 1 } }]);

    await gone(p2);
    rev = Number((await stored(craft))!.revision);
    expect(await cmd(craft, 'tabs.close', { tabId: craft }, { as: asChat(chatAbout) })).toMatchObject({ status: 'rejected', reason: 'pinned' });
    const after = (await stored(craft))!;
    expect(Number(after.revision)).toBe(rev + 1);
    expect(after.last_agent_change_at).toBeNull();
    expect(entities(await get(craft))).toEqual([craft, page]);
  });

  it('the open-crafts list: open, order, close (tabs kept)', async () => {
    frames.length = 0;
    expect(await cmd(other, 'craft.open')).toMatchObject({ status: 'applied', workspace: { open: true, craftId: other } });
    expect(frames).toMatchObject([{ type: 'craft.workspaces' }]);
    expect(await cmd(craft, 'craft.open', { beforeCraftId: other })).toMatchObject({ status: 'applied', workspace: { open: true } });
    let l = await list();
    expect(l.openCap).toBe(30);
    expect(l.items.map((w) => [w.craftId, w.open])).toEqual([[craft, true], [other, true]]);
    expect(await cmd(craft, 'craft.move', { beforeCraftId: null })).toMatchObject({ status: 'applied' });
    expect((await list()).items.map((w) => w.craftId)).toEqual([other, craft]);
    expect(await cmd(craft, 'craft.close')).toMatchObject({ status: 'applied', workspace: { open: false } });
    expect(await cmd(craft, 'craft.close')).toMatchObject({ status: 'no_op' });
    expect(await cmd(craft, 'craft.open', { beforeCraftId: stray })).toMatchObject({ status: 'rejected', reason: 'craft_not_found' });
    l = await list();
    expect(l.items.map((w) => [w.craftId, w.open])).toEqual([[other, true], [craft, false]]);
    expect(entities(l.items[1]!)).toEqual([craft, page]);
  });

  it('two list commands at once (any node) both land: the list is read-modify-written under the database lock', async () => {
    const apply = (craftId: string, command: string) => db.rpc(claims(), 'public.craft_workspace_list_apply',
      [spaceId, craftId, command, false, null, JSON.stringify({ tabs: [{ id: craftId, kind: 'craft', entityId: craftId, pinned: true }], activeTabId: craftId }), null, false]);
    await Promise.all([apply(craft, 'craft.open'), apply(other, 'craft.close')]);
    expect((await list()).items.map((w) => [w.craftId, w.open])).toEqual([[other, false], [craft, true]]);
    await Promise.all([apply(craft, 'craft.close'), apply(other, 'craft.open')]);
    expect((await list()).items.map((w) => [w.craftId, w.open])).toEqual([[other, true], [craft, false]]);
  });

  it('craft workspaces are not Home workspaces: not listed, not counted, not active', async () => {
    const home = (await call('workspace.list', undefined, { method: 'GET' })) as { items: Array<{ id: string }> };
    const scoped = await db.asOwner((q) => q.query<{ workspace_id: string }>(`select workspace_id from public.workspaces where space_id = $1 and scope_entity_id is not null`, [spaceId]));
    expect(scoped.length).toBe(2);
    for (const s of scoped) expect(home.items.map((w) => w.id)).not.toContain(s.workspace_id);
    await call('workspace.create', { requestId: randomUUID(), name: 'Craft' });
    expect(((await call('workspace.list', undefined, { method: 'GET' })) as { items: unknown[] }).items).toHaveLength(2);
    await expect(db.asOwner((q) => q.query(`update public.workspaces set open = true where scope_entity_id is null and space_id = $1`, [spaceId])))
      .rejects.toThrow(/workspaces_open_scoped/);
  });

  it('§4: a chat or session started on the craft may command it; any other agent is refused', async () => {
    expect(await cmd(craft, 'tabs.activate', { entityId: page }, { as: asChat(chatAbout) })).toMatchObject({ status: 'applied' });
    expect(await cmd(craft, 'tabs.activate', { tabId: craft }, { as: asSession(sessionAbout) })).toMatchObject({ status: 'applied', workspace: { lastAgentChange: expect.anything() } });
    const refused = { code: 'forbidden', details: { reason: 'not_craft_session' } };
    // Being under the craft's chat is not enough: any session token may name that chat as its parent.
    const parent = await db.asOwner((q) => q.query<{ parent_id: string | null }>('select parent_id from public.entities where id = $1', [sessionUnderChat]));
    expect(parent[0]?.parent_id).toBe(chatAbout);
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: asSession(sessionUnderChat) })).rejects.toMatchObject(refused);
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: asChat(chatElsewhere) })).rejects.toMatchObject(refused);
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: asChat(chatSomeoneElse) })).rejects.toMatchObject(refused);
    await expect(cmd(craft, 'craft.open', undefined, { as: asSession(randomUUID()) })).rejects.toMatchObject(refused);
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: { kind: 'bearer', identityId: human, authKind: 'agent' } })).rejects.toMatchObject(refused);
    const ws = await get(craft);
    expect(ws.state.activeTabId).toBe(craft);
  });

  it('§4 escape: an agent cannot bind itself to a craft by writing an `about` edge after it started', async () => {
    // The chat about `other`, and a session about nothing, each add an about edge to `craft` later (an edges.create).
    await about(chatElsewhere, craft);
    await about(sessionLater, craft);
    const refused = { code: 'forbidden', details: { reason: 'not_craft_session' } };
    await expect(cmd(craft, 'tabs.activate', { entityId: page }, { as: asChat(chatElsewhere) })).rejects.toMatchObject(refused);
    await expect(cmd(craft, 'craft.open', undefined, { as: asSession(sessionLater) })).rejects.toMatchObject(refused);
    // A chat with no craft at start, given one later, is no better.
    const bare = await chat(null);
    await about(bare, craft);
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: asChat(bare) })).rejects.toMatchObject(refused);
  });

  it('§4 spawn: only a person, or a chat for its own sessions, binds a session at spawn; nothing binds one later', async () => {
    // The pg harness sets only the four W1 claims; the fifth, tm8.auth_kind, is set here.
    const as = <T>(authKind: string, fn: (q: Querier) => Promise<T>): Promise<T> =>
      db.tx(claims(), async (q) => {
        await q.query("select set_config('tm8.auth_kind', $1, true)", [authKind]);
        return fn(q);
      });
    // As createWorkSession does it: execution_spawn, then work_session_about, in ONE transaction.
    const spawn = async (authKind: string, opts: { about?: string; parent?: string; fromChat?: string } = {}) =>
      as(authKind, async (q) => {
        const r = await q.rpc<{ entity: { id: string } }>('public.execution_spawn', [
          spaceId, teammate, [], null, 'scratch', '/tmp/craft-spawn', null, null, null, null, 'Craft session', null, false, 50, null,
          `cmid_${randomUUID()}`, opts.parent ?? null, null, null, null,
        ]);
        if (opts.about !== undefined || opts.fromChat !== undefined) {
          await q.rpc('public.work_session_about', [r.entity.id, opts.about ?? null, opts.fromChat ?? null]);
        }
        return r.entity.id;
      });
    const refused = { code: 'forbidden', details: { reason: 'not_craft_session' } };

    // A person's spawn with aboutEntityId = the craft.
    const bound = await spawn('cli', { about: craft });
    expect(await cmd(craft, 'tabs.activate', { entityId: page }, { as: asSession(bound) })).toMatchObject({ status: 'applied' });
    expect(await cmd(craft, 'tabs.activate', { tabId: craft }, { as: asSession(bound) })).toMatchObject({ status: 'applied' });
    await as('cli', (q) => q.rpc('public.work_session_about', [bound, craft, null])); // a replay: done

    // The craft chat's runtime spawning under itself: the session inherits what the chat is about.
    const fromChat = await spawn('agent_runtime', { parent: chatAbout, fromChat: chatAbout });
    expect(await cmd(craft, 'tabs.activate', { entityId: page }, { as: asSession(fromChat) })).toMatchObject({ status: 'applied' });
    // ...but a chat about something else cannot bind to this craft.
    await expect(spawn('agent_runtime', { parent: chatElsewhere, fromChat: chatElsewhere, about: craft })).rejects.toMatchObject({ code: '42501' });

    // ESCAPE: an unrelated agent spawns under the craft chat Q. Unbound, it is refused;
    // it cannot bind itself explicitly, nor borrow Q's binding when Q is not its runtime.
    const underQ = await spawn('agent', { parent: chatAbout });
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: asSession(underQ) })).rejects.toMatchObject(refused);
    await expect(spawn('agent', { parent: chatAbout, about: craft })).rejects.toMatchObject({ code: '42501' });
    const notUnderQ = await spawn('agent_runtime', { fromChat: chatAbout }); // parent is not Q: binds nothing
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: asSession(notUnderQ) })).rejects.toMatchObject(refused);
    // A forged call: a worker token (same identity) names the craft chat as parent AND p_from_chat.
    await expect(spawn('agent', { parent: chatAbout, fromChat: chatAbout })).rejects.toMatchObject({ code: '42501' });

    // Later: work_session_about refuses a session from another transaction; an edges.create binds nothing.
    const unbound = await spawn('cli');
    await expect(as('cli', (q) => q.rpc('public.work_session_about', [unbound, craft, null]))).rejects.toMatchObject({ code: '42501' });
    await about(unbound, craft);
    await expect(cmd(craft, 'tabs.activate', { tabId: craft }, { as: asSession(unbound) })).rejects.toMatchObject(refused);
    // The target must be readable.
    await expect(spawn('cli', { about: randomUUID() })).rejects.toMatchObject({ code: 'P0002' });
  });

  it('the list keeps the open flag of a craft the person can no longer see', async () => {
    const gone = idOf(await createCraft('Craft to delete'));
    expect(await cmd(gone, 'craft.open')).toMatchObject({ status: 'applied' });
    await db.asOwner((q) => q.query('update public.entities set deleted_at = now() where id = $1', [gone]));
    expect(await cmd(other, 'craft.move', { beforeCraftId: null })).toMatchObject({ status: 'applied' });
    expect((await stored(gone))!.open).toBe(true);
    expect((await list()).items.map((w) => w.craftId)).not.toContain(gone);
  });
});
