import type { McpServerDefinition, McpTestResult } from '@tm8/contract';
/** UI-only values. Account metadata never contains provider credentials. */
export interface McpSelection { serverId: string; credentialId?: string }
export interface McpAccount {
  id: string; label: string; ownerId?: string; ownerLabel?: string; canUse: boolean; canManage: boolean;
  status: string; sharing: 'private' | 'members' | 'space'; memberIds?: string[];
}
export interface McpServer {
  id: string; version: number; title: string; description: string;
  transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[];
  auth: 'none' | 'api_key' | 'oauth'; approved: boolean; enabled: boolean;
  source?: McpServerDefinition; health?: McpTestResult; canApprove?: boolean;
  canManage: boolean; canAttach: boolean; unavailableReason?: string;
  accounts: McpAccount[];
}
export interface McpCatalog {
  attachedServerIds?: string[];
  servers: McpServer[]; defaults: McpSelection[]; canRegister: boolean; canAttach: boolean;
}
export interface McpDefinition {
  title: string; description: string; transport: 'http' | 'stdio';
  url?: string; command?: string; args?: string[]; auth: 'none' | 'api_key' | 'oauth';
  trustedCode?: boolean; approved?: boolean; allowPrivateNetwork?: boolean;
  secretSlot?: string; prefix?: 'Bearer' | 'none';
  issuer?: string; authorizationUrl?: string; tokenUrl?: string; clientId?: string; scopes?: string[];
}
export interface McpPort {
  catalog(targetId?: string, teamMemberId?: string): Promise<McpCatalog>;
  register(input: McpDefinition): Promise<void>;
  update(server: McpServer, input: McpDefinition & { enabled: boolean }): Promise<void>;
  remove(server: McpServer): Promise<void>;
  importConfig(json: string, trustedCode: boolean): Promise<void>;
  attach(targetId: string, serverId: string): Promise<void>;
  detach(targetId: string, serverId: string): Promise<void>;
  test(selection: McpSelection): Promise<{ ok: boolean; message: string; tools: { name: string; description?: string }[] }>;
  createKey(serverId: string, label: string, secret: string): Promise<void>;
  rotateKey(serverId: string, credentialId: string, secret: string): Promise<void>;
  startOAuth(serverId: string, label: string): Promise<{ authorizationUrl: string }>;
  share(serverId: string, credentialId: string, sharing: 'private' | 'members' | 'space', memberIds: string[]): Promise<void>;
  revoke(serverId: string, credentialId: string): Promise<void>;
  members(): Promise<{ id: string; label: string }[]>;
}
