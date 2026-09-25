/**
 * `tm8 form …` — the fifteen forms.* operations (FORMS-DESIGN §6, §8; advisor
 * rulings W1-R1..R4; W3's redeliver and pending).
 *
 *   form create                    forms.create
 *   form update                    forms.update
 *   form question add|update|remove|move   forms.questions.*
 *   form open|close|cancel|reopen  forms.transition (reopen = to:open)
 *   form submit                    forms.responses.submit
 *   form response save|discard     forms.responses.save|discard
 *   form response list|get|mine    forms.responses.list|get|mine
 *   form response redeliver        forms.responses.redeliver (W3: new session / resume now)
 *   form pending                   forms.pendingForSessions (W3: what waits on me)
 *   form wait                      a CLI loop over events.changes + the reads
 *                                  (W2, §7.4) — see `./form-wait.ts`
 *
 * EVERY WRITE IS VALIDATED HERE FIRST. The wire schemas carry questions raw and
 * the Server validates config and answers only in SQL, so the contract's Zod
 * schemas and the registry's `validateFormAnswers` run before any call — see
 * `../form-input.ts`. A failing spec or answer set exits 2 and sends nothing.
 *
 * TWO VERSIONS, NEVER CONFUSED (W1-R2). Structure and lifecycle writes guard
 * the FORM (`--expect-version`, required); draft save, submit and discard guard
 * the caller's RESPONSE (`--response-version`, optional). A respondent is never
 * asked for the form's version.
 */
import type {
  FormQuestionRef,
  FormResponsePage,
  FormResponseView,
  FormsPendingForSessionsResult,
  FormsResponsesRedeliverResult,
} from '@tm8/contract';
import { FORM_TRANSITIONS, FORMS_PENDING_MAX_SESSIONS, renderFormResponseText } from '@tm8/contract';
import { readJsonSource } from '../args.js';
import { requireSpace } from '../context.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import {
  assembleSpec,
  parseQuestionShorthand,
  validateAnswers,
  validateQuestion,
  validateSections,
  validateSettingsPatch,
} from '../form-input.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { formWait } from './form-wait.js';

// ── argument helpers ───────────────────────────────────────────────────────

function positional(cmd: CommandContext, index: number, command: string, placeholder: string): string {
  const value = cmd.args[index];
  if (value === undefined || value.length === 0) {
    throw new CliError(`tm8 ${command} requires ${placeholder}`, EXIT_USAGE, { hint: `tm8 help ${command}` });
  }
  return value;
}

function expectVersion(cmd: CommandContext, command: string): number {
  const v = cmd.options.integer('expect-version');
  if (v === undefined || v < 1) {
    throw new CliError(`tm8 ${command} requires --expect-version <n> (the FORM's version)`, EXIT_USAGE, {
      hint: 'read it with `tm8 entity context <form-id>`; every create/update receipt prints it too',
    });
  }
  return v;
}

function responseVersion(cmd: CommandContext): number | undefined {
  const v = cmd.options.integer('response-version');
  if (v !== undefined && v < 1) throw new CliError('--response-version must be a positive integer', EXIT_USAGE);
  return v;
}

