/**
 * Prompt composition — the minimal tm8 version.
 *
 * Shape borrowed from old maestro's `PromptComposer` (identity kernel →
 * capability/command surface → task block); scope deliberately NOT borrowed.
 * The old composer is ~2.4k LOC across a normalizer, a capability policy, a
 * command-surface renderer and a 1000-line PromptBuilder because it renders
 * four agent modes, teams, sub-teams, spells, skills scopes and a five-level
 * launch-config precedence chain. G1A needs an agent that knows three things:
 *
 *    who it is  ·  what its task is  ·  how to report back
 *
 * So that is what this renders. Every command it advertises is a command this
 * CLI actually implements — advertising a verb the binary does not have is the
 * one failure mode that makes an agent look broken to the user.
 */
import type { Tm8Manifest, AgentMode } from './manifest.js';

export interface PromptRuntime {
  /** Wins over the manifest — it is what the PTY actually set. */
  sessionId?: string | undefined;
  baseUrl?: string | undefined;
}

export interface PromptEnvelope {
  system: string;
  task: string;
  metadata: {
    mode: AgentMode;
    sessionId: string | null;
    spaceId: string | null;
    taskCount: number;
    commandCount: number;
  };
}

const PROMPT_VERSION = '1.0';

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Indent a free-text block so it reads as a child of its XML tag — escaping
 * it on the way in.
 *
 * The escape is not cosmetic. Persona text, skill bodies, task descriptions
 * and coordinator directives are all AUTHORED content: a persona containing
 * `</tm8_system_prompt>` would otherwise close the frame early and everything
 * after it — including the reporting instructions — would read as loose text
 * outside the agent's identity block.
 */
function block(text: string, pad: string): string {
  return esc(text)
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : pad + l))
    .join('\n');
}

const WORKER_INSTRUCTION =
  'You are an autonomous agent working inside a tm8 workspace. Understand your ' +
  'assigned tasks, plan them, and work them to completion. Report each meaningful ' +
  'milestone with `tm8 task report progress` so your progress lands in the task ' +
  "thread where humans and other agents can see it — work nobody can see hasn't " +
  'happened. When a task is genuinely done, run `tm8 task report complete`. If you ' +
  'are stuck on something you cannot resolve yourself, run `tm8 task report blocked` ' +
  'with the specific reason rather than going quiet.';

const COORDINATOR_INSTRUCTION =
  'You are a coordinating agent inside a tm8 workspace. Decompose your assigned ' +
  'work into scoped units with explicit deliverables, and keep the task thread ' +
  'current with `tm8 task report progress` as each unit lands. NOTE: during this ' +
  'phase the tm8 CLI does not yet carry spawn or session-prompt verbs, so you ' +
  'cannot delegate to other sessions — do the work yourself and report it.';

function instructionFor(mode: AgentMode): string {
  return mode === 'coordinator' || mode === 'coordinated-coordinator'
    ? COORDINATOR_INSTRUCTION
    : WORKER_INSTRUCTION;
}

/**
 * The verb surface. Kept as data so `worker init --json` can report a count
 * that is provably the same list the prompt shows.
 */
export interface CommandDoc {
  usage: string;
  what: string;
}

export function commandSurface(hasSession: boolean): CommandDoc[] {
  const cmds: CommandDoc[] = [
    { usage: 'tm8 whoami', what: 'who the server thinks you are (and whether it is reachable)' },
    {
      usage: 'tm8 task report progress <taskId> "<message>"',
      what: 'append a progress note to the task thread',
    },
    {
      usage: 'tm8 task report complete <taskId> "<summary>"',
      what: 'post the summary, then mark the task complete',
    },
    {
      usage: 'tm8 task report blocked <taskId> "<reason>"',
      what: 'post the reason, then set the task to blocked',
    },
  ];
  if (hasSession) {
    cmds.push(
      { usage: 'tm8 session report progress "<message>"', what: 'note on your own session thread' },
      { usage: 'tm8 session report complete "<summary>"', what: 'declare your session finished' },
      { usage: 'tm8 session report blocked "<reason>"', what: 'declare your session blocked' },
    );
  }
  return cmds;
}

