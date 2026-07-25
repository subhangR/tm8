/**
 * `@tm8/prompt` — the ONE agent-prompt composer, shared by the spawn path and
 * the CLI.
 *
 * WHY ITS OWN PACKAGE. The prompt must be composed in TWO places that must not
 * depend on each other:
 *   - `@tm8/execution` composes it at SPAWN time and embeds it in the agent's
 *     command line, so the prompt exists at the agent's first token — before it
 *     could possibly run a CLI;
 *   - `@tm8/cli` composes it for `tm8 worker init`, so an agent can re-read its
 *     own briefing.
 * `@tm8/cli` cannot import `@tm8/execution` (that would drag `node-pty` and
 * `@xterm/headless` into the agent's own CLI — native deps that break under bun
 * and need a spawn-helper chmod), and execution importing the CLI would invert
 * the layering. So the composer lives here, with ZERO dependencies, and both
 * import it. One composer, no duplication.
 *
 * SCOPE. Old maestro's composer is ~2.4k LOC across a normalizer, a capability
 * policy, a command-surface renderer and a 1000-line builder, because it renders
 * teams, sub-teams, spells, skill scopes and a five-level launch-config
 * precedence chain. What an agent actually needs to start is three things:
 *
 *    who it is  ·  what its task is  ·  how to report back
 *
 * That is what this renders. Every command it advertises is a command the CLI
 * actually implements — advertising a verb the binary does not have is the one
 * failure mode that makes an agent look broken to the user.
 */

export type AgentMode =
  | 'worker'
  | 'coordinator'
  | 'coordinated-worker'
  | 'coordinated-coordinator';

export const AGENT_MODES: readonly AgentMode[] = [
  'worker',
  'coordinator',
  'coordinated-worker',
  'coordinated-coordinator',
];

/**
 * The manifest fields the composer reads.
 *
 * Deliberately TOLERANT (everything optional, `unknown[]` where the two callers
 * disagree) so that BOTH the CLI's parsed-from-JSON manifest and execution's
 * strict in-memory `Tm8Manifest` satisfy it without either side casting. This is
 * a read-only view, not a redefinition of the manifest: the canonical shape
 * stays in `@tm8/execution`.
 */
export interface PromptManifest {
  sessionId?: string | undefined;
  spaceId?: string | undefined;
  mode?: AgentMode | undefined;
  agent?:
    | {
        teamMemberId?: string | undefined;
        name?: string | undefined;
        avatar?: string | null | undefined;
        role?: string | undefined;
        identity?: string | undefined;
        memory?: readonly unknown[] | undefined;
      }
    | undefined;
  project?: { id?: string; name?: string; workingDir?: string } | null | undefined;
  tasks?:
    | ReadonlyArray<{
        id: string;
        title?: string | undefined;
        description?: string | undefined;
        priority?: string | undefined;
        workStatus?: string | undefined;
        acceptanceCriteria?: readonly unknown[] | undefined;
      }>
    | undefined;
  coordinator?: { sessionId?: string; displayName?: string } | null | undefined;
  directive?:
    | { subject?: string; message?: string; fromSessionId?: string }
    | null
    | undefined;
  skills?: ReadonlyArray<{ name?: string | undefined; body?: string | undefined }> | undefined;
  promptExtra?: string | null | undefined;
}

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
 * Indent a free-text block so it reads as a child of its XML tag — escaping it
 * on the way in.
 *
 * The escape is not cosmetic, and it is a DELIBERATE DIVERGENCE from old
 * maestro, which passes prose through a `raw()` identity function on the
 * argument that unescaped text is easier for a model to read. tm8 escapes it.
 * Persona text, skill bodies, task descriptions and coordinator directives are
 * all AUTHORED content in a multi-actor graph — agents author task content
 * today and remote members will via the bridge — so a persona containing
 * `</tm8_system_prompt>` would otherwise close the frame early and everything
 * after it, including the reporting instructions, would read as loose text
 * outside the agent's identity block. Prompt-injection containment
 * (10-SECURITY-MODEL S13) outranks the minor comprehension cost of entity
 * -encoded angle brackets. Revisit only on a MEASURED comprehension problem.
 */
function block(text: string, pad: string): string {
  return esc(text)
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : pad + l))
    .join('\n');
}

// -- Mode identity instructions ----------------------------------------------
//
// Ported from old maestro's `prompts/identity.ts` four-mode model, but REWRITTEN
// against tm8's actual verb surface rather than copied. maestro's instructions
// tell an agent to run `session spawn`, `session siblings`, `session logs
// --my-workers` and `task create` — none of which this CLI implements. Shipping
// them verbatim would advertise verbs the binary does not have, which is exactly
// the failure mode that makes an agent look broken. Where a capability does not
// exist yet the instruction says so plainly instead of pretending.

const WORKER_IDENTITY_INSTRUCTION =
  'You are an autonomous agent working inside a tm8 workspace. Understand your ' +
  'assigned tasks, plan them, and work them to completion. Report each meaningful ' +
  'milestone with `tm8 task report progress` so your progress lands in the task ' +
  "thread where humans and other agents can see it — work nobody can see hasn't " +
  'happened. When a task is genuinely done, run `tm8 task report complete`. If you ' +
  'are stuck on something you cannot resolve yourself, run `tm8 task report blocked` ' +
  'with the specific reason rather than going quiet. When all assigned work is ' +
  'finished, finalize with `tm8 session report complete "<summary>"`.';

