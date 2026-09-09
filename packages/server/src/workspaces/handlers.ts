import { CollabError, WorkspaceProjectCreateSchema, WorkspaceGitInputSchema, type OperationName,
  WorkspaceFileWriteSchema, WorkspaceCommitSchema, WorkspaceConnectSchema, WorkspaceTerminalSchema,
  WorkspaceGithubCredentialSchema, WorkspaceGithubCreateSchema, WorkspaceInvitationSchema, AuthHandoffSchema } from '@tm8/contract';
import { z } from 'zod';
import type { HandlerRegistry } from '../facade/registry.js';
import { requireUuidParam } from '../facade/context.js';
import { json } from '../http/types.js';
import { sessionCookie } from '../http/session-cookie.js';
import type { NodeControlClient } from './control-client.js';
import type { WorkspaceService } from './service.js';
import type { LocalGithubAuth } from './github-auth.js';
import { registerWorkspaceCredentials, WORKSPACE_CREDENTIAL_OPERATIONS } from './credentials.js';
import { WORKSPACE_EXECUTION_OPERATIONS } from './execution.js';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CollabError('invalid_input', result.error.issues[0]?.message ?? 'Invalid workspace input');
  return result.data;
}
export function registerWorkspaceHandlers(registry: HandlerRegistry, service: WorkspaceService, control?: NodeControlClient, github?: LocalGithubAuth): void {
  if (service.config.isolation) {
    registerWorkspaceCredentials(registry, service);
    service.execution.register(registry);
  }
  if (control) registry.decorate('auth.logout', handler => async ctx => {
    const { sessionId } = parse(z.object({ sessionId: z.string().uuid().optional() }).strict(), ctx.body ?? {});
    const id = sessionId ?? ctx.identity.sessionId;
    if (!id) throw new CollabError('unauthenticated', 'Sign in required');
    await control.revoke(ctx.identity, id);
    return handler(ctx);
  });
  const requireGithub = () => {
    if (!github) throw new CollabError('conflict', 'GitHub sign-in is not configured on this node');
    return github;
  };
  registry.registerAll({
    'workspaces.invites.create': async ctx => {
      if (!control) throw new CollabError('conflict', 'Use space invitations on this standalone node');
      const input = parse(WorkspaceInvitationSchema, ctx.body);
      const invitation = await service.deps.db.rpc<{ id: string; space_id: string; email: string; expires_at: string }>(await service.claims(ctx), 'prepare_workspace_invitation', [input.spaceId, input.email, input.role, input.clientMutationId]);
      return control.invite(ctx.identity, invitation);
    },
    'workspaces.invites.list': async ctx => service.deps.db.query(await service.claims(ctx), 'select * from public.workspace_invitations order by expires_at desc limit 100'),
    'workspaces.invites.revoke': async ctx => {
      const id = requireUuidParam(ctx, 'invitationId');
      const result = await service.deps.db.rpc(await service.claims(ctx), 'revoke_workspace_invitation', [id]);
      await control?.revokeInvitation(id);
      return result;
    },
    'auth.github.start': ctx => requireGithub().start(ctx),
    'auth.github.callback': ctx => requireGithub().callback(ctx),
    'deployment.capabilities': () => ({ ...service.config.capabilities, workspaceIsolation: service.config.isolation, controlOrigin: service.config.controlOrigin ?? null, githubLogin: !!github }),
    'workspaces.me': ctx => service.me(ctx),
    'workspaces.ensure': async ctx => {
      const workspace = await service.ensure(ctx);
      if (control) await control.status(workspace.id, 'ready');
      return workspace;
    },
    'workspaces.projects.create': ctx => service.createProject(ctx, parse(WorkspaceProjectCreateSchema, ctx.body)),
    'workspaces.projects.checkout': async ctx => { await service.checkout(ctx, requireUuidParam(ctx, 'projectId')); return { ready: true }; },
    'workspaces.files.list': ctx => service.operation(ctx, requireUuidParam(ctx, 'projectId'), 'files-list', { path: ctx.query.get('path') ?? '' }),
    'workspaces.files.read': ctx => service.operation(ctx, requireUuidParam(ctx, 'projectId'), 'files-read', { path: ctx.query.get('path') ?? '' }),
    'workspaces.files.write': ctx => service.operation(ctx, requireUuidParam(ctx, 'projectId'), 'files-write', parse(WorkspaceFileWriteSchema, ctx.body)),
    'workspaces.git': ctx => {
      const input = parse(WorkspaceGitInputSchema, ctx.body);
      return service.operation(ctx, input.projectId, input.action === 'status' ? 'git-status' : 'git-sync', { verb: input.action, remote: input.remote, branch: input.branch });
    },
    'workspaces.git.commit': ctx => service.operation(ctx, requireUuidParam(ctx, 'projectId'), 'git-commit', parse(WorkspaceCommitSchema, ctx.body)),
    'workspaces.git.connect': ctx => service.operation(ctx, requireUuidParam(ctx, 'projectId'), 'git-connect', parse(WorkspaceConnectSchema, ctx.body)),
    'workspaces.github.credential': async ctx => {
      if (!['browser', 'cli'].includes(ctx.identity.authKind ?? '')) throw new CollabError('forbidden', 'Only a human session may manage GitHub credentials');
      const input = parse(WorkspaceGithubCredentialSchema, ctx.body);
      const workspace = await service.requireReady(ctx);
      return service.broker.request('/operation', { action: 'github-credential', token: input.token, workspaceId: workspace.id, accountId: workspace.accountId });
    },
    'workspaces.github.create': ctx => {
      if (!['browser', 'cli'].includes(ctx.identity.authKind ?? '')) throw new CollabError('forbidden', 'Only a human session may create GitHub repositories');
      return service.operation(ctx, requireUuidParam(ctx, 'projectId'), 'github-create', parse(WorkspaceGithubCreateSchema, ctx.body));
    },
    'workspaces.terminal.start': ctx => service.terminal(ctx, parse(WorkspaceTerminalSchema, ctx.body)),
    'auth.handoff': async ctx => {
      if (!control) throw new CollabError('invalid_input', 'This node uses local sign-in');
      const { code } = parse(AuthHandoffSchema, ctx.body);
      const session = await control.redeem(code);
      return json({ workspaceId: session.workspaceId }, { headers: { 'set-cookie': sessionCookie(session.token, session.expiresAt), 'cache-control': 'no-store' } });
    },
  });
}

