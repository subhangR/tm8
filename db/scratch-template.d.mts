export function migrationChainDigest(): string;
export function ensureMigratedTemplate(adminUrl: string, env?: NodeJS.ProcessEnv): Promise<string>;
export function createFromMigratedTemplate(adminUrl: string, name: string, env?: NodeJS.ProcessEnv): Promise<string>;
