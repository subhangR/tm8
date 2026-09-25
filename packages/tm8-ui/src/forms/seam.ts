/**
 * THE FORMS DATA SEAM — the one module the questionnaire block reads and
 * writes through (FORMS-DESIGN §6, §10). The block never calls a transport;
 * it calls `useFormsPort()`.
 *
 * PORTS
 *   real-port.ts     the production port, over the `forms.*` ops
 *                    (`seam.commands.forms`), `entities.get` and the durable
 *                    event stream. The host (`useGateData`) registers it with
 *                    `setDefaultFormsPort`.
 *   fixture-port.ts  in memory, TESTS ONLY. Nothing in production imports it
 *                    (forms/no-fixture-import.test.ts holds that line).
 *   unavailable      what `useFormsPort` answers when no port is registered or
 *                    mounted: every call rejects with a reason the block shows.
 *                    Never fixtures.
 *
 * The views are the contract's (advisor ruling W1-R1): this module re-exports
 * them and restates none.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type {
  FormAnswerIssue,
  FormAnswers,
  FormQuestionRow,
  FormResponseView,
  FormSectionRow,
  FormSettings,
  FormStatus,
} from '@tm8/contract';

export type {
  FormDeliveryStatus,
  FormDeliveryView,
  FormResponsePage,
  FormResponseView,
  FormSnapshot,
} from '@tm8/contract';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A keyset page, the same envelope as the other lists. */
export interface FormPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * A form's content — the contract's `form` arm of the entity DETAIL content,
 * restated structurally so this module needs no kind literal. (List rows
 * carry only `{status, questionCount}`; see `formContentOf`.)
 */
export interface FormContentView {
  status: FormStatus;
  description: string | null;
  settings: FormSettings;
  structureVersion: number;
  sections: FormSectionRow[];
  questions: FormQuestionRow[];
  openedAt: string | null;
  closedAt: string | null;
}

/**
 * A form's DETAIL content, recognised by SHAPE (questions, sections, settings,
 * status). A list row's `{status, questionCount}` is not one: null.
 */
export function formContentOf(content: unknown): FormContentView | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  return Array.isArray(c.questions) && Array.isArray(c.sections) && typeof c.settings === 'object' && c.settings !== null
    && typeof c.status === 'string'
    ? (c as unknown as FormContentView)
    : null;
}

/** The form as the block holds it: content plus the entity version it guards writes with. */
export interface FormState {
  id: string;
  title: string;
  version: number;
  content: FormContentView;
}

/** The caller's own slot on a form. */
export interface MyFormSlot {
  /** The latest submitted revision of the caller's chain, if any. */
  current: FormResponseView | null;
  /** The caller's autosaved draft (a first answer, or an amend of `current`). */
  draft: FormResponseView | null;
  /** Every submitted revision of the caller's chain, oldest first. */
  history: FormResponseView[];
}

/** Who fills, in the fixture world (the real port reads identity server-side). */
export interface FormViewer {
  memberId: string;
  displayName: string;
}

export interface FormStructureInput {
  sections: FormSectionRow[];
  questions: FormQuestionRow[];
  settings: FormSettings;
  expectedVersion: number;
}

/** What the block's subscription is told changed. */
export type FormsChange =
  /** The form entity itself: refetch its detail. */
  | { kind: 'form' }
  /** A response landed or moved (a message on the form, an activity touch). */
  | { kind: 'responses' }
  /** A work session changed: a queued delivery to it may have drained. */
  | { kind: 'session'; sessionId: string };

// ---------------------------------------------------------------------------
// Errors (the server's closed taxonomy, by code)
// ---------------------------------------------------------------------------

export type FormsPortErrorCode =
  | 'form_answers_invalid'
  | 'form_not_open'
  | 'form_structure_frozen'
  | 'form_response_limit'
  | 'form_respondent_not_allowed'
  /** TFD01: a draft for another target is in flight; `draftId` names it. Offer discard. */
  | 'draft_in_flight'
  /** A redeliver/resume the server refused (`details.reason`): toast and refetch. */
  | 'delivery_refused'
  | 'version_conflict'
  | 'conflict'
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  /** No port can reach a node (nothing registered, or the op is missing). */
  | 'unavailable'
  | 'unknown';

