/**
 * Seeded, PINNED fixtures for the entity-context v2 acceptance suite (Module 2:
 * c904 §5 and c761 §10, one shared suite per decision 01a0cf2d-8ae0).
 *
 * Pinned means every id, timestamp and body byte is a constant: two runs of the
 * seed produce byte-identical rows, so a size or statement measurement taken on
 * one run is comparable with the next. Bodies are generated, not random.
 *
 * The fixtures mirror the live entities the specs measured:
 *   T   simple task, ~3.5 KB body, 4 acceptance criteria           (c904 "T")
 *   P   task, ~8 KB body, 10 children of ~4 KB, 1 message           (c904 "P")
 *   D   a 40 KB doc with headings (outline material)                (notebook doc)
 *   X   a synthetic 60 KB-body task
 *   MB  a multi-byte task: 1/2/3/4-byte characters with no newline, so a cut at
 *       the body ceiling and at every offset page boundary lands inside a
 *       character unless the server walks it back
 *   WS  a running work_session with a `working_on` edge to T, `in_project` PJ
 *   CS  its coordinator session (WS's parent)
 *   C   a chat with 12 messages (more than the 10 a chat keeps in its core)
 *   PJ  a project
 * Visibility fixtures:
 *   H   a hidden (restricted, unreadable) child of P — "a hidden peer"
 *   RP  a restricted parent, and U a readable task whose parentId names it
 *       — "a root-named unreadable ref"
 * Blocker/gate fixture (c761 test 6):
 *   G   a `pr_merged` task that `depends_on` an open task B and `tracks` PR
 *
 * Seeded as `tm8_graph_owner` with direct inserts, the same way
 * `test/db/w2-feed-context.pg.test.ts` seeds, because the suite is about the
 * READ; going through the command RPCs would drag the whole command ledger into
 * a fixture that needs none of it.
 */
import type { PoolClient } from 'pg';

import type { W1ScratchDatabase } from '../../db/w1-pg.js';

const id = (n: number): string => `01a0c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const IDENTITY = 'ctx-v2-member';
export const OUTSIDER_IDENTITY = 'ctx-v2-outsider';

export const F = {
  space: id(0x01),
  member: id(0x02),
  teammate: id(0x03),
  coordinatorTeammate: id(0x04),
  root: id(0x10),
  T: id(0x11),
  P: id(0x12),
  D: id(0x13),
  X: id(0x14),
  MB: id(0x15),
  WS: id(0x16),
  CS: id(0x17),
  C: id(0x18),
  PJ: id(0x19),
  H: id(0x1a),
  RP: id(0x1b),
  U: id(0x1c),
  G: id(0x1d),
  B: id(0x1e),
  PR: id(0x1f),
  projectRow: id(0x20),
  pChildren: Array.from({ length: 10 }, (_, i) => id(0x100 + i)),
  pMessage: id(0x200),
  chatMessages: Array.from({ length: 12 }, (_, i) => id(0x300 + i)),
  wsMessages: Array.from({ length: 3 }, (_, i) => id(0x400 + i)),
  csMessages: Array.from({ length: 2 }, (_, i) => id(0x500 + i)),
} as const;

// ---------------------------------------------------------------------------
// Deterministic bodies
// ---------------------------------------------------------------------------

const WORDS = [
  'context', 'budget', 'section', 'assignment', 'ceiling', 'cursor', 'offset', 'blocker',
  'session', 'message', 'expand', 'bounded', 'measure', 'fixture', 'minified', 'envelope',
];

/** Markdown of exactly `bytes` UTF-8 bytes: a heading every `headingEvery` bytes. */
export function markdownBody(label: string, bytes: number, headingEvery = 2048): string {
  let out = `## ${label}\n`;
  let n = 0;
  let sinceHeading = 0;
  while (Buffer.byteLength(out, 'utf8') < bytes) {
    if (sinceHeading >= headingEvery) {
      out += `\n### ${label} part ${Math.floor(n / 100)}\n`;
      sinceHeading = 0;
    }
    const line = `${n}. ${Array.from({ length: 9 }, (_, i) => WORDS[(n * 7 + i * 3) % WORDS.length]).join(' ')}.\n`;
    out += line;
    sinceHeading += line.length;
    n += 1;
  }
  return Buffer.from(out, 'utf8').subarray(0, bytes).toString('utf8');
}

