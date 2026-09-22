// @tm8/jev — the routing question set.
//
// Eight questions, one call, evaluated in parallel against one state. This
// exact set was run against 60 real tm8 tasks twice: 60/60 answered both times,
// ~840ms median, 97,852 input tokens per run, 98% run-to-run agreement on the
// final model.
//
// WHY EIGHT AND NOT THREE. State is ingested once and questions are answered in
// parallel, so the marginal cost of a question is its own tokens and no extra
// latency. The three Scores decide the tier; the Nouls are independent gates
// that must not be folded into a score (a Noul at 0.5 means "as likely as not",
// which is not a middling amount of anything); the two Choices carry the
// harness decision and the work-kind label the rest of tm8 can reuse.
//
// Question IDs are never sent to the model, so every question states its own
// full meaning rather than leaning on its key.

import type { JevQuestionSet } from './primitives.js';

export const ROUTING_QUESTIONS: JevQuestionSet = {
  work_kind: {
    type: 'choice',
    instructions:
      'What kind of work does this tm8 task ask an autonomous coding agent to perform?',
    criteria: {
      implement: 'Write or change source code to add or fix behaviour.',
      review:
        "Read someone else's diff or code and report findings; produces judgement, not code.",
      investigate: 'Diagnose a defect or unknown behaviour whose cause is not yet known.',
      coordinate:
        'Orchestrate other agents or sequence other tasks; the work itself is delegation and tracking.',
      operate:
        'Run a deployment, migration, release or other production operation against live infrastructure.',
      design:
        'Produce analysis, a design document, a specification or an artifact; little or no shipped code.',
      unclear: 'The task does not say enough to tell what it is asking for.',
    },
  },

  // --- the three axes that decide the tier ---------------------------------
  reasoning_depth: {
    type: 'score',
    instructions:
      'How much original reasoning must the agent do to finish this task correctly?',
    criteria: [
      'Mechanical: the steps are fully written out; following them is the whole job.',
      'Routine: a known pattern applied to a named place; the agent decides details, not approach.',
      'Analytical: the agent must work out the cause or the approach itself from evidence it gathers.',
      'Novel design: the agent must invent an approach and defend trade-offs nobody has settled yet.',
    ],
  },
  context_breadth: {
    type: 'score',
    instructions:
      'How much of the codebase must the agent read and hold at once to do this task?',
    criteria: [
      'One file or one named diff.',
      'A handful of files inside one package.',
      'Several packages, or a whole subsystem and its tests.',
      'The whole repository, or a long transcript history, held at once.',
    ],
  },
  blast_radius: {
    type: 'score',
    instructions:
      'If the agent gets this task wrong, how bad and how reversible is the consequence?',
    criteria: [
      'Local and reversible: a bad edit in a branch nobody has merged.',
      'Visible but recoverable: a wrong review, a failing CI run, a reverted commit.',
      'Production-affecting: a live deploy, a migration, a credential or auth change.',
      'Irreversible: data loss, a leaked secret, or a published artifact that cannot be withdrawn.',
    ],
  },

  // --- independent gates ----------------------------------------------------
  needs_long_context: {
    type: 'noul',
    instructions:
      'Does this task require holding more than roughly 200,000 tokens of material at once — a very large diff, many packages, or a long prior transcript?',
    criteria: {
      true: 'Explicitly large scope, many files, or a long history to re-read.',
      false: 'The material named fits comfortably in a normal context window.',
    },
  },
  spec_complete: {
    type: 'noul',
    instructions:
      'Is this task specified well enough that an agent could start work without asking a human a clarifying question first?',
    criteria: {
      true: 'Goal, scope and done-condition are all stated or plainly inferable.',
      false: 'Something essential is missing, empty or contradictory.',
    },
  },
  human_named_model: {
    type: 'noul',
    instructions:
      "Does the task text itself name a specific model, tier or agent tool that the requester wants used (for example 'opus', 'sonnet', 'gpt-5', 'codex', '1M')?",
    criteria: {
      true: 'A model, tier or tool is named in the request.',
      false: 'No model or tool is named anywhere in the request.',
    },
  },

  // --- harness fit ----------------------------------------------------------
  // tm8 is harness-plural. This question is what keeps routing from being a
  // Claude-only decision with an OpenAI afterthought.
  harness_fit: {
    type: 'choice',
    instructions:
      'tm8 can launch this work on Claude Code (Anthropic models) or Codex (OpenAI models). Which harness suits this task better, judged only on the nature of the work?',
    criteria: {
      claude_code:
        'Long prose judgement, design writing, review narrative, or work that leans on a large context window.',
      codex:
        'Tightly-scoped mechanical code edits, test-loop iteration, or work where a cheap high-effort reasoning dial is the main need.',
      either: 'Nothing about the work prefers one over the other.',
    },
  },
};

/** The task facts Jev routes on. Every field is already in `SpawnContext.tasks`. */
export interface TaskFacts {
  id?: string;
  title: string;
  description: string;
  priority?: string;
  status?: string;
  acceptanceCriteriaCount?: number;
  parentTitle?: string | null;
}

/**
 * Shape the state Jev sees.
 *
 * Named JSON fields, not a concatenated blob: the docs are explicit that named
 * fields let a question reference `task.description` and mean it. Nothing here
 * is a credential, and nothing is the agent's own prompt — only the task record
 * a human wrote.
 */
export function routingState(task: TaskFacts): Record<string, unknown> {
  return {
    title: task.title,
    description: task.description,
    ...(task.priority ? { priority: task.priority } : {}),
    ...(task.status ? { status: task.status } : {}),
    ...(task.acceptanceCriteriaCount !== undefined
      ? { acceptance_criteria_count: task.acceptanceCriteriaCount }
      : {}),
    ...(task.parentTitle ? { parent_task: task.parentTitle } : {}),
  };
}