export class FormsPortError extends Error {
  constructor(
    readonly code: FormsPortErrorCode,
    message: string,
    readonly issues: FormAnswerIssue[] = [],
    /** `details.reason` from the server, when it sent one. */
    readonly reason: string | null = null,
    /** For `draft_in_flight`: the draft that blocks. */
    readonly draftId: string | null = null,
  ) {
    super(message);
    this.name = 'FormsPortError';
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface FormsPort {
  /** The form's DETAIL (sections, questions, settings). Refetched on entity upsert. */
  form(formId: string): Promise<FormState>;
  /** The caller's current revision, draft and history. */
  mine(formId: string): Promise<MyFormSlot>;
  /** Current (latest submitted) responses, newest first. Drafts never appear. */
  responses(formId: string, cursor?: string | null): Promise<FormPage<FormResponseView>>;
  /** One response chain's submitted revisions, oldest first. */
  revisions(formId: string, lineageKey: string): Promise<FormResponseView[]>;
  /**
   * Upsert the caller's draft. Partial validation (no `required`).
   * `responseVersion` is the draft's version (absent for the first save);
   * `supersedesId` is the revision being amended.
   */
  saveDraft(
    formId: string,
    input: { answers: FormAnswers; supersedesId: string | null; responseVersion?: number },
  ): Promise<FormResponseView>;
  /** Delete the caller's draft on this form (idempotent). */
  discardDraft(formId: string, draft?: { version: number } | null): Promise<void>;
  /** Final validation → stored → delivered. An amend passes the revision it supersedes. */
  submit(
    formId: string,
    input: { answers: FormAnswers; supersedesId: string | null; responseVersion?: number },
  ): Promise<FormResponseView>;
  /**
   * Questions, sections and settings. Refused with `form_structure_frozen`
   * after the first submit. The real port issues it as ordered per-op calls
   * and throws `FormsStructureSaveError` when one fails part-way.
   */
  updateStructure(formId: string, input: FormStructureInput): Promise<FormState>;
  transition(formId: string, to: 'open' | 'closed' | 'cancelled', expectedVersion: number): Promise<FormState>;
  /**
   * Re-drive one response's delivery (`forms.responses.redeliver`):
   * `resume` a queued one now, or send a cancelled one to a `new_session`.
   * Absent when the node's catalog lacks the op: the chip disables its button.
   */
  redeliver?(responseId: string, workSessionId: string, to: 'resume' | 'new_session'): Promise<void>;
  /** Anything about this form changed (a response, the structure, the status). */
  subscribe(formId: string, onChange: (change: FormsChange) => void): () => void;
}

/** `port.redeliver` bound to one response, or undefined when the node lacks the op. */
export function redeliverFor(
  port: FormsPort,
  responseId: string,
): ((workSessionId: string, to: 'resume' | 'new_session') => Promise<void>) | undefined {
  const redeliver = port.redeliver?.bind(port);
  return redeliver ? (workSessionId, to) => redeliver(responseId, workSessionId, to) : undefined;
}

/** The structure save stopped part-way: `done` of `total` steps landed. */
export class FormsStructureSaveError extends Error {
  constructor(
    readonly done: number,
    readonly total: number,
    /** A plain-language name for the step that failed. */
    readonly step: string,
    readonly cause: unknown,
    /** The form as the last successful step left it (the base for a retry). */
    readonly form: FormState,
  ) {
    super(`Saved ${done} of ${total} changes; stopped at ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'FormsStructureSaveError';
  }
}

/** The honest no-node port: every call says why it cannot answer. */
export function createUnavailableFormsPort(
  reason = 'Forms need a connection to a tm8 node, and this view has none.',
): FormsPort {
  const refuse = async (): Promise<never> => {
    throw new FormsPortError('unavailable', reason);
  };
  return {
    form: refuse,
    mine: refuse,
    responses: refuse,
    revisions: refuse,
    saveDraft: refuse,
    discardDraft: refuse,
    submit: refuse,
    updateStructure: refuse,
    transition: refuse,
    subscribe: () => () => {},
  };
}

const FormsPortContext = createContext<FormsPort | null>(null);

let fallbackPort: (() => FormsPort) | null = null;
let fallbackInstance: FormsPort | null = null;

/** The port used when no provider is mounted. The host registers the real one. */
export function setDefaultFormsPort(factory: (() => FormsPort) | null): void {
  fallbackPort = factory;
  fallbackInstance = null;
}

export function FormsPortProvider({ port, children }: { port: FormsPort; children?: ReactNode }) {
  return createElement(FormsPortContext.Provider, { value: port }, children);
}

export function useFormsPort(): FormsPort {
  const port = useContext(FormsPortContext);
  if (port) return port;
  fallbackInstance ??= fallbackPort ? fallbackPort() : createUnavailableFormsPort();
  return fallbackInstance;
}
