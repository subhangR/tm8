import type {
  CredentialProviderName, EdgeView, EntityCapabilities, EntityDetail, EntityId,
  EntitySummary, ExecutionSpawnCredential, LaunchAccessMode, ProjectResource,
  SessionConnectorAccounts, SessionLaunchRecord, SpaceCredentialView,
} from '@tm8/contract';
import type { ConnectionOpts, Seam } from '../data/seam';

export interface AccessReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retryDelayMs?: number;
}

class AccessReadError extends Error {
  constructor(readonly code: 'access_timeout' | 'access_cancelled') { super(code); }
}

function abortError(): AccessReadError { return new AccessReadError('access_cancelled'); }

function deadline<T>(read: () => Promise<T>, options: AccessReadOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => {
      cleanup(); reject(new AccessReadError('access_timeout'));
    }, options.timeoutMs ?? 10_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(read).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function retryable(error: unknown): boolean {
  const failure = error as { code?: string; status?: number; retryable?: boolean } | null;
  if (failure?.code === 'access_cancelled') return false;
  if (failure?.status && [400, 401, 403, 404, 409, 413, 422, 501].includes(failure.status)) return false;
  if (failure?.code && ['forbidden', 'not_found', 'invalid_input', 'invalid_cursor', 'unauthenticated', 'unauthorized', 'version_conflict', 'conflict', 'invariant_violation', 'payload_too_large', 'not_implemented', 'not_community_admin'].includes(failure.code)) return false;
  if (failure?.retryable === false) return false;
  return failure?.retryable === true || !failure?.code || ['access_timeout', 'timeout', 'network_error', 'rate_limited', 'limit_exceeded', 'upstream_unavailable', 'internal', 'unavailable', 'service_unavailable'].includes(failure.code);
}

/** All reads are idempotent; one bounded retry, and no retry of an authority refusal. */
export async function readAccess<T>(read: () => Promise<T>, options: AccessReadOptions = {}): Promise<T> {
  try { return await deadline(read, options); }
  catch (error) {
    if (!retryable(error) || options.signal?.aborted) throw error;
    await new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) { reject(abortError()); return; }
      const abort = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort); resolve();
      }, options.retryDelayMs ?? 300);
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    return deadline(read, options);
  }
}

async function allConnections(seam: Seam, id: EntityId, opts: ConnectionOpts, options: AccessReadOptions) {
  const items: EdgeView[] = [];
  const seen = new Set<string>();
  let cursor: ConnectionOpts['cursor'];
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    try {
      const page = await readAccess(() => seam.connections(id, { ...opts, limit: 50, ...(cursor ? { cursor } : {}) }), options);
      items.push(...page.items);
      if (!page.nextCursor) return { items, incomplete: false };
      if (seen.has(page.nextCursor)) return { items, incomplete: true };
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { items, incomplete: true };
    }
  }
  return { items, incomplete: true };
}

async function mapLimited<T, R>(items: readonly T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  }));
  return results;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }

/** Account labels are useful without exposing a full email address. */
export function maskAccessLabel(value: string): string {
  return value.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}/gi,
    (email) => `${email.slice(0, 1)}***@${email.slice(email.indexOf('@') + 1)}`);
}

