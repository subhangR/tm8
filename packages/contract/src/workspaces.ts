import { z } from 'zod';

export const WorkspaceIdSchema = z.string().uuid();
export const MachineIdSchema = z.string().uuid();
export const WorkspaceStateSchema = z.enum(['pending', 'provisioning', 'ready', 'failed', 'suspended']);
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export const WorkspaceLimitsSchema = z.object({
  cpus: z.number().positive().max(64).default(2),
  memoryMiB: z.number().int().min(256).max(262144).default(4096),
  pids: z.number().int().min(32).max(4096).default(256),
}).strict();
export type WorkspaceLimits = z.infer<typeof WorkspaceLimitsSchema>;

export interface UserWorkspace {
  id: string;
  accountId: string;
  machineId: string;
  state: WorkspaceState;
  operationId: string;
  homePath: string;
  limits: WorkspaceLimits;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MachineRegistrationSchema = z.object({
  machineId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  publicOrigin: z.string().url(),
  provider: z.enum(['local', 'aws', 'azure', 'utho', 'other']).default('local'),
  capacity: z.number().int().min(1).max(10000).default(10),
}).strict();
export type MachineRegistration = z.infer<typeof MachineRegistrationSchema>;
export interface WorkspaceMachine extends MachineRegistration {
  id: string;
  state: 'enrolling' | 'ready' | 'draining' | 'offline';
  allocated: number;
  lastHeartbeatAt: string | null;
}

export const WorkspaceProjectCreateSchema = z.object({
  spaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('init') }).strict(),
    z.object({ kind: z.literal('clone'), url: z.string().url().max(2048) }).strict(),
    z.object({ kind: z.literal('import'), relativePath: z.string().min(1).max(1024) }).strict(),
  ]),
  clientMutationId: z.string().min(1).max(200),
}).strict();
export type WorkspaceProjectCreate = z.infer<typeof WorkspaceProjectCreateSchema>;

export const WorkspaceGitInputSchema = z.object({
  projectId: z.string().uuid(),
  action: z.enum(['status', 'fetch', 'pull', 'push']),
  remote: z.enum(['tm8', 'origin']).default('tm8'),
  branch: z.string().min(1).max(200).optional(),
}).strict();
export type WorkspaceGitInput = z.infer<typeof WorkspaceGitInputSchema>;
export const WorkspaceEmptyInputSchema = z.object({}).strict();
export const WorkspaceFileWriteSchema = z.object({ path: z.string().max(1024), content: z.string().max(6 * 1024 * 1024) }).strict();
export const WorkspaceCommitSchema = z.object({ message: z.string().trim().min(1).max(4096) }).strict();
export const WorkspaceConnectSchema = z.object({ url: z.string().url().max(2048) }).strict();
export const WorkspaceTerminalSchema = z.object({ projectId: z.string().uuid().optional(), command: z.string().max(32768).optional() }).strict();
export const WorkspaceGithubCredentialSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_]{20,256}$/).nullable().optional() }).strict();
export const WorkspaceGithubCreateSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), private: z.boolean().default(true) }).strict();
export const WorkspaceInvitationSchema = z.object({ spaceId: z.string().uuid(), email: z.string().email().max(320), role: z.enum(['admin', 'member']).default('member'), clientMutationId: z.string().min(1).max(200) }).strict();
export const AuthHandoffSchema = z.object({ code: z.string().min(32).max(128) }).strict();
export const AuthGithubStartSchema = z.object({ intent: z.enum(['login', 'link']).default('login'), invitationCode: z.string().min(1).max(256).optional(), claimToken: z.string().regex(/^tm8c_[A-Za-z0-9_-]{43}$/).optional() }).strict()
  .refine(value => !value.claimToken || (!value.invitationCode && value.intent === 'login'), 'Use either an invitation or an initial setup token');

/** Credentials and absolute host paths never cross the public interface. */
export interface WorkspaceOperation {
  id: string;
  workspaceId: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  failureCode: string | null;
  resourceId: string | null;
}

export interface DeploymentCapabilities {
  distributedSystemFlag: boolean;
  role: 'standalone' | 'node' | 'control';
  authentication: 'local' | 'supabase';
  signInProviders: readonly ['github'];
  registration: 'invite-only';
  crossMachineSharing: false;
  automaticMachineProvisioning: false;
  maxUsersPerMachine: number;
}
