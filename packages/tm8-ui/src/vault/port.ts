import {
  VAULT_INPUT_SCHEMAS, VAULT_OUTPUT_SCHEMAS, vaultStepUpBoundParams,
  type VaultInput, type VaultOutput, type VaultOperationName, type VaultStepUpAction,
} from '@tm8/contract';
import { VaultUiError, vaultError } from './errors';
import { browserVaultAuthenticator, type VaultAuthenticator } from './webauthn';

export interface VaultCallOptions {
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, unknown>>;
  body?: unknown;
}

/** WS-A supplies the catalog adapter. This module never imports HttpClient or a seam. */
export interface VaultTransport {
  call<T>(op: VaultOperationName, opts?: VaultCallOptions): Promise<T>;
}

export type VaultStepUpBody<A extends VaultStepUpAction> = Omit<VaultInput<A>, 'stepUp'>;
export type VaultValidatedCall = <N extends VaultOperationName>(
  op: N, opts?: VaultCallOptions,
) => Promise<VaultOutput<N>>;

const mutation = () => ({ clientMutationId: `vault-${crypto.randomUUID()}` });

async function ceremony<T>(perform: () => Promise<T>): Promise<T> {
  try { return await perform(); }
  catch (error) { throw vaultError(error); }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** One immutable snapshot is used for the challenge and the eventual command. */
export function createStepUpRequester(call: VaultValidatedCall, authenticator: VaultAuthenticator) {
  return async function requestStepUp<A extends VaultStepUpAction>(
    action: A, pathParams: Readonly<Record<string, string>>, body: VaultStepUpBody<A>,
  ): Promise<VaultOutput<A>> {
    let params: Readonly<Record<string, string>>;
    let unsigned: VaultStepUpBody<A>;
    try {
      params = freeze(structuredClone(pathParams));
      unsigned = freeze(structuredClone(body));
      // Checks the reserved path namespace using the broker's binding function.
      vaultStepUpBoundParams(params, unsigned);
      if (Object.hasOwn(unsigned, 'stepUp')) throw new VaultUiError('invalid_input');
    } catch {
      throw new VaultUiError('invalid_input');
    }
    const challenge = await call('vault.webauthn.challenge', { body: {
      ...mutation(), purpose: 'step_up', action, pathParams: params, body: unsigned,
    } });
    if (challenge.purpose !== 'step_up' || challenge.action !== action || challenge.intentHash === null) {
      throw new VaultUiError('invalid_response');
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) throw new VaultUiError('expired');
    const assertion = await ceremony(() => authenticator.get(challenge.publicKey));
    if (Date.parse(challenge.expiresAt) <= Date.now()) throw new VaultUiError('expired');
    return call(action, { params, body: {
      ...unsigned, stepUp: { challengeId: challenge.challengeId, assertion },
    } });
  };
}

type CaptureFields = Omit<VaultInput<'vault.captureLinks.create'>, 'clientMutationId'>;
type GrantFields = Omit<VaultStepUpBody<'vault.grants.create'>, 'clientMutationId'>;
export type PasskeyAuthorization =
  | { kind: 'enrollment'; code: string }
  | { kind: 'recovery'; code: string }
  | { kind: 'passkey' };

export function createVaultPort(transport: VaultTransport, options: { authenticator?: VaultAuthenticator } = {}) {
  const authenticator = options.authenticator ?? browserVaultAuthenticator;
  const call: VaultValidatedCall = async (op, opts) => {
    try {
      const input = VAULT_INPUT_SCHEMAS[op].safeParse(opts?.body ?? opts?.query ?? {});
      if (!input.success) throw new VaultUiError('invalid_input');
      const output = await transport.call<unknown>(op, opts);
      const parsed = VAULT_OUTPUT_SCHEMAS[op].safeParse(output);
      if (!parsed.success) throw new VaultUiError('invalid_response');
      return parsed.data as VaultOutput<typeof op>;
    } catch (error) {
      throw vaultError(error);
    }
  };
  const requestStepUp = createStepUpRequester(call, authenticator);
  return {
    status: () => call('vault.status'),
    itemsList: (query: VaultInput<'vault.items.list'> = {}) => call('vault.items.list', { query }),
    itemGet: (itemId: string) => call('vault.items.get', { params: { itemId } }),
    itemActivity: (itemId: string) => call('vault.items.activity', { params: { itemId }, query: { days: 7 } }),
    captureLinkCreate: (fields: CaptureFields) => call('vault.captureLinks.create', { body: { ...mutation(), ...fields } }),
    approvalsList: (query: VaultInput<'vault.approvals.list'> = {}) => call('vault.approvals.list', { query }),
    approvalGet: (approvalId: string) => call('vault.approvals.get', { params: { approvalId } }),
    approvalDecide: (approvalId: string, approvalIntentHash: string, decision: 'approve' | 'deny', standing = false) => {
      const body = { ...mutation(), approvalIntentHash, decision, standing };
      return decision === 'approve'
        ? requestStepUp('vault.approvals.decide', { approvalId }, body)
        : call('vault.approvals.decide', { params: { approvalId }, body });
    },
    async signIn() {
      const challenge = await call('vault.webauthn.challenge', { body: { ...mutation(), purpose: 'sign_in' } });
      if (challenge.purpose !== 'sign_in' || challenge.action !== null || challenge.intentHash !== null) {
        throw new VaultUiError('invalid_response');
      }
      if (Date.parse(challenge.expiresAt) <= Date.now()) throw new VaultUiError('expired');
      const assertion = await ceremony(() => authenticator.get(challenge.publicKey));
      if (Date.parse(challenge.expiresAt) <= Date.now()) throw new VaultUiError('expired');
      return call('vault.session.begin', { body: { ...mutation(), challengeId: challenge.challengeId, assertion } });
    },
    sessionRefresh: () => call('vault.session.refresh', { body: mutation() }),
    sessionEnd: () => call('vault.session.end', { body: mutation() }),
    passkeysList: () => call('vault.passkeys.list'),
    async passkeyRegister(name: string, authorization: PasskeyAuthorization) {
      const body = { ...mutation(), name };
      const registration = authorization.kind === 'passkey'
        ? await requestStepUp('vault.passkeys.registerBegin', {}, body)
        : await call('vault.passkeys.registerBegin', { body: {
          ...body, ...(authorization.kind === 'enrollment'
            ? { enrollmentCode: authorization.code } : { recoveryCode: authorization.code }),
        } });
      if (Date.parse(registration.expiresAt) <= Date.now()) throw new VaultUiError('expired');
      const credential = await ceremony(() => authenticator.create(registration.publicKey));
      if (Date.parse(registration.expiresAt) <= Date.now()) throw new VaultUiError('expired');
      return call('vault.passkeys.registerFinish', {
        params: { registrationId: registration.registrationId }, body: { ...mutation(), credential },
      });
    },
    passkeyRevoke: (passkeyId: string, confirmLast = false) => call('vault.passkeys.revoke', {
      params: { passkeyId }, body: { ...mutation(), confirmLast },
    }),
    recoveryCodesCreate: () => requestStepUp('vault.recovery.codes.create', {}, mutation()),
    grantsList: (itemId: string) => call('vault.grants.list', { params: { itemId } }),
    grantCreate: (itemId: string, fields: GrantFields) => requestStepUp('vault.grants.create', { itemId }, {
      ...mutation(), ...fields,
    }),
    grantRevoke: (grantId: string) => call('vault.grants.revoke', { params: { grantId }, body: mutation() }),
    sessionsList: () => call('vault.sessions.list'),
    sessionRevoke: (sessionId: string) => call('vault.sessions.revoke', { params: { sessionId }, body: mutation() }),
    auditList: (query: VaultInput<'vault.audit.list'> = {}) => call('vault.audit.list', { query }),
    auditVerify: () => call('vault.audit.verify'),
    operationGet: (operationId: string) => call('vault.operations.get', { params: { operationId } }),
  };
}

export type VaultPort = ReturnType<typeof createVaultPort>;
