/**
 * THE FORMS DATA SEAM — the one module the questionnaire block reads and
 * writes through (FORMS-DESIGN §6, §10).
 *
 * W1 ships it over in-memory fixtures (`fixture-port.ts`); W3 swaps the port
 * for the real `forms.*` operations and drives `subscribe` from the existing
 * entity-upsert / message events. Nothing else in the UI changes: the block
 * never calls a transport, it calls `useFormsPort()`.
 *
 * THE SWAP, concretely: mount `<FormsPortProvider port={realPort}>` at the
 * host (or change `defaultFormsPort`), where `realPort` implements
 * `FormsPort` with
 *   mine            → forms.responses.list ?respondent=me (current + draft) and
 *                     forms.responses.list ?lineage (history)
 *   responses       → forms.responses.list (current rows, keyset-paged)
 *   revisions       → forms.responses.list ?lineage=<key>
 *   saveDraft       → forms.responses.save      (PUT  /forms/:id/responses/mine)
 *   discardDraft    → forms.responses.save      (discard)
 *   submit          → forms.responses.submit    (POST /forms/:id/responses/submit)
 *   updateStructure → forms.update + forms.questions.add/update/remove/move
 *   transition      → forms.transition
 *   resumeDelivery  → W2/W3 delivery door (a stub until then)
 *   subscribe       → entity-upsert(form) + message events on the form anchor
 * and maps the server's closed error taxonomy onto `FormsPortError.code`.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type {
  FormAnswerIssue,
  FormAnswers,
  FormQuestionRow,
  FormSectionRow,
  FormSettings,
  FormStatus,
} from '@tm8/contract';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * What `internal.form_snapshot` freezes onto a submitted response.
 * mirror of contract FormSnapshotSchema (Backend W1). Import once it lands.
 */
export interface FormSnapshot {
  structureVersion: number;
  sections: FormSectionRow[];
  questions: FormQuestionRow[];
}

export type FormDeliveryStatus = 'pending' | 'delivered' | 'spawned' | 'cancelled';

/** mirror of contract FormDeliveryViewSchema (Backend W1). Import once it lands. */
export interface FormDeliveryView {
  workSessionId: string;
  status: FormDeliveryStatus;
  spawnedSessionId: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
}

/** mirror of contract FormResponseViewSchema (Backend W1). Import once it lands. */
export interface FormResponseView {
  id: string;
  formId: string;
  respondentId: string;
  respondentName: string | null;
  status: 'draft' | 'submitted';
  revision: number;
  supersedesId: string | null;
  lineageKey: string;
  isCurrent: boolean;
  structureVersion: number;
  answers: FormAnswers;
  questionsSnapshot: FormSnapshot | null;
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  version: number;
  deliveries: FormDeliveryView[];
}

/** A keyset page, the same envelope as the other lists. */
export interface FormPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * A form's content — the contract's `form` arm of `EntityContent`, restated
 * structurally so this module needs no kind literal.
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

/** The lifecycle (§5): which statuses each status may move to. */
export const FORM_TRANSITIONS: Readonly<Record<FormStatus, readonly ('open' | 'closed' | 'cancelled')[]>> = {
  draft: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['open', 'cancelled'],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Errors (the server's closed taxonomy, by code)
// ---------------------------------------------------------------------------

export type FormsPortErrorCode =
  | 'form_answers_invalid'
  | 'form_not_open'
  | 'form_structure_frozen'
  | 'form_response_limit'
  | 'form_respondent_not_allowed'
  | 'version_conflict'
  | 'conflict'
  | 'invalid_input'
  | 'not_found';

export class FormsPortError extends Error {
  constructor(
    readonly code: FormsPortErrorCode,
    message: string,
    readonly issues: FormAnswerIssue[] = [],
  ) {
    super(message);
    this.name = 'FormsPortError';
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface FormsPort {
  /** Who is filling. */
  viewer(): FormViewer;
  /** The caller's current revision, draft and history. */
  mine(formId: string): Promise<MyFormSlot>;
  /** Current (latest submitted) responses, newest first. Drafts never appear. */
  responses(formId: string, cursor?: string | null): Promise<FormPage<FormResponseView>>;
  /** One response chain's submitted revisions, oldest first. */
  revisions(formId: string, lineageKey: string): Promise<FormResponseView[]>;
  /** Upsert the caller's draft. Partial validation (no `required`). */
  saveDraft(formId: string, input: { answers: FormAnswers; supersedesId: string | null }): Promise<FormResponseView>;
  discardDraft(formId: string, draftId: string): Promise<void>;
  /** Final validation → stored → delivered. An amend passes the revision it supersedes. */
  submit(formId: string, input: { answers: FormAnswers; supersedesId: string | null }): Promise<FormResponseView>;
  /** Questions, sections and settings. Refused with `form_structure_frozen` after the first submit. */
  updateStructure(formId: string, input: FormStructureInput): Promise<FormState>;
  transition(formId: string, to: 'open' | 'closed' | 'cancelled', expectedVersion: number): Promise<FormState>;
  /** "Resume now" on a queued delivery. A stub until W3 wires the delivery door. */
  resumeDelivery(responseId: string, workSessionId: string): Promise<void>;
  /** Anything about this form changed (a response, the structure, the status). */
  subscribe(formId: string, onChange: () => void): () => void;
}

const FormsPortContext = createContext<FormsPort | null>(null);

let fallbackPort: (() => FormsPort) | null = null;
let fallbackInstance: FormsPort | null = null;

/**
 * The port used when no provider is mounted. W1 registers the fixture port
 * here (see `fixture-port.ts`); W3 registers the real one.
 */
export function setDefaultFormsPort(factory: () => FormsPort): void {
  fallbackPort = factory;
  fallbackInstance = null;
}

export function FormsPortProvider({ port, children }: { port: FormsPort; children?: ReactNode }) {
  return createElement(FormsPortContext.Provider, { value: port }, children);
}

export function useFormsPort(): FormsPort {
  const port = useContext(FormsPortContext);
  if (port) return port;
  if (!fallbackPort) throw new Error('no FormsPort: mount FormsPortProvider or call setDefaultFormsPort');
  fallbackInstance ??= fallbackPort();
  return fallbackInstance;
}