/**
 * The multi-byte body. The repeating unit `a é 中 😀` is 1+2+3+4 = 10 bytes
 * over 4 code points, so 6 of every 10 byte positions sit INSIDE a character:
 * a byte-count cut that does not walk back to a boundary splits one. There is
 * no newline, so "prefer a line boundary" cannot hide the straddle.
 */
export function multiByteBody(bytes: number): string {
  const unit = 'aé中😀';
  return unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit, 'utf8')));
}

export const BODIES = {
  T: markdownBody('Problem (fixture T)', 3_495),
  P: markdownBody('Program (fixture P)', 8_004),
  pChild: (i: number) => markdownBody(`Child ${i} of P`, 4_000),
  D: markdownBody('Notebook (fixture D)', 40_000),
  X: markdownBody('Synthetic (fixture X)', 60_000),
  MB: multiByteBody(40_000),
  // Messages: some over 500 and some over 280 chars, so per-row truncation shows.
  message: (label: string, i: number) =>
    `${label} #${i}: ${markdownBody(label, i % 3 === 0 ? 720 : i % 3 === 1 ? 400 : 120).replace(/\n/g, ' ')}`,
};

export const T_ACCEPTANCE = [
  { id: 'a1', done: false, text: 'Current output measured on real entities with useful vs noise called out' },
  { id: 'a2', done: true, text: 'Alternatives proposed with example responses and projected sizes' },
  { id: 'a3', done: false, text: 'Every open decision answered by the user, not assumed' },
  { id: 'a4', done: false, text: 'Agreed spec doc attached with examples, expansion paths and tests' },
];

