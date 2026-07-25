/**
 * KindRegistry — all 11 entity kinds as data (one `KindEntry` each) plus the
 * tombstone spec. This file is the ONLY place in the entity component system
 * allowed to branch on `kind`; everything in `entity/` and above renders by
 * looking the entry up. Adding a kind = adding an entry here.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Avatar, Pill, labelForWorkStatus, toneForWorkStatus } from '../kit';
import type { PillTone } from '../kit';
import type {
  EntityContent, EntityDetail, EntityKind, EntityState, EntitySummary,
  WorkStatus,
} from '../types/contract';
import type { CollabFacade } from '../facade';
import { formatBytes, relTime, shortSha, truncate } from './format';
import type {
  BooleanCapability, CreationSchema, KindCreateInput, KindEntry, PrimaryAction,
  RegistryCtx, TombstoneSpec,
} from './types';

// ---------------------------------------------------------------------------
// helpers (registry-internal)
// ---------------------------------------------------------------------------

type StateOf<K extends EntityState['kind']> = Extract<EntityState, { kind: K }>;
type ContentOf<K extends EntityContent['kind']> = Extract<EntityContent, { kind: K }>;

/** Narrow a summary's discriminated state to this entry's kind (or null). */
function stateOf<K extends EntityState['kind']>(s: EntitySummary, kind: K): StateOf<K> | null {
  return s.state.kind === kind ? (s.state as StateOf<K>) : null;
}
function contentOf<K extends EntityContent['kind']>(d: EntityDetail, kind: K): ContentOf<K> | null {
  return d.content.kind === kind ? (d.content as ContentOf<K>) : null;
}

/** The spell/skill arm shares one union member, so Extract-by-kind is never. */
type KitState = Extract<EntityState, { kind: 'spell' | 'skill' }>;
function kitStateOf(s: EntitySummary): KitState | null {
  return s.state.kind === 'spell' || s.state.kind === 'skill' ? (s.state as KitState) : null;
}

const statusTintVar: Record<string, string> = {
  working: 'var(--cv2-status-working)',
  done: 'var(--cv2-status-done)',
  blocked: 'var(--cv2-status-blocked)',
  review: 'var(--cv2-status-review)',
  waiting: 'var(--cv2-status-stale)',
  stale: 'var(--cv2-status-stale)',
};
const INK = 'var(--pn-ink-3)';
const BRAND = 'var(--pn-brand)';

function tintForTone(tone: PillTone): string {
  return statusTintVar[tone] ?? INK;
}

const WORK_STATUSES: WorkStatus[] = ['open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cv2-field">
      <span className="cv2-field__label">{label}</span>
      <span className="cv2-field__value">{children}</span>
    </div>
  );
}

/** Generic key→value rows for loosely-typed content (tracking, file, kit). */
function ContentRecord({ detail, omit = [] }: { detail: EntityDetail; omit?: string[] }) {
  const skip = new Set(['kind', ...omit]);
  const rows = Object.entries(detail.content as Record<string, unknown>)
    .filter(([k, v]) => !skip.has(k) && v != null && typeof v !== 'object');
  if (rows.length === 0) return null;
  return (
    <div className="cv2-kv">
      {rows.map(([k, v]) => (
        <Field key={k} label={k}>
          <span className="t-mono">{String(v)}</span>
        </Field>
      ))}
    </div>
  );
}

function EntityChipRow({ items, ctx, empty }: { items: EntitySummary[]; ctx: RegistryCtx; empty: string }) {
  if (items.length === 0) return <p className="cv2-empty-line">{empty}</p>;
  return (
    <div className="cv2-chiprow">
      {items.map((e) => <ctx.Chip key={e.id} entity={e} />)}
    </div>
  );
}

/** Message bodies carry `{{embed:<entityId>}}` tokens (W0 gotcha). */
const EMBED_RE = /\{\{embed:([^}]+)\}\}/g;
function MessageBody({ body, ctx }: { body: string; ctx: RegistryCtx }) {
  const parts = body.split(EMBED_RE);
  return (
    <div className="cv2-msgbody">
      {parts.map((part, i) => (
        i % 2 === 1
          ? <div key={`e${i}`} className="cv2-msgbody__embed"><ctx.CardById entityId={part} /></div>
          : (part.trim() ? <p key={`t${i}`}>{part}</p> : null)
      ))}
    </div>
  );
}

/**
 * Create dispatch through the canonical generic seam (DEV-1). Each creatable
 * entry declares `createVia: createViaEntity('<kind>')` so creation UIs never
 * branch per kind (DEF-10) — including tasks, whose deprecated `createTask`
 * wrapper is bypassed on purpose.
 */