async function readObject(raw: string, flag: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonSource(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${flag} expects a JSON object`, EXIT_USAGE);
  }
  return parsed as Record<string, unknown>;
}

/** The command envelope every forms.* mutation carries. */
function envelope(cmd: CommandContext): Record<string, unknown> {
  return {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}),
    ...(cmd.ctx.sessionId ? { workSessionId: cmd.ctx.sessionId } : {}),
  };
}

function refuseBoth(cmd: CommandContext, a: string, b: string): void {
  if (cmd.options.has(a) && cmd.options.has(b)) {
    throw new CliError(`--${a} and --${b} are mutually exclusive`, EXIT_USAGE);
  }
}

/**
 * The questions a response is validated against: the form's stored rows, read
 * through the universal entity read (the `form` content arm).
 */
async function formQuestions(cmd: CommandContext, formId: string): Promise<FormQuestionRef[]> {
  const detail = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.get', { params: { id: formId } });
  const content = (detail as { content?: { kind?: unknown; questions?: unknown } } | null)?.content;
  if (content?.kind !== 'form' || !Array.isArray(content.questions)) {
    throw new CliError(`${formId} is not a form`, EXIT_USAGE, { hint: 'check the id with `tm8 entity context <id>`' });
  }
  return content.questions as FormQuestionRef[];
}

/** The contract's lifecycle table as one line: `draft->open|cancelled; …`. */
export function transitionsText(): string {
  return Object.entries(FORM_TRANSITIONS)
    .map(([from, to]) => `${from}->${to.length > 0 ? to.join('|') : '(terminal)'}`)
    .join('; ');
}

/**
 * Local advice for the conflicts a respondent or author can act on (W1-R4 6).
 * The Server's code and reason still print first; nothing is retried.
 */
function withFormHints<T>(formId: string, run: () => Promise<T>): Promise<T> {
  return run().catch((err: unknown) => {
    if (err instanceof ApiError) {
      const details = (err.details ?? {}) as Record<string, unknown>;
      switch (err.reason) {
        case 'form_structure_changed':
          err.hint = `the form changed; re-fetch with \`tm8 entity get ${formId}\` and re-run`;
          break;
        case 'form_response_version':
          err.hint = `your draft changed elsewhere; re-read it with \`tm8 form response list ${formId} --respondent me\` and pass its version as --response-version`;
          break;
        case 'form_draft_in_flight':
          err.hint = `draft ${String(details.draftId ?? '(unnamed)')} is in flight; submit it, or drop it with \`tm8 form response discard ${formId}\``;
          break;
        case 'form_transition_invalid':
          err.hint = `${String(details.from ?? '?')} -> ${String(details.to ?? '?')} is not a transition; allowed: ${transitionsText()}`;
          break;
        default:
          break;
      }
    }
    throw err;
  });
}

// ── form create / update ───────────────────────────────────────────────────

