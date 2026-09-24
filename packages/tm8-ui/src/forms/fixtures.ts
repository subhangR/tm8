/**
 * Forms fixtures (W1 frontend, no live ops). Every form here is built
 * THROUGH the contract schemas — settings via `FormSettingsSchema`, questions
 * checked by `FormQuestionSchema` and every submitted answer set by
 * `validateFormAnswers` in `forms-fixtures.test.ts` — so a fixture can never
 * show a shape the server would refuse.
 *
 * Coverage, on purpose:
 *   - release review: open, per_member, three sections, EVERY v1 type (a
 *     dropdown single choice with a write-in, a radio one, multi choice,
 *     short text with a pattern, scale, long markdown text); the viewer's
 *     revision chain 1 → 2 → 3; four other members' current responses, one per
 *     delivery status; frozen (it has submitted responses).
 *   - migration strategy: open, single, closeOnSubmit; the viewer holds an
 *     autosaved draft and nothing is submitted, so it is NOT frozen.
 *   - onboarding survey: a draft form (not answerable yet), unlimited.
 *   - retro: closed, allowAmend off, two submitted responses.
 *   - API naming: cancelled.
 * Drafts reach only their respondent (decision 10): the only draft here is the
 * viewer's own.
 */
import { FormSettingsSchema, type FormQuestionRow, type FormSectionRow, type FormSettingsInput } from '@tm8/contract';
import type { FormContentView, FormResponseView, FormSnapshot, FormState, FormViewer } from './seam';

export const FORM_FIXTURE_VIEWER: FormViewer = { memberId: 'act-ada', displayName: 'Ada' };

const settings = (input: FormSettingsInput = {}) => FormSettingsSchema.parse(input);

const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, day, hour, minute)).toISOString();

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const RELEASE_SECTIONS: FormSectionRow[] = [
  { key: 'scope', title: 'Scope', help: 'What ships in **0.9**.', position: 0 },
  { key: 'quality', title: 'Quality', position: 1 },
  { key: 'notes', title: 'Notes', position: 2 },
];

const RELEASE_QUESTIONS: FormQuestionRow[] = [
  {
    key: 'target', type: 'single_choice', title: 'Which channel does 0.9 go to first?', required: true,
    section: 'scope', position: 0,
    config: {
      display: 'dropdown', allowOther: true,
      options: [
        { value: 'beta', label: 'Beta', recommended: true, help: 'Opt-in users; one-week soak.' },
        { value: 'stable', label: 'Stable' },
        { value: 'internal', label: 'Internal only' },
      ],
    },
  },
  {
    key: 'surfaces', type: 'multi_choice', title: 'Which surfaces need a changelog entry?', required: true,
    help: 'Pick up to three.', section: 'scope', position: 1,
    config: {
      allowOther: true, minSelected: 1, maxSelected: 3,
      options: [
        { value: 'cli', label: 'CLI', recommended: true },
        { value: 'ui', label: 'Web UI', recommended: true },
        { value: 'mcp', label: 'MCP server' },
        { value: 'api', label: 'HTTP API' },
      ],
    },
  },
  {
    key: 'rollback', type: 'single_choice', title: 'Rollback plan', required: true, section: 'scope', position: 2,
    config: {
      options: [
        { value: 'flag', label: 'Feature flag', recommended: true, help: 'Flip off without a deploy.' },
        { value: 'revert', label: 'Revert and redeploy' },
      ],
    },
  },
  {
    key: 'codename', type: 'short_text', title: 'Release codename', required: false, section: 'quality',
    position: 3, help: 'Lowercase words joined by dashes.',
    config: { placeholder: 'e.g. quiet-harbor', maxLength: 40, pattern: '[a-z]+(-[a-z]+)*' },
  },
  {
    key: 'confidence', type: 'scale', title: 'How confident are you in this release?', required: true,
    section: 'quality', position: 4,
    config: { min: 1, max: 5, minLabel: 'Worried', maxLabel: 'Ship it' },
  },
  {
    key: 'risks', type: 'long_text', title: 'Known risks', required: false, section: 'notes', position: 5,
    help: 'Markdown is fine.', config: { placeholder: 'Anything the agent should watch for…', maxLength: 4000 },
  },
];

const MIGRATION_QUESTIONS: FormQuestionRow[] = [
  {
    key: 'strategy', type: 'single_choice', title: 'Which approach?', required: true, position: 0,
    config: {
      options: [
        { value: 'online_backfill', label: 'Online backfill', recommended: true, help: 'Batches of 10k rows, off-peak.' },
        { value: 'dual_write', label: 'Dual write' },
      ],
    },
  },
  {
    key: 'risks', type: 'long_text', title: 'Anything to watch for?', required: false, position: 1, config: {},
  },
];