function createViaEntity(kind: Exclude<EntityKind, 'message' | 'member'>) {
  return (facade: CollabFacade, input: KindCreateInput) => facade.createEntity({
    spaceId: input.spaceId, kind, title: input.title,
    attachTo: input.attachTo, content: input.content,
  });
}

// ---------------------------------------------------------------------------
// creation schemas (data only — W4/W6 render the forms)
// ---------------------------------------------------------------------------

const taskCreation: CreationSchema = {
  titleLabel: 'Task title',
  fields: [
    { name: 'description', label: 'Description', type: 'textarea', placeholder: 'What needs to happen?' },
    { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high', 'urgent'] },
    { name: 'dueDate', label: 'Due date', type: 'date' },
  ],
};
const channelCreation: CreationSchema = {
  titleLabel: 'Channel name',
  fields: [{ name: 'topic', label: 'Topic', type: 'textarea', placeholder: 'What is this channel for?' }],
};
const docCreation: CreationSchema = {
  titleLabel: 'Doc title',
  fields: [
    { name: 'format', label: 'Format', type: 'select', options: ['markdown', 'mermaid', 'excalidraw'], required: true },
    { name: 'body', label: 'Body', type: 'textarea' },
  ],
};
const teamMemberCreation: CreationSchema = {
  titleLabel: 'Agent name',
  fields: [
    { name: 'identity', label: 'Identity', type: 'textarea', placeholder: 'Who is this agent?' },
    { name: 'model', label: 'Model', type: 'text' },
    { name: 'agentTool', label: 'Agent tool', type: 'text' },
  ],
};
const fileCreation: CreationSchema = {
  titleLabel: 'File name',
  fields: [
    { name: 'mimeType', label: 'MIME type', type: 'text', placeholder: 'application/pdf' },
    { name: 'sizeBytes', label: 'Size (bytes)', type: 'number' },
  ],
};
const spellCreation: CreationSchema = {
  titleLabel: 'Spell name',
  fields: [{ name: 'description', label: 'Description', type: 'textarea' }],
};
const skillCreation: CreationSchema = {
  titleLabel: 'Skill name',
  fields: [{ name: 'description', label: 'Description', type: 'textarea' }],
};
const prCreation: CreationSchema = {
  titleLabel: 'Pull request title',
  fields: [
    { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repo' },
    { name: 'number', label: 'PR number', type: 'number', required: true },
  ],
};

// ---------------------------------------------------------------------------
// the 11 entries
// ---------------------------------------------------------------------------

const channel: KindEntry = {
  kind: 'channel',
  label: 'Channel',
  labelPlural: 'Channels',
  glyph: '#',
  tint: (s) => ((stateOf(s, 'channel')?.workingAgentCount ?? 0) > 0 ? tintForTone('working') : 'var(--pn-info)'),
  chipLabel: (s) => s.title,
  chipMeta: (s) => {
    const st = stateOf(s, 'channel');
    return st && st.unreadCount > 0 ? String(st.unreadCount) : null;
  },
  chipPulse: (s) => (stateOf(s, 'channel')?.workingAgentCount ?? 0) > 0,
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'channel');
    if (!st) return null;
    return (
      <>
        {st.topic && <div className="cv2-field cv2-field--wide">{truncate(st.topic, 90)}</div>}
        <div className="cv2-field">
          {st.unreadCount > 0
            ? <Pill tone="brand" dot={false}>{st.unreadCount} unread</Pill>
            : <span className="cv2-field__value">no unread</span>}
          {st.workingAgentCount > 0 && (
            <Pill tone="working" pulse>🤖 {st.workingAgentCount} working</Pill>
          )}
        </div>
      </>
    );
  },
  Content: ({ detail, ctx }) => {
    const content = contentOf(detail, 'channel');
    if (!content) return null;
    return (
      <div className="cv2-content">
        {content.topic && <p className="t-body">{content.topic}</p>}
        <div className="cv2-content__section">
          <span className="cv2-eyebrow">Pinned</span>
          <EntityChipRow items={content.pinned} ctx={ctx} empty="Nothing pinned yet." />
        </div>
        <div className="cv2-content__section">
          <span className="cv2-eyebrow">Hub tabs</span>
          <div className="cv2-chiprow">
            {content.autoTabs.map((t) => (
              <Pill key={t.key} tone="neutral" dot={false}>{t.label} · {t.count}</Pill>
            ))}
          </div>
        </div>
        <p className="cv2-empty-line">The live feed renders in the channel hub (Z4).</p>
      </div>
    );
  },
  fullLayout: 'hub',
  status: {
    current: (s) => {
      const st = stateOf(s, 'channel');
      if (!st) return null;
      if (st.workingAgentCount > 0) return { label: `${st.workingAgentCount} working`, tone: 'working', pulse: true };
      if (st.unreadCount > 0) return { label: `${st.unreadCount} unread`, tone: 'brand' };
      return { label: 'quiet', tone: 'idle' };
    },
  },
  patchTitle: (facade, d, title) => facade.patchEntity(d.id, { expectedVersion: d.version, title }),
  primaryActions: (d) => [
    { id: 'open-hub', label: 'Open hub', title: 'Open the channel hub (Z4)', run: ({ nav }) => nav.promote(d.id) },
  ],
  creation: channelCreation,
  capabilities: { workStatusBearing: false, treeReparentable: true, markReadAnchor: true, actor: null },
  createVia: createViaEntity('channel'),
  paletteCreate: { keywords: 'new channel add' },
  collectionEmptyHint: 'no channels yet — press',
};

