/**
 * What each core entity kind IS, for a reader who has never seen tm8.
 *
 * The kind registry (`entityKinds.list`) returns names, icons and field
 * schemas — enough for a machine, not for an agent deciding where a thing
 * lives. The bootstrap prompt no longer inlines a kind inventory; it points at
 * `tm8 kind list`, and this table is what makes that list worth reading: a
 * group, one line of purpose, and the command that brings one into being.
 *
 * `Record<CoreEntityKind, …>` is the guard: a new core kind does not compile
 * until it is described here.
 */
import type { CoreEntityKind } from './contract.js';

export type KindGroup = 'work' | 'talk' | 'knowledge' | 'code' | 'runtime' | 'people';

export interface KindInfo {
  group: KindGroup;
  /** One line: what the kind is for. */
  summary: string;
  /** The command(s) that create one, without the leading `tm8`. */
  createWith: readonly string[];
}

/** Display order and headings for the groups. */
export const KIND_GROUPS: ReadonlyArray<{ group: KindGroup; title: string }> = [
  { group: 'work', title: 'Work' },
  { group: 'talk', title: 'Talk' },
  { group: 'knowledge', title: 'Knowledge' },
  { group: 'code', title: 'Code' },
  { group: 'runtime', title: 'Runtime' },
  { group: 'people', title: 'People' },
];

export const CORE_KIND_INFO: Readonly<Record<CoreEntityKind, KindInfo>> = {
  task: {
    group: 'work',
    summary: 'work with a status, assignees, acceptance criteria and an optional gate',
    createWith: ['entity create task'],
  },
  loop: { group: 'work', summary: 'a recurring task', createWith: ['entity create loop'] },
  project: { group: 'work', summary: 'a codebase that sessions launch in', createWith: ['project create'] },
  collection: {
    group: 'work',
    summary: 'a curated set of entities',
    createWith: ['entity create collection', 'collection add'],
  },

  message: {
    group: 'talk',
    summary: 'a post on an anchor entity: a task, doc, session or chat',
    createWith: ['message send', 'message reply'],
  },
  channel: { group: 'talk', summary: 'a named stream of messages', createWith: ['entity create channel'] },
  voice_channel: { group: 'talk', summary: 'a live voice room', createWith: ['entity create voice_channel'] },
  chat: {
    group: 'talk',
    summary: 'a conversation with a teammate, bound to a model and a working directory',
    createWith: ['chat start'],
  },
  form: {
    group: 'talk',
    summary: 'questions for a human; the answers come back to the session that asked',
    createWith: ['form create'],
  },

  doc: { group: 'knowledge', summary: 'a markdown document', createWith: ['entity create doc'] },
  file: { group: 'knowledge', summary: 'an uploaded file', createWith: ['file upload'] },
  drawing: { group: 'knowledge', summary: 'a hand-drawn canvas', createWith: ['entity create drawing'] },
  graph: { group: 'knowledge', summary: 'a diagram or flow of entities', createWith: ['entity create graph'] },
  memory: {
    group: 'knowledge',
    summary: 'a note a teammate carries into its sessions',
    createWith: ['entity create memory'],
  },
  skill: { group: 'knowledge', summary: 'reusable instructions a teammate can be equipped with', createWith: ['skill create'] },
  spell: { group: 'knowledge', summary: 'a saved, reusable prompt', createWith: ['entity create spell'] },

  pull_request: {
    group: 'code',
    summary: "a GitHub PR linked to a task; its CI and merge state are tracked",
    createWith: ['task link-pr'],
  },
  commit: { group: 'code', summary: 'a commit linked to a task', createWith: ['task link-commit'] },
  worktree: {
    group: 'code',
    summary: "an isolated git checkout for one session",
    createWith: ['session spawn --workdir worktree'],
  },

  work_session: {
    group: 'runtime',
    summary: 'a running agent session; it can be messaged like any anchor',
    createWith: ['session spawn'],
  },
  container: { group: 'runtime', summary: 'a machine an agent runs in or drives', createWith: ['container create'] },
  artifact: { group: 'runtime', summary: 'a published, versioned web page', createWith: ['artifact publish'] },

  member: { group: 'people', summary: 'a human in the space', createWith: ['auth signup', 'space invite create'] },
  team_member: {
    group: 'people',
    summary: 'an agent teammate with a persona, model and skills',
    createWith: ['entity create team_member'],
  },
  interaction_profile: {
    group: 'people',
    summary: "a session's chat and prompt policy",
    createWith: ['interaction-profile propose'],
  },
};

/** The info for a kind name as the registry returns it; `undefined` for custom or unknown kinds. */
export function coreKindInfo(kind: string): KindInfo | undefined {
  return Object.prototype.hasOwnProperty.call(CORE_KIND_INFO, kind)
    ? CORE_KIND_INFO[kind as CoreEntityKind]
    : undefined;
}