async function formCreate(cmd: CommandContext): Promise<ExitCode> {
  refuseBoth(cmd, 'open', 'draft');
  const specSource = cmd.options.value('spec');
  const settingsSource = cmd.options.value('settings');
  const settings = settingsSource === undefined ? undefined : await readObject(settingsSource, '--settings');
  if (settings !== undefined) validateSettingsPatch(settings);
  const title = cmd.options.value('title');
  const description = cmd.options.value('description');
  const forSession = cmd.options.value('for-session');
  const spec = assembleSpec({
    ...(specSource === undefined ? {} : { spec: await readObject(specSource, '--spec') }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    questions: cmd.options.values('question'),
    optional: cmd.options.values('optional'),
    sections: cmd.options.values('section'),
    ...(settings === undefined ? {} : { settings }),
    ...(cmd.options.bool('open') ? { open: true } : cmd.options.bool('draft') ? { open: false } : {}),
    ...(forSession === undefined ? {} : { forSession }),
    attachTo: cmd.options.values('attach'),
  });

  const parent = cmd.options.value('parent');
  const body = {
    ...envelope(cmd),
    spaceId: requireSpace(cmd.ctx),
    ...spec,
    ...(parent === undefined ? {} : { parentId: parent }),
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.create', { body });
  const base = cmd.ctx.baseUrl.value.replace(/\/+$/, '');
  cmd.out.data(data, (dto) => renderCreated(dto, base));
  return EXIT_OK;
}

async function formUpdate(cmd: CommandContext): Promise<ExitCode> {
  const formId = positional(cmd, 0, 'form update', '<form-id>');
  const expectedVersion = expectVersion(cmd, 'form update');
  const patch: Record<string, unknown> = {};
  const title = cmd.options.value('title');
  if (title !== undefined) patch.title = title;
  const description = cmd.options.value('description');
  if (description !== undefined) patch.description = description;
  const settings = cmd.options.value('settings');
  if (settings !== undefined) {
    patch.settings = await readObject(settings, '--settings');
    validateSettingsPatch(patch.settings);
  }
  const sections = cmd.options.value('sections');
  if (sections !== undefined) {
    patch.sections = await readJsonSource(sections);
    validateSections(patch.sections);
  }
  if (Object.keys(patch).length === 0) {
    throw new CliError('tm8 form update needs at least one of --title, --description, --settings, --sections', EXIT_USAGE);
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.update', {
    params: { formId },
    body: { ...envelope(cmd), expectedVersion, ...patch },
  });
  cmd.out.data(data, renderFormResult);
  return EXIT_OK;
}

// ── form question add / update / remove / move ─────────────────────────────

async function questionAdd(cmd: CommandContext): Promise<ExitCode> {
  const formId = positional(cmd, 0, 'form question add', '<form-id>');
  const expectedVersion = expectVersion(cmd, 'form question add');
  refuseBoth(cmd, 'question', 'spec');
  refuseBoth(cmd, 'after', 'first');
  const shorthand = cmd.options.value('question');
  const specSource = cmd.options.value('spec');
  if (shorthand === undefined && specSource === undefined) {
    throw new CliError('tm8 form question add needs --question <key:type:title[:options]> or --spec <json-source>', EXIT_USAGE);
  }
  const question = shorthand !== undefined ? parseQuestionShorthand(shorthand) : await readObject(specSource as string, '--spec');
  for (const key of cmd.options.values('optional')) {
    if (key !== question.key) throw new CliError(`--optional ${key} names no question in this command (adding ${String(question.key)})`, EXIT_USAGE);
    question.required = false;
  }
  const section = cmd.options.value('section');
  if (section !== undefined) question.section = section;
  const help = cmd.options.value('help-text');
  if (help !== undefined) question.help = help;
  validateQuestion(question);

  const after = cmd.options.value('after');
  const body: Record<string, unknown> = { ...envelope(cmd), expectedVersion, question };
  if (after !== undefined) body.after = after;
  else if (cmd.options.bool('first')) body.after = null;
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.questions.add', { params: { formId }, body });
  cmd.out.data(data, renderFormResult);
  return EXIT_OK;
}

/** `true|false`, spelled out: a bare boolean could not say which way. */
function parseBool(raw: string, flag: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new CliError(`${flag} expects true|false, got ${JSON.stringify(raw)}`, EXIT_USAGE);
}

async function questionUpdate(cmd: CommandContext): Promise<ExitCode> {
  const formId = positional(cmd, 0, 'form question update', '<form-id>');
  const key = positional(cmd, 1, 'form question update', '<question-key>');
  const expectedVersion = expectVersion(cmd, 'form question update');
  const patch: Record<string, unknown> = {};
  for (const [flag, field] of [['title', 'title'], ['type', 'type']] as const) {
    const v = cmd.options.value(flag);
    if (v !== undefined) patch[field] = v;
  }
  // An empty value CLEARS the two nullable fields; the wire spells that null.
  for (const [flag, field] of [['help-text', 'help'], ['section', 'section']] as const) {
    const v = cmd.options.value(flag);
    if (v !== undefined) patch[field] = v === '' ? null : v;
  }
  const required = cmd.options.value('required');
  if (required !== undefined) patch.required = parseBool(required, '--required');
  const config = cmd.options.value('config');
  if (config !== undefined) patch.config = await readObject(config, '--config');
  if (Object.keys(patch).length === 0) {
    throw new CliError('tm8 form question update needs at least one of --title, --type, --help-text, --section, --required, --config', EXIT_USAGE);
  }

  // Validate the MERGED question locally, send ONLY the patch (W1-R4 5b). A
  // key the form does not have is left to the Server's not_found.
  const current = (await formQuestions(cmd, formId)).find((q) => q.key === key) as
    | (FormQuestionRef & Record<string, unknown>)
    | undefined;
  if (current !== undefined) {
    const { position: _position, ...stored } = current;
    const merged: Record<string, unknown> = { ...stored, ...patch };
    for (const field of ['help', 'section']) if (merged[field] === null) delete merged[field];
    validateQuestion(merged);
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.questions.update', {
    params: { formId, questionKey: key },
    body: { ...envelope(cmd), expectedVersion, ...patch },
  });
  cmd.out.data(data, renderFormResult);
  return EXIT_OK;
}

async function questionRemove(cmd: CommandContext): Promise<ExitCode> {
  const formId = positional(cmd, 0, 'form question remove', '<form-id>');
  const key = positional(cmd, 1, 'form question remove', '<question-key>');
  const expectedVersion = expectVersion(cmd, 'form question remove');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.questions.remove', {
    params: { formId, questionKey: key },
    body: { ...envelope(cmd), expectedVersion },
  });
  cmd.out.data(data, renderFormResult);
  return EXIT_OK;
}