const AT = (minute: number): string =>
  new Date(Date.UTC(2026, 8, 23, 12, 0, 0) + minute * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function entity(
  c: PoolClient,
  rowId: string,
  kind: string,
  options: { parent?: string | null; visibility?: 'space' | 'restricted'; by?: string; at?: string } = {},
): Promise<void> {
  await c.query(
    `insert into public.entities(id,space_id,kind,parent_id,created_by,visibility,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz)`,
    [rowId, F.space, kind, options.parent ?? null, options.by ?? F.member,
      options.visibility ?? 'space', options.at ?? AT(0)],
  );
}

async function task(
  c: PoolClient,
  rowId: string,
  title: string,
  options: {
    parent?: string | null;
    body?: string;
    acceptance?: unknown[];
    status?: string;
    gate?: 'none' | 'pr_merged';
    visibility?: 'space' | 'restricted';
    at?: string;
  } = {},
): Promise<void> {
  await entity(c, rowId, 'task', {
    parent: options.parent ?? null,
    visibility: options.visibility ?? 'space',
    at: options.at ?? AT(0),
  });
  await c.query(
    `insert into public.tasks(entity_id,title,description,acceptance_criteria,work_status,completion_gate)
     values ($1,$2,$3,$4::jsonb,$5,$6)`,
    [rowId, title, options.body ?? '', JSON.stringify(options.acceptance ?? []),
      options.status ?? 'working', options.gate ?? 'none'],
  );
}

async function message(
  c: PoolClient,
  rowId: string,
  anchorId: string,
  body: string,
  at: string,
  author: string = F.teammate,
): Promise<void> {
  await entity(c, rowId, 'message', { by: author, at });
  await c.query(
    `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body,created_at)
     values ($1,$2,null,$3,$4,$5::timestamptz)`,
    [rowId, anchorId, author, body, at],
  );
}

async function edge(c: PoolClient, src: string, dst: string, type: string): Promise<void> {
  const assignment = type === 'assigned_to';
  await c.query(
    `insert into public.edges(space_id,src_id,dst_id,type,created_by,assigned_by,assigned_at,created_at)
     values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz)`,
    [F.space, src, dst, type, F.member, assignment ? F.coordinatorTeammate : null,
      assignment ? AT(1) : null, AT(1)],
  );
}

export async function seedContextV2Fixtures(database: W1ScratchDatabase): Promise<void> {
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');

    await c.query(
      `insert into public.user_profiles(identity_id,display_name) values ($1,'Fixture Owner'),($2,'Fixture Outsider')`,
      [IDENTITY, OUTSIDER_IDENTITY],
    );
    await c.query(
      `insert into public.spaces(id,name,created_by_identity) values ($1,'Context v2 fixtures',$2)`,
      [F.space, IDENTITY],
    );
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility,created_at,updated_at)
       values ($1,$4,'member',$1,'space',$5::timestamptz,$5::timestamptz),
              ($2,$4,'team_member',$1,'space',$5::timestamptz,$5::timestamptz),
              ($3,$4,'team_member',$1,'space',$5::timestamptz,$5::timestamptz)`,
      [F.member, F.teammate, F.coordinatorTeammate, F.space, AT(0)],
    );
    await c.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values ($1,$2,$3,'owner','Fixture Owner')`,
      [F.member, F.space, IDENTITY],
    );
    await c.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity,model,agent_tool)
       values ($1,$3,'Opus 5.5 1M Teammate','worker','ctx-v2-worker','claude-opus-5-5[1m]','claude-code'),
              ($2,$3,'Opus 5 1M Teammate','coordinator','ctx-v2-coordinator','claude-opus-5','claude-code')`,
      [F.teammate, F.coordinatorTeammate, F.member],
    );

    // --- the task tree: root → {T, P, X, MB, U-chain, G} -------------------
    await task(c, F.root, 'Module fixture: entity context v2', { body: 'Fixture root.' });
    await task(c, F.T, 'Align: byte budgets that never drop the assignment', {
      parent: F.root, body: BODIES.T, acceptance: T_ACCEPTANCE, at: AT(2),
    });
    await edge(c, F.T, F.teammate, 'assigned_to');

    await task(c, F.P, 'Work on: tm8 context research: complete notebook, data and evidence', {
      parent: F.root, body: BODIES.P, at: AT(3),
      acceptance: [{ id: 'a1', done: false, text: 'Notebook complete' }],
    });
    for (const [i, childId] of F.pChildren.entries()) {
      await task(c, childId, `Align: child ${i + 1} of P, a compact receipt for one mutation family`, {
        parent: F.P,
        body: BODIES.pChild(i + 1),
        // Open children first, then most recent — so mix statuses and times.
        status: i % 4 === 3 ? 'done' : 'working',
        at: AT(10 + i),
        acceptance: Array.from({ length: 4 }, (_, k) => ({
          id: `a${k + 1}`, done: k === 0 || i % 4 === 3, text: `Child ${i + 1} criterion ${k + 1}: measured and recorded`,
        })),
      });
      await edge(c, childId, F.teammate, 'assigned_to');
    }
    // H: a hidden peer among P's children. `restricted` on a non-project kind
    // is unreadable to every tm8_app caller (internal.entity_row_visible).
    await task(c, F.H, 'HIDDEN child of P — must never surface', {
      parent: F.P, visibility: 'restricted', body: 'hidden', at: AT(30),
    });
    await message(c, F.pMessage, F.P, 'Coordinator: the header ruling changed; see the decision log.', AT(40));

    await task(c, F.X, 'Synthetic: a 60 KB assignment body', { parent: F.root, body: BODIES.X, at: AT(4) });
    await task(c, F.MB, 'Synthetic: multi-byte body straddling the ceiling', {
      parent: F.root, body: BODIES.MB, at: AT(5),
    });

    // RP is restricted; U is readable and NAMES it as its parent.
    await task(c, F.RP, 'RESTRICTED parent — unreadable', { visibility: 'restricted', at: AT(6) });
    await task(c, F.U, 'Readable task under an unreadable parent', {
      parent: F.RP, body: 'U body', at: AT(7),
    });

    // G: gated on pr_merged, blocked by open task B, tracking one PR.
    await task(c, F.B, 'Blocker: open dependency of G', { parent: F.root, status: 'open', at: AT(8) });
    await task(c, F.G, 'Gated: ships when its PR merges', {
      parent: F.root, body: 'G body', gate: 'pr_merged', at: AT(9),
    });
    await edge(c, F.G, F.B, 'depends_on');
    await entity(c, F.PR, 'pull_request', { at: AT(9) });
    await c.query(
      `insert into public.pull_requests(entity_id,space_id,provider,url,repo,number,title,state,ci_status)
       values ($1,$2,'github','https://github.com/example/tm8/pull/9001','example/tm8',9001,
               'Fixture PR','open','pending')`,
      [F.PR, F.space],
    );
    await edge(c, F.G, F.PR, 'tracks');

    // --- D: the 40 KB doc -----------------------------------------------
    await entity(c, F.D, 'doc', { at: AT(20) });
    await c.query(
      `insert into public.documents(entity_id,title,body,format) values ($1,$2,$3,'markdown')`,
      [F.D, 'Research notebook: tm8 context (fixture D)', BODIES.D],
    );

    // --- PJ: a project --------------------------------------------------
    await c.query(
      `insert into public.projects(id,name,working_dir) values ($1,'tm8 fixture project','/tmp/ctx-v2-fixture')`,
      [F.projectRow],
    );
    // Project projections are materializer-owned (015); seed as that writer so
    // the projection keeps a pinned id.
    await c.query(`select internal.w1_set_writer('project_materializer')`);
    await entity(c, F.PJ, 'project', { at: AT(21) });
    await c.query(
      `insert into public.project_projection_details(entity_id,project_id,name) values ($1,$2,'tm8 fixture project')`,
      [F.PJ, F.projectRow],
    );
    await c.query(
      `insert into public.project_links(space_id,project_id,project_entity_id) values ($1,$2,$3)`,
      [F.space, F.projectRow, F.PJ],
    );
    await c.query(`select internal.w1_set_writer(null)`);
    await c.query(
      `insert into public.space_projects(space_id,project_id,linked_at) values ($1,$2,$3::timestamptz)`,
      [F.space, F.projectRow, AT(21)],
    );

    // --- CS (coordinator) → WS (worker), WS working_on T ----------------
    for (const [sessionId, parent, title, branch] of [
      [F.CS, null, 'Module 2 coordinator', 'tm8/coordinator'],
      [F.WS, F.CS, 'Align: byte budgets that never drop the assignment', 'tm8/01a0cf17-ff23'],
    ] as const) {
      await entity(c, sessionId, 'work_session', { parent, at: AT(22) });
      await c.query(
        `insert into public.work_sessions(entity_id,title,status,share_mode,agent_tool,model,
                                          checkout_branch,started_at,skills,drive_mode,workdir_mode)
         values ($1,$2,'running','space','claude-code','claude-opus-5-5[1m]',$3,$4::timestamptz,
                 '[]'::jsonb,'owner','project')`,
        [sessionId, title, branch, AT(22)],
      );
    }
    await edge(c, F.WS, F.T, 'working_on');
    await edge(c, F.WS, F.PJ, 'in_project');
    for (const [i, messageId] of F.wsMessages.entries()) {
      await message(c, messageId, F.WS, BODIES.message('worker note', i), AT(50 + i));
    }
    for (const [i, messageId] of F.csMessages.entries()) {
      await message(c, messageId, F.CS, BODIES.message('coordinator note', i), AT(60 + i),
        F.coordinatorTeammate);
    }

    // --- C: a chat with 12 turns, anchored flat (176) -------------------
    await entity(c, F.C, 'chat', { at: AT(70) });
    await c.query(
      `insert into public.chats(entity_id,space_id,title,teammate_id,model,provider,agent_tool,
                                chat_mode,workdir_mode,cwd,native_session_id,
                                configured_by_identity_id,configured_by_member_id,client_mutation_id)
       values ($1,$2,'Fixture chat',$3,'opus','anthropic','claude-code','ask','scratch',
               '/tmp/ctx-v2-chat','00000000-0000-4000-8000-00000000c4a7',$4,$5,'ctx-v2-chat-1')`,
      [F.C, F.space, F.teammate, IDENTITY, F.member],
    );
    for (const [i, messageId] of F.chatMessages.entries()) {
      await message(c, messageId, F.C, BODIES.message('chat turn', i), AT(71 + i),
        i % 2 === 0 ? F.member : F.teammate);
    }
  });
}
