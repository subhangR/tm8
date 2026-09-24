/**
 * The `forms.*` operations as the real FormsPort needs them: one typed
 * function per catalog row, nothing else. `data/real/ops.ts` implements it
 * over HTTP (`seam.commands.forms`); `real-port.ts` builds the block's
 * `FormsPort` on top of it; the port tests drive a fake of it.
 *
 * Commands take the contract's input VERBATIM minus `clientMutationId`, which
 * the implementation mints per call.
 */
import type {
  CommandResult,
  FormResponsePage,
  FormResponseView,
  FormsQuestionsAddInput,
  FormsQuestionsMoveInput,
  FormsQuestionsUpdateInput,
  FormsResponsesSaveInput,
  FormsResponsesSubmitInput,
  FormsTransitionInput,
  FormsUpdateInput,
} from '@tm8/contract';

type Cmd<T> = Omit<T, 'clientMutationId' | 'actorId' | 'workSessionId'>;

export interface FormsListQuery {
  respondent?: 'me';
  lineageKey?: string;
  cursor?: string;
  limit?: number;
}

/** `forms.responses.redeliver` (agent-guidance PR). `to` defaults to new_session. */
export interface FormsRedeliverInput {
  workSessionId?: string;
  to?: 'new_session' | 'resume';
}

export interface FormsOps {
  update(formId: string, input: Cmd<FormsUpdateInput>): Promise<CommandResult>;
  questionsAdd(formId: string, input: Cmd<FormsQuestionsAddInput>): Promise<CommandResult>;
  questionsUpdate(formId: string, key: string, input: Cmd<FormsQuestionsUpdateInput>): Promise<CommandResult>;
  questionsRemove(formId: string, key: string, input: { expectedVersion: number }): Promise<CommandResult>;
  questionsMove(formId: string, key: string, input: Cmd<FormsQuestionsMoveInput>): Promise<CommandResult>;
  transition(formId: string, input: Cmd<FormsTransitionInput>): Promise<CommandResult>;
  responsesSave(formId: string, input: Cmd<FormsResponsesSaveInput>): Promise<FormResponseView>;
  responsesDiscard(formId: string, input: { responseVersion?: number }): Promise<{ discarded: boolean }>;
  responsesSubmit(formId: string, input: Cmd<FormsResponsesSubmitInput>): Promise<FormResponseView>;
  responsesList(formId: string, query?: FormsListQuery): Promise<FormResponsePage>;
  /**
   * Present only when this build's catalog carries the op (feature-detected;
   * the agent-guidance PR adds it). Absent ⇒ the chip's action is disabled.
   */
  redeliver?(responseId: string, input: FormsRedeliverInput): Promise<unknown>;
}