async function questionMove(cmd: CommandContext): Promise<ExitCode> {
  const formId = positional(cmd, 0, 'form question move', '<form-id>');
  const key = positional(cmd, 1, 'form question move', '<question-key>');
  const expectedVersion = expectVersion(cmd, 'form question move');
  refuseBoth(cmd, 'after', 'first');
  const after = cmd.options.value('after');
  if (after === undefined && !cmd.options.bool('first')) {
    throw new CliError('tm8 form question move needs --after <question-key> or --first', EXIT_USAGE);
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.questions.move', {
    params: { formId, questionKey: key },
    body: { ...envelope(cmd), expectedVersion, after: after ?? null },
  });
  cmd.out.data(data, renderFormResult);
  return EXIT_OK;
}

// ── form open / close / cancel / reopen ────────────────────────────────────

function transition(verb: string, to: 'open' | 'closed' | 'cancelled') {
  return async (cmd: CommandContext): Promise<ExitCode> => {
    const formId = positional(cmd, 0, `form ${verb}`, '<form-id>');
    const expectedVersion = expectVersion(cmd, `form ${verb}`);
    const reason = cmd.options.value('reason');
    const data = await withFormHints(formId, () =>
      observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.transition', {
        params: { formId },
        body: { ...envelope(cmd), expectedVersion, to, ...(reason === undefined ? {} : { reason }) },
      }),
    );
    cmd.out.data(data, renderFormResult);
    return EXIT_OK;
  };
}

// ── responses ──────────────────────────────────────────────────────────────

async function responseWrite(cmd: CommandContext, final: boolean): Promise<ExitCode> {
  const command = final ? 'form submit' : 'form response save';
  const formId = positional(cmd, 0, command, '<form-id>');
  const source = cmd.options.value('answers');
  if (source === undefined && !final) {
    throw new CliError('tm8 form response save requires --answers <json-source>', EXIT_USAGE);
  }
  const body: Record<string, unknown> = envelope(cmd);
  if (source !== undefined) {
    const answers = await readJsonSource(source);
    validateAnswers(await formQuestions(cmd, formId), answers, final);
    body.answers = answers;
  }
  const amendOf = cmd.options.value('amend-of');
  if (amendOf !== undefined) body.amendOf = amendOf;
  const version = responseVersion(cmd);
  if (version !== undefined) body.responseVersion = version;

  const op = final ? 'forms.responses.submit' : 'forms.responses.save';
  const data = await withFormHints(formId, () =>
    observedInvoke<unknown>(clientFor(cmd.ctx), op, { params: { formId }, body }),
  );
  cmd.out.data(data, renderResponse);
  return EXIT_OK;
}

async function responseDiscard(cmd: CommandContext): Promise<ExitCode> {
  const formId = positional(cmd, 0, 'form response discard', '<form-id>');
  const version = responseVersion(cmd);
  const data = await withFormHints(formId, () =>
    observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.responses.discard', {
      params: { formId },
      body: { ...envelope(cmd), ...(version === undefined ? {} : { responseVersion: version }) },
    }),
  );
  cmd.out.data(data, (dto) => {
    const d = (dto ?? {}) as { discarded?: unknown; responseId?: unknown };
    return d.discarded === true ? `discarded draft ${String(d.responseId)}` : 'no draft to discard';
  });
  return EXIT_OK;
}

function pageQuery(cmd: CommandContext): Record<string, string | undefined> {
  const limit = cmd.options.integer('limit');
  return {
    ...(limit === undefined ? {} : { limit: String(limit) }),
    cursor: cmd.options.value('cursor'),
  };
}

async function responseList(cmd: CommandContext): Promise<ExitCode> {
  const formId = positional(cmd, 0, 'form response list', '<form-id>');
  refuseBoth(cmd, 'respondent', 'lineage');
  const respondent = cmd.options.value('respondent');
  if (respondent !== undefined && respondent !== 'me') {
    throw new CliError(`--respondent accepts only \`me\`, got ${JSON.stringify(respondent)}`, EXIT_USAGE);
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.responses.list', {
    params: { formId },
    query: { ...pageQuery(cmd), respondent, lineageKey: cmd.options.value('lineage') },
  });
  cmd.out.data(data, renderPage);
  return EXIT_OK;
}

async function responseGet(cmd: CommandContext): Promise<ExitCode> {
  const responseId = positional(cmd, 0, 'form response get', '<response-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.responses.get', { params: { responseId } });
  cmd.out.data(data, renderResponse);
  return EXIT_OK;
}

async function responseMine(cmd: CommandContext): Promise<ExitCode> {
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.responses.mine', {
    query: { ...pageQuery(cmd), spaceId: requireSpace(cmd.ctx) },
  });
  cmd.out.data(data, renderPage);
  return EXIT_OK;
}