/** Never carry repository userinfo, query credentials or fragments into the view model. */
export function repositoryLabel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch {
    const scp = /^[^@\s]+@([a-z0-9.-]+):([^\s?#]+)$/i.exec(raw);
    return scp ? `git@${scp[1]}:${scp[2]}` : null;
  }
}

const PROVIDERS: Record<CredentialProviderName, true> = {
  anthropic: true, openai: true, github: true, gemini: true, hermes: true, cursor: true, kimi: true, groq: true,
};
const MODES = new Set<LaunchAccessMode>(['safe', 'acceptEdits', 'auto', 'plan', 'fullAccess']);
const SOURCES = new Set(['requested', 'env', 'inherited', 'persona', 'default', 'dispatcher']);
const PERMISSIONS = new Set(['auto', 'acceptEdits', 'interactive', 'readOnly', 'bypassPermissions']);

export interface AccessProject {
  id: string;
  title: string;
  repoUrl: string | null;
  workingDir: string | null;
}
export interface AccessCredential {
  provider: string;
  source: 'space' | 'member' | 'node';
  credential: Pick<SpaceCredentialView, 'id' | 'label' | 'displayLogin' | 'status'> | null;
  pinned: boolean;
}
export interface AccessRun {
  session: Pick<EntitySummary, 'id' | 'title'>;
  available: boolean;
  failed: boolean;
  recordedAt: string | null;
  workingDirectory: string | null;
  workdirMode: string | null;
  project: AccessProject | null;
  projectRecorded: boolean;
  accessMode: LaunchAccessMode | null;
  accessModeSource: string | null;
  permissionMode: string | null;
  network: string | null;
  sandboxDegraded: boolean;
  credentials: AccessCredential[];
  connectorAccounts: SessionConnectorAccounts | undefined;
}
export interface TaskAccessSnapshot {
  taskId: EntityId;
  checkedAt: string;
  capabilities: EntityCapabilities;
  projects: AccessProject[];
  runs: AccessRun[];
  issues: string[];
}

function effectiveCredentials(record: SessionLaunchRecord): ExecutionSpawnCredential[] {
  if (record.launch) return record.launch.credentials.filter((row) => Object.hasOwn(PROVIDERS, row.provider));
  const launch = object(record.manifest?.launch);
  // credentialSources is the REQUEST, and may still say auto. Only effective facts count.
  const effective = object(launch.effectiveCredentialSources);
  const ids = object(launch.spaceCredentialIds);
  return Object.keys(PROVIDERS).flatMap((provider) => {
    const source = effective[provider];
    if (source !== 'space' && source !== 'member' && source !== 'node') return [];
    const id = source === 'space' ? text(ids[provider]) : null;
    return [{ provider: provider as CredentialProviderName, source, ...(id ? { spaceCredentialId: id as EntityId } : {}) }];
  });
}

function projectOf(resource: ProjectResource): AccessProject {
  return { id: resource.projectEntityId ?? resource.id, title: resource.name,
    repoUrl: repositoryLabel(resource.repoUrl ?? null), workingDir: resource.workingDir ?? null };
}

function connectorAccountsOf(accounts: SessionConnectorAccounts | undefined): SessionConnectorAccounts | undefined {
  if (!accounts) return undefined;
  return {
    available: accounts.available, unavailableReason: accounts.unavailableReason, hiddenCount: accounts.hiddenCount,
    entries: accounts.entries.map((entry) => ({
      serverId: entry.serverId, serverName: maskAccessLabel(entry.serverName), credentialRequired: entry.credentialRequired,
      account: entry.account ? {
        id: entry.account.id, label: maskAccessLabel(entry.account.label),
        accountLabel: entry.account.accountLabel ? maskAccessLabel(entry.account.accountLabel) : null,
        grantedScopes: entry.account.grantedScopes.map(maskAccessLabel), usable: entry.account.usable,
        status: entry.account.status, reason: entry.account.reason,
      } : null,
    })),
  };
}

function networkOf(value: unknown): string | null {
  const network = object(value);
  switch (network.mode) {
    case 'full-access': return 'Full network access';
    case 'provider-default': return 'Provider default; network reachability not measured';
    case 'operator-defined': return 'Operator defined; network reachability not measured';
    case 'loopback-proxy': {
      const hosts = Array.isArray(network.allowedHosts)
        ? network.allowedHosts.filter((host): host is string => typeof host === 'string' && /^[a-z0-9.:[\]-]+$/i.test(host)).slice(0, 32)
        : [];
      return `Loopback proxy${hosts.length ? ` · ${hosts.join(', ')}` : ''}${network.portScoped === false ? ' · all ports on allowed hosts' : ''}`;
    }
    default: return null;
  }
}

function runOf(session: EntitySummary, record: SessionLaunchRecord | null, projects: Map<string, AccessProject>, credentials: Map<string, SpaceCredentialView>): AccessRun {
  const manifest = object(record?.manifest);
  const launch = object(manifest.launch);
  const directory = object(manifest.session);
  const project = object(manifest.project);
  const mode = record?.launch?.accessMode ?? launch.accessMode;
  const source = record?.launch?.accessModeSource ?? launch.accessModeSource;
  return {
    session: { id: session.id, title: session.title },
    available: record?.available ?? false, failed: record === null, recordedAt: record?.recordedAt ?? null,
    workingDirectory: text(directory.workingDirectory),
    workdirMode: ['project', 'scratch', 'worktree'].includes(String(directory.workdirMode)) ? String(directory.workdirMode) : null,
    project: projects.get(String(project.id)) ?? null, projectRecorded: Boolean(text(project.id)),
    accessMode: MODES.has(mode as LaunchAccessMode) ? mode as LaunchAccessMode : null,
    accessModeSource: SOURCES.has(String(source)) ? String(source) : null,
    permissionMode: PERMISSIONS.has(String(launch.permissionMode)) ? String(launch.permissionMode) : null,
    network: networkOf(launch.commandNetwork), sandboxDegraded: Boolean(launch.sandboxDegraded),
    credentials: record ? effectiveCredentials(record).map((row) => {
      const metadata = row.spaceCredentialId ? credentials.get(row.spaceCredentialId) : undefined;
      return { provider: row.provider, source: row.source, pinned: Boolean(row.spaceCredentialId),
        credential: metadata ? { id: metadata.id, label: maskAccessLabel(metadata.label),
          displayLogin: metadata.displayLogin ? maskAccessLabel(metadata.displayLogin) : null, status: metadata.status } : null };
    }) : [],
    connectorAccounts: connectorAccountsOf(record?.connectorAccounts),
  };
}

/** Read only under existing seam gates. No access is inferred from a task's relationships. */
export async function loadTaskAccess(seam: Seam, taskId: EntityId, options: AccessReadOptions = {}): Promise<TaskAccessSnapshot> {
  // Refresh capabilities too. A failed task authority read clears the entire surface.
  const task: EntityDetail = await readAccess(() => seam.entity(taskId), options);
  if (task.kind !== 'task' || task.deletedAt) throw new Error('Task access unavailable');
  const [projectLinks, runLinks] = await Promise.all([
    allConnections(seam, taskId, { types: ['in_project'], direction: 'outgoing' }, options),
    allConnections(seam, taskId, { types: ['working_on'], direction: 'incoming' }, options),
  ]);
  const unique = (rows: EntitySummary[]) => [...new Map(rows.map((row) => [row.id, row])).values()];
  const linkedProjects = unique(projectLinks.items.filter((edge) => edge.source.id === taskId && edge.target.kind === 'project').map((edge) => edge.target));
  const sessions = unique(runLinks.items.filter((edge) => edge.target.id === taskId && edge.source.kind === 'work_session').map((edge) => edge.source));
  const launches = await mapLimited(sessions, async (session) => {
    try { return await readAccess(() => seam.launch(session.id), options); }
    catch (error) { if (options.signal?.aborted) throw error; return null; }
  });
  const needsCredentials = launches.some((record) => record && effectiveCredentials(record).some((row) => row.spaceCredentialId));
  const needsProjects = linkedProjects.length > 0 || launches.some((record) => text(object(record?.manifest?.project).id));
  const [projectRead, credentialRead] = await Promise.allSettled([
    needsProjects ? readAccess(() => seam.projects(task.spaceId), options) : Promise.resolve([] as ProjectResource[]),
    needsCredentials ? readAccess(() => seam.credentials.space.list(task.spaceId), options) : Promise.resolve({ credentials: [] as SpaceCredentialView[] }),
  ]);
  if (options.signal?.aborted) throw abortError();
  const resources = projectRead.status === 'fulfilled' ? projectRead.value : [];
  const projectsById = new Map<string, AccessProject>();
  for (const resource of resources) {
    const project = projectOf(resource);
    projectsById.set(resource.id, project);
    if (resource.projectEntityId) projectsById.set(resource.projectEntityId, project);
  }
  const credentialRows = credentialRead.status === 'fulfilled' ? credentialRead.value.credentials : [];
  const credentials = new Map(credentialRows.map((row) => [row.id, row]));
  const issues = [
    ...(projectLinks.incomplete ? ['Project links are incomplete.'] : []),
    ...(runLinks.incomplete ? ['Run links are incomplete.'] : []),
    ...(projectRead.status === 'rejected' ? ['Current project metadata is unavailable.'] : []),
    ...(credentialRead.status === 'rejected' ? ['Current provider credential metadata is unavailable.'] : []),
    ...(launches.some((record) => record === null) ? ['Some launch records could not be read.'] : []),
    ...(launches.some((record) => record?.connectorAccounts?.unavailableReason === 'read_failed') ? ['Some connector account metadata could not be read.'] : []),
  ];
  return {
    taskId, checkedAt: new Date().toISOString(), capabilities: task.capabilities,
    projects: linkedProjects.map((peer) => projectsById.get(peer.id) ??
      (peer.state.kind === 'project' ? projectsById.get(peer.state.projectId) : undefined) ??
      { id: peer.id, title: peer.title, repoUrl: null, workingDir: null }),
    runs: sessions.map((session, index) => runOf(session, launches[index] ?? null, projectsById, credentials)),
    issues,
  };
}