const task: KindEntry = {
  kind: 'task',
  label: 'Task',
  labelPlural: 'Tasks',
  glyph: '☑',
  tint: (s) => {
    const st = stateOf(s, 'task');
    return st ? tintForTone(toneForWorkStatus(st.workStatus)) : INK;
  },
  chipLabel: (s) => s.title,
  chipMeta: () => null,
  chipPulse: (s) => stateOf(s, 'task')?.workStatus === 'working',
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'task');
    if (!st) return null;
    return (
      <>
        <div className="cv2-field">
          <Pill tone={toneForWorkStatus(st.workStatus)}>{labelForWorkStatus(st.workStatus)}</Pill>
          <span className="cv2-field__value">{st.priority}</span>
          {st.dueDate && <span className="cv2-field__value t-mono">due {st.dueDate.slice(0, 10)}</span>}
        </div>
        <div className="cv2-field">
          {st.acceptance.total > 0 && (
            <span className="cv2-field__value t-mono">✓ {st.acceptance.completed}/{st.acceptance.total}</span>
          )}
          {st.assignees.length > 0 && (
            <span className="cv2-avatarrow">
              {st.assignees.map((a) => <Avatar key={a.id} actor={a} size={18} />)}
            </span>
          )}
        </div>
      </>
    );
  },
  Content: ({ detail }) => {
    const content = contentOf(detail, 'task');
    const st = stateOf(detail, 'task');
    if (!content || !st) return null;
    return (
      <div className="cv2-content">
        {content.description
          ? <p className="t-body cv2-prewrap">{content.description}</p>
          : <p className="cv2-empty-line">No description yet.</p>}
        <div className="cv2-kv">
          <Field label="priority">{st.priority}</Field>
          {st.dueDate && <Field label="due"><span className="t-mono">{st.dueDate.slice(0, 10)}</span></Field>}
          {content.pointsEstimate != null && <Field label="estimate"><span className="t-mono">{content.pointsEstimate} pts</span></Field>}
          {Object.entries(st.axes).map(([axis, value]) => (
            <Field key={axis} label={axis}><span className="t-mono">{value}</span></Field>
          ))}
        </div>
        {content.acceptanceCriteria.length > 0 && (
          <div className="cv2-content__section">
            <span className="cv2-eyebrow">Acceptance · {st.acceptance.completed}/{st.acceptance.total}</span>
            <ul className="cv2-acceptance">
              {content.acceptanceCriteria.map((c) => (
                <li key={c.id} data-done={c.done || undefined}>
                  <span aria-hidden="true">{c.done ? '☑' : '☐'}</span> {c.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  },
  fullLayout: 'subtree',
  status: {
    current: (s) => {
      const st = stateOf(s, 'task');
      if (!st) return null;
      return {
        label: labelForWorkStatus(st.workStatus),
        tone: toneForWorkStatus(st.workStatus),
        pulse: st.workStatus === 'working',
      };
    },
    options: () => WORK_STATUSES.map((value) => (
      value === 'done'
        // W0 gotcha: setWork('done') rejects — completion goes through completeTask.
        ? { value, label: 'done', disabled: true, hint: 'use Complete' }
        : { value, label: labelForWorkStatus(value) }
    )),
    set: (facade, d, value) => facade.setWork(d.id, { status: value as WorkStatus }),
  },
  patchTitle: (facade, d, title) => facade.patchTask(d.id, { expectedVersion: d.version, title }),
  primaryActions: (d) => {
    const st = stateOf(d, 'task');
    const actions: PrimaryAction[] = [];
    if (st && st.workStatus !== 'working' && st.workStatus !== 'done') {
      actions.push({
        id: 'start-working',
        label: 'Start',
        title: 'Set status to working',
        run: ({ facade }) => facade.setWork(d.id, { status: 'working' }),
      });
    }
    if (d.capabilities.canComplete && st && st.workStatus !== 'done') {
      actions.push({
        id: 'complete',
        label: 'Complete…',
        title: 'Complete the task and award its point pool',
        run: ({ facade }) => facade.completeTask(d.id, {
          expectedVersion: d.version,
          completerIds: st.assignees.length > 0 ? st.assignees.map((a) => a.id) : [d.createdBy.id],
        }),
      });
    }
    return actions;
  },
  creation: taskCreation,
  capabilities: { workStatusBearing: true, treeReparentable: true, markReadAnchor: true, actor: null },
  createVia: createViaEntity('task'),
  paletteCreate: { keywords: 'new task add' },
  collectionEmptyHint: 'no tasks linked yet — drag one here, or press',
};

const message: KindEntry = {
  kind: 'message',
  label: 'Message',
  labelPlural: 'Messages',
  glyph: '💬',
  tint: () => INK,
  chipLabel: (s) => truncate(s.excerpt ?? s.title, 48),
  chipMeta: () => null,
  chipPulse: () => false,
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'message');
    if (!st) return null;
    return (
      <>
        <div className="cv2-field">
          <Avatar actor={st.author} size={18} />
          <span className="cv2-field__value cv2-field__value--strong">{st.author.displayName}</span>
          {st.author.isAgent && <span className="cv2-agentbadge">AGENT</span>}
          {st.editedAt && <span className="cv2-field__value t-mono">edited</span>}
        </div>
        {entity.excerpt && <div className="cv2-field cv2-field--wide">{truncate(entity.excerpt, 110)}</div>}
      </>
    );
  },
  Content: ({ detail, ctx }) => {
    const content = contentOf(detail, 'message');
    const st = stateOf(detail, 'message');
    if (!content || !st) return null;
    return (
      <div className="cv2-content">
        <div className="cv2-field">
          <Avatar actor={st.author} size={20} />
          <span className="cv2-field__value cv2-field__value--strong">{st.author.displayName}</span>
          {st.author.isAgent && <span className="cv2-agentbadge">AGENT</span>}
        </div>
        <MessageBody body={content.body} ctx={ctx} />
        {content.mentions.length > 0 && (
          <div className="cv2-content__section">
            <span className="cv2-eyebrow">Mentions</span>
            <div className="cv2-chiprow">
              {content.mentions.map((m) => <ctx.ChipById key={m.entityId} entityId={m.entityId} />)}
            </div>
          </div>
        )}
        {content.attachments.length > 0 && (
          <div className="cv2-content__section">
            <span className="cv2-eyebrow">Attachments</span>
            <div className="cv2-chiprow">
              {content.attachments.map((a) => <ctx.ChipById key={a.fileEntityId} entityId={a.fileEntityId} />)}
            </div>
          </div>
        )}
      </div>
    );
  },
  fullLayout: 'generic',
  status: {
    current: (s) => (stateOf(s, 'message')?.editedAt ? { label: 'edited', tone: 'neutral' } : null),
  },
  patchTitle: null,
  primaryActions: () => [],
  creation: null,
  creationDisabledReason: 'Messages are written in a thread composer.',
  capabilities: { workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: null },
  createVia: null,
  paletteCreate: null,
  collectionEmptyHint: null,
};

const member: KindEntry = {
  kind: 'member',
  label: 'Member',
  labelPlural: 'Members',
  glyph: '👤',
  tint: () => INK,
  chipLabel: (s) => s.title,
  chipMeta: () => null,
  chipPulse: () => false,
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'member');
    if (!st) return null;
    return (
      <>
        <div className="cv2-field">
          <Pill tone={st.role === 'owner' ? 'brand' : 'neutral'} dot={false}>{st.role}</Pill>
        </div>
        <div className="cv2-field">
          <span className="cv2-field__value t-mono">★ {st.score} pts</span>
          <span className="cv2-field__value t-mono">✓ {st.taskDoneCount} done</span>
        </div>
      </>
    );
  },
  Content: ({ detail, ctx }) => {
    const content = contentOf(detail, 'member');
    if (!content) return null;
    return (
      <div className="cv2-content">
        <div className="cv2-content__section">
          <span className="cv2-eyebrow">Agents</span>
          <EntityChipRow items={content.teamMembers} ctx={ctx} empty="No agents yet." />
        </div>
        <div className="cv2-content__section">
          <span className="cv2-eyebrow">Work</span>
          <EntityChipRow items={content.work} ctx={ctx} empty="No assigned work." />
        </div>
      </div>
    );
  },
  fullLayout: 'profile',
  status: {
    current: (s) => {
      const st = stateOf(s, 'member');
      return st ? { label: st.role, tone: st.role === 'owner' ? 'brand' : 'neutral' } : null;
    },
  },
  patchTitle: null,
  primaryActions: (d) => [
    { id: 'profile', label: 'Profile', title: 'Open the profile page', run: ({ nav }) => nav.promote(d.id) },
  ],
  creation: null,
  creationDisabledReason: 'Members join a space via invite.',
  capabilities: { workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: 'human' },
  createVia: null,
  paletteCreate: null,
  collectionEmptyHint: 'nobody here yet — invite from space settings, or press',
};

const teamMember: KindEntry = {
  kind: 'team_member',
  label: 'Agent',
  labelPlural: 'Agents',
  glyph: '🤖',
  tint: (s) => (stateOf(s, 'team_member')?.liveWork ? tintForTone('working') : BRAND),
  chipLabel: (s) => s.title,
  chipMeta: () => null,
  chipPulse: (s) => stateOf(s, 'team_member')?.liveWork != null,
  SummaryFields: ({ entity, ctx }) => {
    const st = stateOf(entity, 'team_member');
    if (!st) return null;
    return (
      <>
        <div className="cv2-field">
          {st.liveWork
            ? <Pill tone="working" pulse>working</Pill>
            : <Pill tone="idle">idle</Pill>}
          {st.model && <span className="cv2-field__value t-mono">{st.model}</span>}
        </div>
        {st.liveWork && (
          <div className="cv2-field">
            <span className="cv2-field__value">on</span>
            <ctx.Chip entity={st.liveWork.task} variant="ref" />
            <span className="cv2-field__value t-mono">since {relTime(st.liveWork.startedAt)}</span>
          </div>
        )}
        <div className="cv2-field">
          <span className="cv2-field__value">owner</span>
          <Avatar actor={st.owner} size={18} />
          <span className="cv2-field__value">{st.owner.displayName}</span>
        </div>
      </>
    );
  },
  Content: ({ detail, ctx }) => {
    const content = contentOf(detail, 'team_member');
    const st = stateOf(detail, 'team_member');
    if (!content || !st) return null;
    return (
      <div className="cv2-content">
        {content.identity && <p className="t-body cv2-prewrap">{content.identity}</p>}
        <div className="cv2-kv">
          {st.model && <Field label="model"><span className="t-mono">{st.model}</span></Field>}
          {st.agentTool && <Field label="tool"><span className="t-mono">{st.agentTool}</span></Field>}
          <Field label="memories"><span className="t-mono">{content.memories.length}</span></Field>
        </div>
        <div className="cv2-content__section">
          <span className="cv2-eyebrow">Equipped</span>
          <EntityChipRow items={content.equipped} ctx={ctx} empty="Nothing equipped." />
        </div>
        <div className="cv2-content__section">
          <span className="cv2-eyebrow">Work</span>
          <EntityChipRow items={content.work} ctx={ctx} empty="No assigned work." />
        </div>
      </div>
    );
  },
  fullLayout: 'profile',
  status: {
    current: (s) => {
      const st = stateOf(s, 'team_member');
      if (!st) return null;
      return st.liveWork
        ? { label: 'working', tone: 'working', pulse: true }
        : { label: 'idle', tone: 'idle' };
    },
  },
  patchTitle: (facade, d, title) => facade.patchEntity(d.id, { expectedVersion: d.version, title }),
  primaryActions: (d) => [
    { id: 'profile', label: 'Profile', title: 'Open the agent profile', run: ({ nav }) => nav.promote(d.id) },
  ],
  creation: teamMemberCreation,
  capabilities: { workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: 'agent' },
  createVia: createViaEntity('team_member'),
  // No quick-create: a title-only agent is hollow (identity/model matter) —
  // creation goes through the full form on the team screen.
  paletteCreate: null,
  collectionEmptyHint: 'no agents yet — spawn one from a member profile, or press',
};

const doc: KindEntry = {
  kind: 'doc',
  label: 'Doc',
  labelPlural: 'Docs',
  glyph: '📄',
  tint: () => INK,
  chipLabel: (s) => s.title,
  chipMeta: (s) => `v${s.version}`,
  chipPulse: () => false,
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'doc');
    if (!st) return null;
    return (
      <>
        {entity.excerpt && <div className="cv2-field cv2-field--wide">{truncate(entity.excerpt, 110)}</div>}
        <div className="cv2-field">
          <span className="cv2-field__value t-mono">{st.format}</span>
          <span className="cv2-field__value t-mono">{st.childCount} chapters</span>
          <span className="cv2-field__value t-mono">v{entity.version}</span>
        </div>
      </>
    );
  },
  Content: ({ detail }) => {
    const content = contentOf(detail, 'doc');
    if (!content) return null;
    if (content.format === 'markdown') {
      return (
        <div className="cv2-content cv2-doc-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.body}</ReactMarkdown>
        </div>
      );
    }
    return (
      <div className="cv2-content">
        <span className="cv2-eyebrow">{content.format} source</span>
        <pre className="cv2-codeblock">{content.body}</pre>
      </div>
    );
  },
  fullLayout: 'reader',
  status: {
    current: (s) => ({ label: `v${s.version}`, tone: 'neutral' }),
  },
  patchTitle: (facade, d, title) => facade.patchEntity(d.id, { expectedVersion: d.version, title }),
  primaryActions: (d) => [
    { id: 'open-full', label: 'Open full', title: 'Open the reader (Z4)', run: ({ nav }) => nav.promote(d.id) },
  ],
  creation: docCreation,
  capabilities: { workStatusBearing: false, treeReparentable: true, markReadAnchor: true, actor: null },
  createVia: createViaEntity('doc'),
  paletteCreate: { keywords: 'new doc add write' },
  collectionEmptyHint: 'no docs here yet — drag one in, or press',
};