/**
 * `form response redeliver`: "Send to a new session" for a cancelled delivery
 * (the default), or `--to resume` — "Resume now" for a queued one.
 */
async function responseRedeliver(cmd: CommandContext): Promise<ExitCode> {
  const responseId = positional(cmd, 0, 'form response redeliver', '<response-id>');
  const to = cmd.options.value('to') ?? 'new_session';
  if (to !== 'new_session' && to !== 'resume') {
    throw new CliError(`--to accepts new_session or resume, got ${JSON.stringify(to)}`, EXIT_USAGE);
  }
  const session = cmd.options.value('session');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.responses.redeliver', {
    params: { responseId },
    body: { ...envelope(cmd), to, ...(session === undefined ? {} : { deliverySessionId: session }) },
  });
  cmd.out.data(data, renderRedelivered);
  return EXIT_OK;
}

/** `form pending <session-id>…`: the forms each session is waiting on the caller for. */
async function formPending(cmd: CommandContext): Promise<ExitCode> {
  const sessionIds = cmd.args.flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
  if (sessionIds.length === 0) {
    throw new CliError('tm8 form pending requires at least one <session-id>', EXIT_USAGE, { hint: 'tm8 help form pending' });
  }
  if (sessionIds.length > FORMS_PENDING_MAX_SESSIONS) {
    throw new CliError(`tm8 form pending reads at most ${FORMS_PENDING_MAX_SESSIONS} sessions per call`, EXIT_USAGE);
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'forms.pendingForSessions', {
    query: { spaceId: requireSpace(cmd.ctx), sessionIds: [...new Set(sessionIds)].join(',') },
  });
  cmd.out.data(data, renderPending);
  return EXIT_OK;
}

// ── human renderings (the same DTO --format json emits) ────────────────────

export function renderRedelivered(dto: unknown): string {
  const r = (dto ?? {}) as Partial<FormsResponsesRedeliverResult>;
  const what = r.to === 'resume' ? 'resume of session' : 'new session for the delivery to';
  return r.redelivered
    ? `queued ${what} ${String(r.workSessionId)} (response ${String(r.responseId)}, now ${String(r.status)})\n` +
      `next: tm8 form response get ${String(r.responseId)}`
    : `already routed: response ${String(r.responseId)} → session ${String(r.workSessionId)} is ${String(r.status)}`;
}

export function renderPending(dto: unknown): string {
  const sessions = ((dto ?? {}) as Partial<FormsPendingForSessionsResult>).sessions ?? [];
  if (sessions.length === 0) return 'nothing waiting';
  const lines: string[] = [];
  for (const s of sessions) {
    lines.push(`session ${s.workSessionId}: ${s.total} form${s.total === 1 ? '' : 's'} waiting` +
      (s.queued > 0 ? ` · ${s.queued} answer${s.queued === 1 ? '' : 's'} queued` : ''));
    for (const f of s.forms) {
      lines.push(`  ${f.formId}  v${f.version}  ${f.questionCount} question${f.questionCount === 1 ? '' : 's'}` +
        `${f.draft ? '  draft saved' : ''}  ${JSON.stringify(f.title)}`);
    }
    if (s.total > s.forms.length) lines.push(`  … and ${s.total - s.forms.length} more`);
  }
  return lines.join('\n');
}

interface FormEntity {
  id?: unknown;
  version?: unknown;
  title?: unknown;
  content?: { status?: unknown; questions?: unknown; structureVersion?: unknown };
}

function formLine(entity: FormEntity | undefined): string {
  if (entity === undefined) return 'form (no entity returned)';
  const c = entity.content ?? {};
  const n = Array.isArray(c.questions) ? c.questions.length : 0;
  return `form ${String(entity.id)}  v${String(entity.version)}  ${String(c.status ?? '?')}  ` +
    `${n} question${n === 1 ? '' : 's'} (structure v${String(c.structureVersion ?? '?')})  ${JSON.stringify(String(entity.title ?? ''))}`;
}

