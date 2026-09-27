import type { ActionRows, CredentialsLoginSessionStartResult, CredentialProviderName } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { ManagedSource } from '../domain';

/**
 * THE MANAGED PANEL'S PORT (task 01a0e24d).
 *
 * Keyed by OPERATION name and by seam NOUN, never by entity kind, so the body
 * that consumes it stays free of the kind literals §15.2 fails the build on.
 * Every read here is one the server already masks: a credential's key hint and
 * vendor login come back only through `list_space_credentials`, masked by the
 * credential's own visibility rule (private: owner only). This port adds no
 * read of its own and never asks for a secret.
 */
export type ManagedRecord = object;

export interface ManagedTarget {
  id: string;
  spaceId: string;
}

export interface ManagedPort {
  /** `actions.list` on the entity: the only source of which verbs are live. */
  actions(entityId: string): Promise<ActionRows>;
  /** Who is looking: decides the owner WORD, never what is allowed. */
  me(): Promise<{ accountId: string | null }>;
  /** The record, or null when the caller cannot see it (the read said nothing). */
  read(source: ManagedSource, target: ManagedTarget): Promise<ManagedRecord | null>;
  /** Whether this build has a call for `operation`. An operation it lacks renders refused, never inert. */
  has(operation: string): boolean;
  /** Runs a verb or a read by operation name. `arg` is the verb's one input (a label, a flipped value). */
  run(operation: string, target: ManagedTarget, arg?: string | boolean): Promise<unknown>;
  /** Re-login to an existing credential in a terminal (206), hosted inline by the panel. */
  startLogin(target: ManagedTarget, provider: string): Promise<CredentialsLoginSessionStartResult>;
  finishLogin(workSessionId: string): Promise<unknown>;
}

type ManagedSeam = Pick<Seam, 'actions' | 'identity' | 'credentials' | 'spaceLinks' | 'servers'>;
type Run = (seam: ManagedSeam, target: ManagedTarget, arg?: string | boolean) => Promise<unknown>;

/** Operation → seam call. The operation names are the catalog's; the table is the whole mapping. */
const RUNS: Readonly<Record<string, Run>> = {
  'credentials.space.rename': (s, t, a) => s.credentials.space.rename(t.id, String(a ?? '')),
  'credentials.space.setDefault': (s, t) => s.credentials.space.setDefault(t.id),
  'credentials.space.setVisibility': (s, t, a) => s.credentials.space.setVisibility(t.id, a === 'private' ? 'private' : 'public'),
  'credentials.space.spaceDefaultConsent': (s, t, a) => s.credentials.space.spaceDefaultConsent(t.id, a === true),
  'credentials.space.claim': (s, t) => s.credentials.space.claim(t.id),
  'credentials.space.myDefault.set': (s, t) => s.credentials.space.setMyDefault(t.id),
  'credentials.space.delete': (s, t) => s.credentials.space.remove(t.id),
  'credentials.space.usage': (s, t) => s.credentials.space.usage(t.id),
  'spaceLinks.login': (s, t) => s.spaceLinks.login(t.id),
  'spaceLinks.relogin': (s, t) => s.spaceLinks.relogin(t.id),
  'spaceLinks.logout': (s, t) => s.spaceLinks.logout(t.id),
  'spaceLinks.remove': (s, t) => s.spaceLinks.remove(t.id),
  'spaceLinks.setSpawn': (s, t, a) => s.spaceLinks.setSpawn(t.id, a === true),
  'spaceLinks.audit': (s, t) => s.spaceLinks.audit(t.id),
  'servers.probe': (s, t) => s.servers.probe(t.id),
  'servers.remove': (s, t) => s.servers.remove(t.id),
};

/** Operations this port serves through a dedicated call rather than `run` (the inline login terminal). */
const DEDICATED: ReadonlySet<string> = new Set(['credentials.loginSessions.start']);

const READS: Readonly<Record<ManagedSource, (seam: ManagedSeam, target: ManagedTarget) => Promise<ManagedRecord | null>>> = {
  spaceCredentials: async (s, t) =>
    (await s.credentials.space.list(t.spaceId)).credentials.find((c) => c.id === t.id) ?? null,
  spaceLinks: async (s, t) => (await s.spaceLinks.list(t.spaceId)).find((l) => l.id === t.id) ?? null,
  servers: async (s, t) => s.servers.get(t.id),
};

export function managedPortFromSeam(seam: ManagedSeam): ManagedPort {
  return {
    actions: (entityId) => seam.actions.list(entityId),
    me: async () => ({ accountId: (await seam.identity()).accountId ?? null }),
    read: (source, target) => READS[source](seam, target),
    has: (operation) => Object.hasOwn(RUNS, operation) || DEDICATED.has(operation),
    run: (operation, target, arg) => {
      const call = RUNS[operation];
      if (!call) return Promise.reject(new Error(`${operation} is not wired in this build`));
      return call(seam, target, arg);
    },
    startLogin: (target, provider) =>
      seam.credentials.startLogin(target.spaceId, provider as CredentialProviderName, { credentialId: target.id }),
    finishLogin: (workSessionId) => seam.credentials.finishLogin(workSessionId),
  };
}