const file: KindEntry = {
  kind: 'file',
  label: 'File',
  labelPlural: 'Files',
  glyph: '📎',
  tint: () => INK,
  chipLabel: (s) => stateOf(s, 'file')?.name ?? s.title,
  chipMeta: (s) => {
    const st = stateOf(s, 'file');
    return st ? formatBytes(st.sizeBytes) : null;
  },
  chipPulse: () => false,
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'file');
    if (!st) return null;
    return (
      <div className="cv2-field">
        <span className="cv2-field__value t-mono">{st.mimeType}</span>
        <span className="cv2-field__value t-mono">{formatBytes(st.sizeBytes)}</span>
      </div>
    );
  },
  Content: ({ detail }) => {
    const st = stateOf(detail, 'file');
    return (
      <div className="cv2-content">
        {st && (
          <div className="cv2-kv">
            <Field label="name"><span className="t-mono">{st.name}</span></Field>
            <Field label="type"><span className="t-mono">{st.mimeType}</span></Field>
            <Field label="size"><span className="t-mono">{formatBytes(st.sizeBytes)}</span></Field>
          </div>
        )}
        <ContentRecord detail={detail} omit={['name', 'mimeType', 'sizeBytes']} />
      </div>
    );
  },
  fullLayout: 'generic',
  status: { current: () => null },
  patchTitle: (facade, d, title) => facade.patchEntity(d.id, { expectedVersion: d.version, title }),
  primaryActions: () => [],
  creation: fileCreation,
  capabilities: { workStatusBearing: false, treeReparentable: true, markReadAnchor: false, actor: null },
  createVia: createViaEntity('file'),
  paletteCreate: { keywords: 'new file upload add' },
  collectionEmptyHint: null,
};