/** Fail closed for the old host-path execution families during cutover. */
export function workspaceBoundary(op: OperationName, isolated: boolean, distributed: boolean): void {
  if (['auth.login', 'auth.signup', 'auth.claim', 'auth.password.change', 'auth.invite.signup'].includes(op)) {
    throw new CollabError('forbidden', 'Sign in or sign up with GitHub', { details: { reason: 'github_authentication_required' } });
  }
  if (!isolated) return;
  if (WORKSPACE_CREDENTIAL_OPERATIONS.includes(op)) return;
  if (WORKSPACE_EXECUTION_OPERATIONS.includes(op)) return;
  if (distributed && ['auth.login', 'auth.signup', 'auth.claim', 'auth.claim.reissue', 'auth.password.change', 'auth.invite.signup', 'spaces.invites.create'].includes(op)) {
    throw new CollabError('forbidden', 'Use central authentication for this node', { details: { reason: 'central_authentication_required' } });
  }
  if (op.startsWith('execution.') || op.startsWith('credentials.') || op.startsWith('containers.') ||
      op.startsWith('projects.files.') || op.startsWith('projects.folderUploads.') || op.startsWith('projects.file.') ||
      ['projects.create', 'projects.directories.list', 'projects.branches.list', 'chat.start'].includes(op)) {
    throw new CollabError('conflict', 'This operation requires a private workspace runner. Open your workspace to continue.', { details: { reason: 'workspace_migration_required' } });
  }
}