const COORDINATOR_IDENTITY_INSTRUCTION =
  'You are a coordinating agent inside a tm8 workspace. Decompose your assigned ' +
  'work into scoped units with explicit inputs, outputs and deliverables, and plan ' +
  'the order before you start. Keep the task thread current with ' +
  '`tm8 task report progress` as each unit lands, and verify each unit against its ' +
  'success criteria before you consider it done. NOTE: during this phase the tm8 ' +
  'CLI does not yet carry spawn or session-prompt verbs, so you cannot delegate to ' +
  'other sessions — do the work yourself and report it. Finalize with ' +
  '`tm8 session report complete "<summary>"`.';

const COORDINATED_WORKER_IDENTITY_INSTRUCTION =
  'You are a worker agent in a coordinated multi-agent team. A coordinator spawned ' +
  'you and assigned you the tasks below; execute them directly and autonomously. ' +
  'Report progress at each meaningful milestone with `tm8 task report progress`, and ' +
  'escalate blockers promptly with `tm8 task report blocked` giving the specific ' +
  'reason. IMPORTANT — the coordinator is waiting on your report and reads the task ' +
  'thread: when you complete or block, say so there with your status, results and ' +
  'deliverables. Do NOT simply go idle after finishing. When all assigned work is ' +
  'done, finalize with `tm8 session report complete "<summary>"`. (This CLI has no ' +
  'session-to-session prompt verb yet, so the task thread IS your report channel.)';

const COORDINATED_COORDINATOR_IDENTITY_INSTRUCTION =
  'You are a sub-coordinator in a hierarchical multi-agent team. A parent ' +
  'coordinator spawned you to own a slice of the work. Decompose that slice into ' +
  'scoped units with explicit deliverables, work them in a deliberate order, and ' +
  'verify each against its success criteria. Keep the task thread current with ' +
  '`tm8 task report progress` — your parent reads it. IMPORTANT — when your slice ' +
  'is complete or blocked you MUST report it on the task thread with status, results ' +
  'and deliverables; do not go idle and leave the parent waiting. NOTE: during this ' +
  'phase the tm8 CLI carries no spawn or session-prompt verbs, so you cannot ' +
  'delegate or message siblings — do the work yourself and report it. Finalize with ' +
  '`tm8 session report complete "<summary>"`.';

/** The four-mode model, as a lookup rather than a chain of conditionals. */
const MODE_INSTRUCTIONS: Record<AgentMode, string> = {
  worker: WORKER_IDENTITY_INSTRUCTION,
  coordinator: COORDINATOR_IDENTITY_INSTRUCTION,
  'coordinated-worker': COORDINATED_WORKER_IDENTITY_INSTRUCTION,
  'coordinated-coordinator': COORDINATED_COORDINATOR_IDENTITY_INSTRUCTION,
};

/** Stable profile names, mirroring maestro's `maestro-<mode>` convention. */
const MODE_PROFILES: Record<AgentMode, string> = {
  worker: 'tm8-worker',
  coordinator: 'tm8-coordinator',
  'coordinated-worker': 'tm8-coordinated-worker',
  'coordinated-coordinator': 'tm8-coordinated-coordinator',
};

export function instructionFor(mode: AgentMode): string {
  return MODE_INSTRUCTIONS[mode] ?? WORKER_IDENTITY_INSTRUCTION;
}

export function profileFor(mode: AgentMode): string {
  return MODE_PROFILES[mode] ?? MODE_PROFILES.worker;
}

/**
 * The verb surface. Kept as data so `worker init --json` can report a count that
 * is provably the same list the prompt shows.
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

/** Non-empty strings only — memory/criteria arrive as `unknown[]` from the graph. */
function strings(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];
  return values.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

export function composePrompt(
  manifest: PromptManifest,
  runtime: PromptRuntime = {},
): PromptEnvelope {
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
  s.push(`    <profile>${esc(profileFor(mode))}</profile>`);
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

  const memory = strings(agent.memory);
  if (memory.length > 0) {
    s.push('  <memory>');
    for (const m of memory) s.push(`    <entry>${esc(m)}</entry>`);
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
    if (coordinator.displayName)
      s.push(`    <coordinator>${esc(coordinator.displayName)}</coordinator>`);
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
    // Acceptance criteria are the agent's definition of done. They are composed
    // into the manifest from the graph and were previously dropped on the floor
    // by the reader, so an agent could not tell when it was finished.
    const criteria = strings(task.acceptanceCriteria);
    if (criteria.length > 0) {
      t.push('    <acceptance_criteria>');
      for (const c of criteria) t.push(`      <criterion>${esc(c)}</criterion>`);
      t.push('    </acceptance_criteria>');
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
    if (directive.fromSessionId)
      t.push(`    <from_session_id>${esc(directive.fromSessionId)}</from_session_id>`);
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