const spell: KindEntry = {
  kind: 'spell',
  label: 'Spell',
  labelPlural: 'Spells',
  glyph: '✨',
  tint: () => BRAND,
  chipLabel: (s) => s.title,
  chipMeta: () => null,
  chipPulse: () => false,
  SummaryFields: ({ entity }) => {
    const st = kitStateOf(entity);
    if (!st) return null;
    return (
      <>
        {st.description && <div className="cv2-field cv2-field--wide">{truncate(st.description, 90)}</div>}
        <div className="cv2-field">
          <Pill tone={st.equipped ? 'brand' : 'idle'} dot={false}>{st.equipped ? 'equipped' : 'library'}</Pill>
        </div>
      </>
    );
  },
  Content: ({ detail }) => {
    const st = kitStateOf(detail);
    return (
      <div className="cv2-content">
        {st?.description
          ? <p className="t-body cv2-prewrap">{st.description}</p>
          : <p className="cv2-empty-line">No description.</p>}
        <ContentRecord detail={detail} omit={['description']} />
      </div>
    );
  },
  fullLayout: 'generic',
  status: {
    current: (s) => {
      const st = kitStateOf(s);
      return st ? { label: st.equipped ? 'equipped' : 'library', tone: st.equipped ? 'brand' : 'idle' } : null;
    },
  },
  patchTitle: (facade, d, title) => facade.patchEntity(d.id, { expectedVersion: d.version, title }),
  primaryActions: () => [],
  creation: spellCreation,
  capabilities: { workStatusBearing: false, treeReparentable: true, markReadAnchor: false, actor: null },
  createVia: createViaEntity('spell'),
  paletteCreate: { keywords: 'new spell add' },
  collectionEmptyHint: null,
};

