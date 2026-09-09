import { WorkspaceLimitsSchema, type DeploymentCapabilities, type WorkspaceLimits } from '@tm8/contract';

export interface WorkspaceConfiguration {
  isolation: boolean;
  capabilities: DeploymentCapabilities;
  machineId?: string;
  controlOrigin?: string;
  brokerSocket: string;
  limits: WorkspaceLimits;
  machineCredential?: string;
  enrollmentDatabaseUrl?: string;
  github?: { clientId: string; clientSecret: string; origin: string };
}

export function publicOrigin(value: string, allowLoopback = false): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowLoopback && local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Public origins must be bare HTTPS origins (HTTP is allowed only for local development)');
  }
  return url.origin;
}

export function loadWorkspaceConfiguration(env: NodeJS.ProcessEnv = process.env): WorkspaceConfiguration {
  const flag = env.TM8_DISTRIBUTED_SYSTEM_FLAG ?? 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('TM8_DISTRIBUTED_SYSTEM_FLAG must be true or false');
  const distributedSystemFlag = flag === 'true';
  const isolationFlag = env.TM8_WORKSPACE_ISOLATION ?? 'true';
  if (!['true', 'false'].includes(isolationFlag)) throw new Error('TM8_WORKSPACE_ISOLATION must be true or false');
  const isolation = isolationFlag === 'true';
  if (distributedSystemFlag && !isolation) throw new Error('Distributed nodes require workspace isolation');
  const role = env.TM8_SERVICE_ROLE ?? (distributedSystemFlag ? 'node' : 'standalone');
  if (!['standalone', 'node', 'control'].includes(role) || (distributedSystemFlag === (role === 'standalone'))) {
    throw new Error('Standalone role requires distributed mode off; node/control roles require it on');
  }
  const maxUsersPerMachine = Number(env.TM8_MAX_USERS_PER_MACHINE ?? 10);
  if (!Number.isSafeInteger(maxUsersPerMachine) || maxUsersPerMachine < 1 || maxUsersPerMachine > 10000) {
    throw new Error('TM8_MAX_USERS_PER_MACHINE must be an integer from 1 to 10000');
  }
  const machineId = env.TM8_MACHINE_ID;
  if (machineId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(machineId)) {
    throw new Error('TM8_MACHINE_ID must be a UUID');
  }
  const controlOrigin = env.TM8_CONTROL_ORIGIN
    ? publicOrigin(env.TM8_CONTROL_ORIGIN, env.TM8_ENV !== 'prod') : undefined;
  if (role === 'node' && (!machineId || !controlOrigin)) {
    throw new Error('Distributed nodes require TM8_MACHINE_ID and TM8_CONTROL_ORIGIN');
  }
  const brokerSocket = env.TM8_WORKSPACE_BROKER_SOCKET ?? '/run/tm8/workspace-broker.sock';
  if (!brokerSocket.startsWith('/') || brokerSocket.includes('\0')) throw new Error('Broker socket must be an absolute path');
  let github: WorkspaceConfiguration['github'];
  if (!distributedSystemFlag && (env.TM8_GITHUB_CLIENT_ID || env.TM8_GITHUB_CLIENT_SECRET)) {
    if (!env.TM8_GITHUB_CLIENT_ID || !env.TM8_GITHUB_CLIENT_SECRET || !env.TM8_PUBLIC_ORIGIN || !env.TM8_NODE_CONTROL_DATABASE_URL) {
      throw new Error('Standalone GitHub sign-in requires client ID, client secret, public origin and enrollment database URL');
    }
    github = { clientId: env.TM8_GITHUB_CLIENT_ID, clientSecret: env.TM8_GITHUB_CLIENT_SECRET,
      origin: publicOrigin(env.TM8_PUBLIC_ORIGIN, env.TM8_ENV !== 'prod') };
  }
  return {
    isolation,
    capabilities: {
      distributedSystemFlag, role: role as DeploymentCapabilities['role'],
      authentication: distributedSystemFlag ? 'supabase' : 'local',
      signInProviders: ['github'], registration: 'invite-only', crossMachineSharing: false,
      automaticMachineProvisioning: false, maxUsersPerMachine,
    },
    machineId, controlOrigin, brokerSocket,
    machineCredential: env.TM8_MACHINE_CREDENTIAL,
    enrollmentDatabaseUrl: env.TM8_NODE_CONTROL_DATABASE_URL,
    github,
    limits: WorkspaceLimitsSchema.parse({
      cpus: Number(env.TM8_WORKSPACE_CPUS ?? 2),
      memoryMiB: Number(env.TM8_WORKSPACE_MEMORY_MIB ?? 4096),
      pids: Number(env.TM8_WORKSPACE_PIDS ?? 256),
    }),
  };
}