const ONBOARDING_QUESTIONS: FormQuestionRow[] = [
  { key: 'role', type: 'short_text', title: 'Your role', required: true, position: 0, config: {} },
  {
    key: 'setup', type: 'scale', title: 'How smooth was setup?', required: true, position: 1,
    config: { min: 0, max: 10, minLabel: 'Painful', maxLabel: 'Effortless' },
  },
];

const RETRO_QUESTIONS: FormQuestionRow[] = [
  {
    key: 'went_well', type: 'multi_choice', title: 'What went well?', required: true, position: 0,
    config: {
      options: [
        { value: 'reviews', label: 'Fast reviews' },
        { value: 'ci', label: 'Green CI' },
        { value: 'scope', label: 'Clear scope' },
      ],
    },
  },
  { key: 'change', type: 'long_text', title: 'One thing to change', required: false, position: 1, config: {} },
];

const NAMING_QUESTIONS: FormQuestionRow[] = [
  {
    key: 'noun', type: 'single_choice', title: 'Name the new noun', required: true, position: 0,
    config: { display: 'radio', options: [{ value: 'questionnaire', label: 'questionnaire' }, { value: 'survey', label: 'survey' }] },
  },
];

function form(
  id: string,
  title: string,
  content: Omit<FormContentView, 'openedAt' | 'closedAt'> & Partial<Pick<FormContentView, 'openedAt' | 'closedAt'>>,
  version = 3,
): FormState {
  return { id, title, version, content: { openedAt: null, closedAt: null, ...content } };
}

export const FORM_FIXTURE_IDS = {
  release: 'form-release-review',
  migration: 'form-migration-strategy',
  onboarding: 'form-onboarding-survey',
  retro: 'form-retro',
  naming: 'form-api-naming',
} as const;

export const FORM_FIXTURE_FORMS: FormState[] = [
  form(FORM_FIXTURE_IDS.release, 'Release 0.9 review', {
    status: 'open',
    description: 'Before I cut **0.9**, I need your call on the channel, the changelog and the rollback.',
    settings: settings({ delivery: { onSessionNotLive: 'queue' } }),
    structureVersion: 2,
    sections: RELEASE_SECTIONS,
    questions: RELEASE_QUESTIONS,
    openedAt: at(22, 9),
  }, 9),
  form(FORM_FIXTURE_IDS.migration, 'Pick the migration strategy', {
    status: 'open',
    description: 'The billing table needs a new column before Friday.',
    settings: settings({ responses: 'single', closeOnSubmit: true }),
    structureVersion: 1,
    sections: [],
    questions: MIGRATION_QUESTIONS,
    openedAt: at(24, 8),
  }),
  form(FORM_FIXTURE_IDS.onboarding, 'Onboarding survey', {
    status: 'draft',
    description: null,
    settings: settings({ responses: 'unlimited', respondents: 'anyone' }),
    structureVersion: 1,
    sections: [],
    questions: ONBOARDING_QUESTIONS,
  }, 1),
  form(FORM_FIXTURE_IDS.retro, 'Sprint 41 retro', {
    status: 'closed',
    description: 'Closed Friday.',
    settings: settings({ allowAmend: false }),
    structureVersion: 1,
    sections: [],
    questions: RETRO_QUESTIONS,
    openedAt: at(15, 9),
    closedAt: at(19, 17),
  }, 5),
  form(FORM_FIXTURE_IDS.naming, 'API naming', {
    status: 'cancelled',
    description: 'Superseded by the design review.',
    settings: settings({ responses: 'single' }),
    structureVersion: 1,
    sections: [],
    questions: NAMING_QUESTIONS,
    openedAt: at(10, 9),
    closedAt: at(11, 9),
  }, 4),
];

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function snapshotOf(f: FormState): FormSnapshot {
  return { structureVersion: f.content.structureVersion, sections: f.content.sections, questions: f.content.questions };
}

const byId = (id: string) => FORM_FIXTURE_FORMS.find((f) => f.id === id)!;

function submitted(
  f: FormState,
  over: Pick<FormResponseView, 'id' | 'respondentId' | 'respondentName' | 'answers' | 'submittedAt'>
    & Partial<FormResponseView>,
): FormResponseView {
  return {
    formId: f.id,
    status: 'submitted',
    revision: 1,
    supersedesId: null,
    lineageKey: over.respondentId,
    isCurrent: true,
    structureVersion: f.content.structureVersion,
    questionsSnapshot: snapshotOf(f),
    messageId: `msg-${over.id}`,
    createdAt: over.submittedAt!,
    updatedAt: over.submittedAt!,
    version: 1,
    deliveries: [],
    ...over,
  };
}

const delivery = (
  status: FormResponseView['deliveries'][number]['status'],
  createdAt: string,
  extra: Partial<FormResponseView['deliveries'][number]> = {},
) => ({
  workSessionId: 'ws-release-agent',
  status,
  spawnedSessionId: null,
  lastError: null,
  attempts: status === 'pending' ? 0 : 1,
  createdAt,
  ...extra,
});