const skill: KindEntry = {
  kind: 'skill',
  label: 'Skill',
  labelPlural: 'Skills',
  glyph: '📚',
  tint: () => BRAND,
  chipLabel: (s) => s.title,
  chipMeta: () => null,
  chipPulse: () => false,
  SummaryFields: spell.SummaryFields, // same discriminated arm: {kind:'spell'|'skill'}
  Content: spell.Content,
  fullLayout: 'generic',
  status: spell.status,
  patchTitle: (facade, d, title) => facade.patchEntity(d.id, { expectedVersion: d.version, title }),
  primaryActions: () => [],
  creation: skillCreation,
  capabilities: { workStatusBearing: false, treeReparentable: true, markReadAnchor: false, actor: null },
  createVia: createViaEntity('skill'),
  paletteCreate: { keywords: 'new skill add' },
  collectionEmptyHint: null,
};

const pullRequest: KindEntry = {
  kind: 'pull_request',
  label: 'PR',
  labelPlural: 'Pull requests',
  glyph: '🔀',
  tint: (s) => {
    const st = stateOf(s, 'pull_request');
    if (!st) return INK;
    if (st.state === 'merged') return tintForTone('done');
    if (st.state === 'closed') return tintForTone('blocked');
    return 'var(--pn-info)';
  },
  chipLabel: (s) => {
    const st = stateOf(s, 'pull_request');
    return st ? `PR #${st.number}` : s.title;
  },
  chipMeta: (s) => stateOf(s, 'pull_request')?.state ?? null,
  chipPulse: () => false,
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'pull_request');
    if (!st) return null;
    const tone: PillTone = st.state === 'merged' ? 'done' : st.state === 'closed' ? 'blocked' : 'review';
    return (
      <>
        <div className="cv2-field">
          <span className="cv2-field__value t-mono">{st.repository}#{st.number}</span>
          <Pill tone={tone} dot={false}>{st.state}</Pill>
          {st.stale && <Pill tone="stale" dot={false}>stale</Pill>}
        </div>
        {st.fetchedAt && (
          <div className="cv2-field">
            <span className="cv2-field__value t-mono">fetched {relTime(st.fetchedAt)}</span>
          </div>
        )}
      </>
    );
  },
  Content: ({ detail }) => {
    const st = stateOf(detail, 'pull_request');
    return (
      <div className="cv2-content">
        {st && (
          <div className="cv2-kv">
            <Field label="repo"><span className="t-mono">{st.repository}</span></Field>
            <Field label="number"><span className="t-mono">#{st.number}</span></Field>
            <Field label="state"><span className="t-mono">{st.state}</span></Field>
            {st.url && (
              <Field label="url">
                <a className="t-code" href={st.url} target="_blank" rel="noreferrer">{st.url}</a>
              </Field>
            )}
            {st.fetchedAt && <Field label="fetched"><span className="t-mono">{relTime(st.fetchedAt)}</span></Field>}
          </div>
        )}
        <ContentRecord detail={detail} omit={['repository', 'number', 'state', 'url', 'fetchedAt']} />
      </div>
    );
  },
  fullLayout: 'generic',
  status: {
    current: (s) => {
      const st = stateOf(s, 'pull_request');
      if (!st) return null;
      if (st.stale) return { label: `${st.state} · stale`, tone: 'stale' };
      const tone: PillTone = st.state === 'merged' ? 'done' : st.state === 'closed' ? 'blocked' : 'review';
      return { label: st.state, tone };
    },
  },
  patchTitle: null, // tracked from GitHub — title follows the source
  primaryActions: (d) => [
    {
      id: 'refresh',
      label: 'Refresh',
      title: 'Refresh tracking from GitHub',
      run: ({ facade }) => facade.trackingRefresh({ entityIds: [d.id] }),
    },
  ],
  creation: prCreation,
  capabilities: { workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: null },
  createVia: createViaEntity('pull_request'),
  // No quick-create: repository + number are required fields — PRs enter via
  // the creation form or Link PR, not a title-only palette row.
  paletteCreate: null,
  collectionEmptyHint: 'nothing tracked yet — link a PR from a task, or press',
};