export function composePrompt(manifest: Tm8Manifest, runtime: PromptRuntime = {}): PromptEnvelope {
  const mode: AgentMode = manifest.mode ?? 'worker';
  const sessionId = runtime.sessionId ?? manifest.sessionId ?? null;
  const spaceId = manifest.spaceId ?? null;
  const agent = manifest.agent ?? {};
  const tasks = manifest.tasks ?? [];
  const commands = commandSurface(sessionId !== null);

  // ---- system ------------------------------------------------------------
  const s: string[] = [];
  s.push(`<tm8_system_prompt version="${PROMPT_VERSION}" mode="${esc(mode)}">`);

  s.push('  <identity>');
  if (agent.name) s.push(`    <name>${esc(agent.name)}</name>`);
  if (agent.avatar) s.push(`    <avatar>${esc(agent.avatar)}</avatar>`);
  if (agent.role) s.push(`    <role>${esc(agent.role)}</role>`);
  if (agent.teamMemberId) s.push(`    <team_member_id>${esc(agent.teamMemberId)}</team_member_id>`);
  if (agent.identity) {
    s.push('    <persona>');
    s.push(block(agent.identity, '      '));
    s.push('    </persona>');
  }
  s.push(`    <instruction>${esc(instructionFor(mode))}</instruction>`);
  s.push('  </identity>');

  if (agent.memory && agent.memory.length > 0) {
    s.push('  <memory>');
    for (const m of agent.memory) s.push(`    <entry>${esc(m)}</entry>`);
    s.push('  </memory>');
  }

  s.push('  <session_context>');
  if (sessionId) s.push(`    <session_id>${esc(sessionId)}</session_id>`);
  if (spaceId) s.push(`    <space_id>${esc(spaceId)}</space_id>`);
  if (runtime.baseUrl) s.push(`    <server>${esc(runtime.baseUrl)}</server>`);
  const project = manifest.project;
  if (project) {
    if (project.name) s.push(`    <project>${esc(project.name)}</project>`);
    if (project.workingDir) s.push(`    <working_dir>${esc(project.workingDir)}</working_dir>`);
  }
  s.push('  </session_context>');

  const coordinator = manifest.coordinator;
  if (coordinator?.sessionId) {
    s.push('  <coordination>');
    s.push(`    <coordinator_session_id>${esc(coordinator.sessionId)}</coordinator_session_id>`);
    if (coordinator.displayName) s.push(`    <coordinator>${esc(coordinator.displayName)}</coordinator>`);
    s.push(
      '    <instruction>A coordinator spawned you and is waiting on your report. ' +
        'Report completion or a blocker through the task thread the moment it happens — ' +
        'do not simply go idle.</instruction>',
    );
    s.push('  </coordination>');
  }

  s.push('  <reporting>');
  s.push(
    '    <instruction>These are real HTTP calls against your tm8 server. ' +
      'They are how your work becomes visible; nothing else in this environment ' +
      'writes to the graph on your behalf.</instruction>',
  );
  for (const c of commands) {
    s.push(`    <command usage="${esc(c.usage)}">${esc(c.what)}</command>`);
  }
  s.push('  </reporting>');

  const skills = manifest.skills ?? [];
  if (skills.length > 0) {
    s.push('  <skills>');
    for (const skill of skills) {
      s.push(`    <skill name="${esc(skill.name ?? 'unnamed')}">`);
      if (skill.body) s.push(block(skill.body, '      '));
      s.push('    </skill>');
    }
    s.push('  </skills>');
  }

  if (manifest.promptExtra) {
    s.push('  <additional_context>');
    s.push(block(manifest.promptExtra, '    '));
    s.push('  </additional_context>');
  }

  s.push('</tm8_system_prompt>');

  // ---- task --------------------------------------------------------------
  const t: string[] = [];
  t.push(`<tm8_task_prompt count="${tasks.length}">`);
  for (const task of tasks) {
    t.push(`  <task id="${esc(task.id)}">`);
    if (task.title) t.push(`    <title>${esc(task.title)}</title>`);
    if (task.priority) t.push(`    <priority>${esc(task.priority)}</priority>`);
    if (task.workStatus) t.push(`    <status>${esc(task.workStatus)}</status>`);
    if (task.description) {
      t.push('    <description>');
      t.push(block(task.description, '      '));
      t.push('    </description>');
    }
    t.push('  </task>');
  }
  if (tasks.length === 0) {
    t.push(
      '  <note>No task is attached to this session. Wait for instructions rather ' +
        'than inventing work.</note>',
    );
  }
  const directive = manifest.directive;
  if (directive?.message) {
    t.push('  <directive>');
    if (directive.subject) t.push(`    <subject>${esc(directive.subject)}</subject>`);
    if (directive.fromSessionId) t.push(`    <from_session_id>${esc(directive.fromSessionId)}</from_session_id>`);
    t.push('    <message>');
    t.push(block(directive.message, '      '));
    t.push('    </message>');
    t.push('  </directive>');
  }
  t.push('</tm8_task_prompt>');

  return {
    system: s.join('\n'),
    task: t.join('\n'),
    metadata: {
      mode,
      sessionId,
      spaceId,
      taskCount: tasks.length,
      commandCount: commands.length,
    },
  };
}