const release = byId(FORM_FIXTURE_IDS.release);
const migration = byId(FORM_FIXTURE_IDS.migration);
const retro = byId(FORM_FIXTURE_IDS.retro);

export const FORM_FIXTURE_RESPONSES: FormResponseView[] = [
  // The viewer's chain on the release review: 1 → 2 → 3, 3 current and queued.
  submitted(release, {
    id: 'resp-ada-1', respondentId: 'act-ada', respondentName: 'Ada', isCurrent: false,
    submittedAt: at(22, 10),
    answers: {
      target: { value: 'stable' }, surfaces: { values: ['cli'] }, rollback: { value: 'revert' },
      codename: null, confidence: { number: 2 }, risks: null,
    },
    deliveries: [delivery('delivered', at(22, 10))],
  }),
  submitted(release, {
    id: 'resp-ada-2', respondentId: 'act-ada', respondentName: 'Ada', isCurrent: false,
    revision: 2, supersedesId: 'resp-ada-1', submittedAt: at(23, 11),
    answers: {
      target: { value: 'beta' }, surfaces: { values: ['cli', 'ui'] }, rollback: { value: 'revert' },
      codename: { text: 'quiet-harbor' }, confidence: { number: 3 }, risks: null,
    },
    deliveries: [delivery('delivered', at(23, 11))],
  }),
  submitted(release, {
    id: 'resp-ada-3', respondentId: 'act-ada', respondentName: 'Ada',
    revision: 3, supersedesId: 'resp-ada-2', submittedAt: at(24, 9, 30),
    answers: {
      target: { value: 'beta' }, surfaces: { values: ['cli', 'ui'], other: 'Docs site' }, rollback: { value: 'flag' },
      codename: { text: 'quiet-harbor' }, confidence: { number: 4 },
      risks: { text: 'The **billing** migration must land first.\n\n- run it off-peak\n- watch the queue depth' },
    },
    deliveries: [delivery('pending', at(24, 9, 30))],
  }),
  submitted(release, {
    id: 'resp-noor-1', respondentId: 'act-noor', respondentName: 'Noor', submittedAt: at(23, 15),
    answers: {
      target: { other: 'Canary for a day, then beta' }, surfaces: { values: ['api', 'mcp'] }, rollback: { value: 'flag' },
      codename: null, confidence: { number: 5 }, risks: null,
    },
    deliveries: [delivery('delivered', at(23, 15))],
  }),
  submitted(release, {
    id: 'resp-lin-1', respondentId: 'mbr-lin', respondentName: 'Lin', submittedAt: at(23, 16),
    answers: {
      target: { value: 'internal' }, surfaces: { values: ['ui'] }, rollback: { value: 'revert' },
      codename: { text: 'north-light' }, confidence: { number: 3 }, risks: { text: 'None beyond the usual.' },
    },
    deliveries: [delivery('spawned', at(23, 16), { spawnedSessionId: 'ws-release-followup' })],
  }),
  submitted(release, {
    id: 'resp-omar-1', respondentId: 'mbr-omar', respondentName: 'Omar', submittedAt: at(23, 18),
    answers: {
      target: { value: 'beta' }, surfaces: { values: ['cli'] }, rollback: { value: 'flag' },
      codename: null, confidence: { number: 4 }, risks: null,
    },
    deliveries: [delivery('cancelled', at(23, 18), { lastError: 'session_deleted' })],
  }),

  // The viewer's autosaved draft on the migration form (single mode: one slot).
  {
    id: 'resp-ada-draft', formId: migration.id, respondentId: 'act-ada', respondentName: 'Ada',
    status: 'draft', revision: 1, supersedesId: null, lineageKey: migration.id, isCurrent: false,
    structureVersion: 1, answers: { strategy: { value: 'dual_write' } }, questionsSnapshot: null,
    messageId: null, createdAt: at(24, 8, 40), updatedAt: at(24, 8, 45), submittedAt: null, version: 3,
    deliveries: [],
  },

  // The closed retro: two responses, amend off.
  submitted(retro, {
    id: 'resp-retro-ada', respondentId: 'act-ada', respondentName: 'Ada', submittedAt: at(18, 12),
    answers: { went_well: { values: ['reviews', 'scope'] }, change: { text: 'Smaller PRs.' } },
    deliveries: [delivery('delivered', at(18, 12), { workSessionId: 'ws-retro' })],
  }),
  submitted(retro, {
    id: 'resp-retro-noor', respondentId: 'act-noor', respondentName: 'Noor', submittedAt: at(18, 14),
    answers: { went_well: { values: ['ci'] }, change: null },
    deliveries: [delivery('delivered', at(18, 14), { workSessionId: 'ws-retro' })],
  }),
];