const commit: KindEntry = {
  kind: 'commit',
  label: 'Commit',
  labelPlural: 'Commits',
  glyph: '◉',
  tint: () => INK,
  chipLabel: (s) => {
    const st = stateOf(s, 'commit');
    return st ? shortSha(st.sha) : s.title;
  },
  chipMeta: (s) => {
    const st = stateOf(s, 'commit');
    return st ? truncate(st.message, 32) : null;
  },
  chipPulse: () => false,
  SummaryFields: ({ entity }) => {
    const st = stateOf(entity, 'commit');
    if (!st) return null;
    return (
      <>
        <div className="cv2-field cv2-field--wide">{truncate(st.message, 90)}</div>
        <div className="cv2-field">
          <span className="cv2-field__value t-mono">{st.repository}</span>
          <span className="cv2-field__value t-mono">{shortSha(st.sha)}</span>
          {st.committedAt && <span className="cv2-field__value t-mono">{relTime(st.committedAt)}</span>}
        </div>
      </>
    );
  },
  Content: ({ detail }) => {
    const st = stateOf(detail, 'commit');
    return (
      <div className="cv2-content">
        {st && (
          <div className="cv2-kv">
            <Field label="repo"><span className="t-mono">{st.repository}</span></Field>
            <Field label="sha"><span className="t-mono">{st.sha}</span></Field>
            <Field label="message"><span className="cv2-prewrap">{st.message}</span></Field>
            {st.committedAt && <Field label="committed"><span className="t-mono">{relTime(st.committedAt)}</span></Field>}
          </div>
        )}
        <ContentRecord detail={detail} omit={['repository', 'sha', 'message', 'committedAt']} />
      </div>
    );
  },
  fullLayout: 'generic',
  status: { current: () => null },
  patchTitle: null, // tracked from GitHub
  primaryActions: (d) => [
    {
      id: 'refresh',
      label: 'Refresh',
      title: 'Refresh tracking from GitHub',
      run: ({ facade }) => facade.trackingRefresh({ entityIds: [d.id] }),
    },
  ],
  creation: null,
  creationDisabledReason: 'Commits are tracked from GitHub.',
  capabilities: { workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: null },
  createVia: null,
  paletteCreate: null,
  collectionEmptyHint: null,
};