export function renderCreated(dto: unknown, base = ''): string {
  const d = (dto ?? {}) as { entity?: FormEntity; url?: unknown; requestingSessionId?: unknown; attachedTo?: unknown };
  const id = String(d.entity?.id ?? '');
  const attached = Array.isArray(d.attachedTo) ? d.attachedTo : [];
  return [
    formLine(d.entity),
    `url: ${base}${String(d.url ?? '')}`,
    `answers go to: ${d.requestingSessionId ? `session ${String(d.requestingSessionId)}` : '(no requesting session)'}` +
      (attached.length > 0 ? `  ·  attached to ${attached.join(', ')}` : ''),
    // A draft takes no answers yet: its next step is opening it, not reading responses.
    d.entity?.content?.status === 'draft'
      ? `next: tm8 form open ${id} --expect-version ${String(d.entity.version ?? '?')}`
      : `next: tm8 form response list ${id}`,
  ].join('\n');
}

export function renderFormResult(dto: unknown): string {
  return formLine((dto as { entity?: FormEntity } | null)?.entity);
}

export function renderResponse(dto: unknown): string {
  const r = (dto ?? {}) as Partial<FormResponseView>;
  const who = r.respondentName ?? r.respondentId ?? '?';
  const lines = [
    `response ${String(r.id)}  rev ${String(r.revision)}  ${String(r.status)}${r.isCurrent ? '  current' : r.status === 'submitted' ? '  superseded' : ''}  v${String(r.version)}`,
    `form ${String(r.formId)}  respondent ${who}  lineage ${String(r.lineageKey)}` +
      (r.supersedesId ? `  amends ${r.supersedesId}` : ''),
  ];
  if (r.submittedAt) lines.push(`submitted ${r.submittedAt}`);
  const questions = r.questionsSnapshot?.questions;
  if (questions && r.answers) {
    // The registry renders each answer (the §7.2 text); no type switch here.
    lines.push(...renderFormResponseText({ title: '', questions, answers: r.answers }).split('\n').slice(1));
  } else if (r.answers) {
    lines.push('answers (draft; rendered against the live form on submit):');
    for (const [k, v] of Object.entries(r.answers)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  }
  for (const d of r.deliveries ?? []) {
    lines.push(
      `delivery → session ${d.workSessionId}: ${d.status}` +
        (d.spawnedSessionId ? ` (spawned ${d.spawnedSessionId})` : '') +
        ` · attempts ${d.attempts}` + (d.lastError ? ` · last error: ${d.lastError}` : ''),
    );
  }
  return lines.join('\n');
}

export function renderPage(dto: unknown): string {
  const page = (dto ?? {}) as Partial<FormResponsePage>;
  const items = page.items ?? [];
  if (items.length === 0) return 'no responses';
  const lines = items.map((r) =>
    [r.id, `rev ${r.revision}`, r.status, r.isCurrent ? 'current' : '', r.respondentName ?? r.respondentId, r.submittedAt ?? r.updatedAt, `form ${r.formId}`]
      .filter((p) => p !== '')
      .join('  '),
  );
  if (page.nextCursor) lines.push(`next: --cursor ${page.nextCursor}`);
  return lines.join('\n');
}

/** Wired into `src/commands/registry.ts`: one import, one spread. */
export const FORM_COMMANDS: CommandModule[] = [
  { path: ['form', 'create'], run: formCreate },
  { path: ['form', 'update'], run: formUpdate },
  { path: ['form', 'question', 'add'], run: questionAdd },
  { path: ['form', 'question', 'update'], run: questionUpdate },
  { path: ['form', 'question', 'remove'], run: questionRemove },
  { path: ['form', 'question', 'move'], run: questionMove },
  { path: ['form', 'open'], run: transition('open', 'open') },
  { path: ['form', 'close'], run: transition('close', 'closed') },
  { path: ['form', 'cancel'], run: transition('cancel', 'cancelled') },
  { path: ['form', 'reopen'], run: transition('reopen', 'open') },
  { path: ['form', 'submit'], run: (cmd) => responseWrite(cmd, true) },
  { path: ['form', 'response', 'save'], run: (cmd) => responseWrite(cmd, false) },
  { path: ['form', 'response', 'discard'], run: responseDiscard },
  { path: ['form', 'response', 'list'], run: responseList },
  { path: ['form', 'response', 'get'], run: responseGet },
  { path: ['form', 'response', 'mine'], run: responseMine },
  { path: ['form', 'response', 'redeliver'], run: responseRedeliver },
  { path: ['form', 'pending'], run: formPending },
  { path: ['form', 'wait'], run: formWait },
];