// ---------------------------------------------------------------------------
// registry surface
// ---------------------------------------------------------------------------

export const KIND_REGISTRY: Record<EntityKind, KindEntry> = {
  channel,
  task,
  message,
  member,
  team_member: teamMember,
  doc,
  file,
  spell,
  skill,
  pull_request: pullRequest,
  commit,
};

/** Stable display order for galleries, palettes, and creation menus. */
export const KIND_ORDER: EntityKind[] = [
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
];

export function registryFor(kind: EntityKind): KindEntry {
  return KIND_REGISTRY[kind];
}

/** `registryFor(kind).capabilities[flag]`, as a one-call lookup. */
export function kindCan(kind: EntityKind, flag: BooleanCapability): boolean {
  return KIND_REGISTRY[kind].capabilities[flag];
}

/** All kinds carrying a capability flag, in `KIND_ORDER` (stable for UIs). */
export function kindsWhere(flag: BooleanCapability): EntityKind[] {
  return KIND_ORDER.filter((k) => KIND_REGISTRY[k].capabilities[flag]);
}

/** Entries a user can create at all (creation form + createVia), in order. */
export function creatableKinds(): KindEntry[] {
  return KIND_ORDER.map((k) => KIND_REGISTRY[k]).filter((e) => e.createVia != null);
}

/** Entries offered as palette quick-create rows, in order (DEF-10). */
export function paletteCreatableKinds(): KindEntry[] {
  return KIND_ORDER.map((k) => KIND_REGISTRY[k]).filter((e) => e.paletteCreate != null);
}

/** Tombstone handling: deleted entities keep history shape (soft delete). */
export const TOMBSTONE: TombstoneSpec = {
  glyph: '✕',
  label: (kind) => `deleted ${KIND_REGISTRY[kind].label.toLowerCase()}`,
};

export function isTombstoned(s: EntitySummary): boolean {
  return s.deletedAt != null;
}
