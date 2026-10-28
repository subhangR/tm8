import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CollabError } from '@tm8/contract';
import { applyAgentCredentialEnv, harnessFailure, type AgentCredentialHome } from '@tm8/execution';
import {
  createChatCredentialResolver, type ChatCredentialBinding,
  type ChatCredentialResolverOptions, type ResolvedChatCredential,
} from './credentials.js';
import type { ChatLaunchConfigInput } from './runtime.js';

export interface ChatCredentialOwner {
  readonly chatId: string;
  readonly generation: number;
  readonly ownerLeaseId: string;
  readonly claimFence: string;
}

const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const sameOwner = (a: ChatCredentialOwner, b: ChatCredentialOwner) =>
  a.chatId === b.chatId && a.generation === b.generation
    && a.ownerLeaseId === b.ownerLeaseId && a.claimFence === b.claimFence;

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe launch directory');
  await chmod(path, 0o700);
}

/** A unique owned root: stale owners can never release a successor's files. */
export class ChatLaunchDirectory {
  private released = false;
  private constructor(
    readonly path: string, readonly id: string, readonly owner: ChatCredentialOwner,
    private readonly device: number, private readonly inode: number,
    private readonly anchor: FileHandle,
  ) {}

  static async create(dataDir: string, owner: ChatCredentialOwner): Promise<ChatLaunchDirectory> {
    if (!safeId.test(owner.chatId) || !Number.isSafeInteger(owner.generation) || owner.generation < 0
      || !owner.ownerLeaseId || !owner.claimFence) {
      throw new CollabError('invalid_input', 'Invalid chat launch owner');
    }
    const base = await realpath(dataDir);
    let path = base;
    for (const part of ['chat', 'launches', owner.chatId, String(owner.generation)]) {
      path = join(path, part);
      await privateDirectory(path);
    }
    const id = randomUUID();
    path = join(path, id);
    await mkdir(path, { mode: 0o700 });
    // Holding the original directory open prevents inode reuse after deletion.
    // A saved inode number alone can match an unrelated successor on Linux.
    const anchor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await anchor.stat();
      return new ChatLaunchDirectory(path, id, { ...owner }, info.dev, info.ino, anchor);
    } catch (error) { await anchor.close(); throw error; }
  }

  async write(name: string, value: string): Promise<string> {
    if (this.released || !/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name.includes('..') || name === '.') {
      throw new CollabError('invalid_input', 'Invalid private launch file');
    }
    await this.assertOwned();
    const path = join(this.path, name);
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
    return path;
  }

  private async assertOwned(): Promise<void> {
    const info = await lstat(this.path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.device || info.ino !== this.inode
      || await realpath(this.path) !== this.path) {
      throw new CollabError('invariant_violation', 'Chat launch resource ownership changed');
    }
  }

  async release(owner: ChatCredentialOwner = this.owner): Promise<void> {
    if (!sameOwner(owner, this.owner)) throw new CollabError('forbidden', 'Chat launch owner mismatch');
    if (this.released) return;
    try { await this.assertOwned(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.released = true; await this.anchor.close(); return;
      }
      if (error instanceof CollabError && error.code === 'invariant_violation') {
        this.released = true; await this.anchor.close();
      }
      throw error;
    }
    await rm(this.path, { recursive: true, force: true });
    this.released = true;
    await this.anchor.close();
  }
}

async function readAuthFile(configDir: string, name: string): Promise<string> {
  const info = await lstat(configDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
  const file = await open(join(configDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid credential file');
    const raw = await file.readFile('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid credential file');
    return raw;
  } finally { await file.close(); }
}

/**
 * A cause safe to log and store: the error's class and code, never its message,
 * which may quote credential material read from disk or a provider.
 */
export function redactedCause(error: unknown): Error {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = error instanceof CollabError ? error.code
    : typeof raw === 'string' ? raw : error instanceof Error ? error.name : typeof error;
  return Object.assign(new Error(code), { name: error instanceof Error ? error.name : 'NonError', code });
}

export interface PreparedChatCredential {
  readonly leaseId: string;
  readonly owner: ChatCredentialOwner;
  readonly binding: ChatCredentialBinding;
  readonly storageScopeId: string;
  readonly nativeStorageGeneration: number;
  /** Private generation resources. Never expose this material in a DTO. */
  materialize(): Promise<Readonly<{ env: Readonly<Record<string, string>>; modelConfigDir: string }>>;
  revalidate(): Promise<void>;
  /** Caller must confirm process exit before releasing a used lease. */
  release(owner?: ChatCredentialOwner): Promise<void>;
}

export interface ChatCredentialPreparationPort {
  preview(input: ChatLaunchConfigInput): Promise<ChatCredentialBinding>;
  prepare(input: ChatLaunchConfigInput, owner: ChatCredentialOwner): Promise<PreparedChatCredential>;
  revalidate(prepared: PreparedChatCredential): Promise<void>;
  release(prepared: PreparedChatCredential, owner?: ChatCredentialOwner): Promise<void>;
}

function pinnedInput(input: ChatLaunchConfigInput, selected: ResolvedChatCredential): ChatLaunchConfigInput {
  const binding = selected.binding;
  return { ...input, credentialValidationOnly: true, credentialSelection: binding.credentialId
    ? { source: 'space', credentialId: binding.credentialId }
    : { source: binding.source } };
}

export function createChatCredentialPreparation(options: ChatCredentialResolverOptions & {
  /** Trusted override for node OAuth snapshot tests/deployments, never client input. */
  nodeCredentialHome?: string;
  /** Trusted test override for the Keychain fallback; defaults to process.platform. */
  platform?: NodeJS.Platform;
}): ChatCredentialPreparationPort {
  const platform = options.platform ?? process.platform;
  const resolve = createChatCredentialResolver(options);
  const live = new WeakSet<PreparedChatCredential>();
  return {
    preview: async input => (await resolve({ ...input, credentialValidationOnly: true })).binding,
    async prepare(input, owner) {
      if (owner.chatId !== input.chatId) throw new CollabError('forbidden', 'Chat launch scope mismatch');
      const selected = await resolve({ ...input, credentialValidationOnly: true });
      const directory = await ChatLaunchDirectory.create(options.dataDir, owner);
      let released = false;
      let sharedConfigDir: string | null = null;
      let stage: 'write' | 'snapshot' | 'revalidate' = 'write';
      try {
        // Reuse vendor filenames only, never history/settings/plugins from an account home.
        const provider = selected.binding.route.nativeProvider;
        const home = selected.credentialHome;
        const key = home?.space?.apiKey ?? home?.apiKey
          ?? (selected.binding.source === 'node'
            ? selected.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'] : undefined);
        if (key) {
          if (provider === 'openai') {
            await directory.write('auth.json', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }));
          } else {
            await directory.write('.claude.json', JSON.stringify({ hasCompletedOnboarding: true,
              customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] } }));
          }
        } else {
          const sourceConfig = home?.configDir ?? join(options.nodeCredentialHome ?? homedir(),
            provider === 'openai' ? '.codex' : '.claude');
          const name = provider === 'openai' ? 'auth.json' : '.credentials.json';
          stage = 'snapshot';
          const material = await readAuthFile(sourceConfig, name).catch(async (error: unknown) => {
            // On macOS Claude Code keeps its login in the Keychain, keyed by the config
            // directory, so there is no file to copy and an isolated copy has no login.
            // This holds for the node's ~/.claude and for a member home alike. Run on
            // the source directory instead; copying the OAuth token would also let the
            // copy's refresh rotate it and sign out the source. Only the file may be
            // missing: a missing or symlinked directory, or a space key home, refuses.
            if (provider === 'anthropic' && platform === 'darwin' && !home?.space
              && (error as NodeJS.ErrnoException).code === 'ENOENT'
              && await lstat(sourceConfig).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false)) {
              return null;
            }
            throw error;
          });
          if (material === null) sharedConfigDir = sourceConfig;
          else {
            await directory.write(name, material);
            if (provider === 'anthropic') await directory.write('.claude.json', JSON.stringify({ hasCompletedOnboarding: true }));
          }
        }
        const configDir = sharedConfigDir ?? directory.path;
        const isolated: AgentCredentialHome = {
          ...(home ?? { provider, homeDir: configDir, configDir }),
          homeDir: sharedConfigDir ? home?.homeDir ?? homedir() : directory.path, configDir,
        };
        const env = { ...selected.env };
        applyAgentCredentialEnv(env, isolated);
        // A member home's Keychain entry is found through CLAUDE_CONFIG_DIR; only
        // the node's own ~/.claude is found without it.
        if (sharedConfigDir && !home) delete env['CLAUDE_CONFIG_DIR'];
        // Relocation suppresses ambient keys; this key was explicitly selected
        // through the policy-gated node rung and belongs to this snapshot.
        if (selected.binding.source === 'node' && key) {
          env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'] = key;
        }
        const checkInput = pinnedInput(input, selected);
        const revalidate = async () => {
          if (released) throw new CollabError('forbidden', 'Chat credential lease was released');
          try {
            const current = await resolve(checkInput);
            if (JSON.stringify(current.binding) !== JSON.stringify(selected.binding)) {
              throw new Error('Credential binding changed');
            }
            // This detects relocation, not account identity or material revision.
            // Unknown revisions still prohibit hot reuse at the next boundary.
            if (current.credentialHome?.provider !== selected.credentialHome?.provider
              || current.credentialHome?.configDir !== selected.credentialHome?.configDir) {
              throw new Error('Credential home changed');
            }
          } catch {
            throw new CollabError('forbidden', 'Chat credential authorization is no longer available');
          }
        };
        const prepared: PreparedChatCredential = {
          leaseId: directory.id, owner: { ...owner }, binding: selected.binding,
          storageScopeId: directory.id, nativeStorageGeneration: owner.generation,
          revalidate,
          async materialize() { await revalidate(); return { env: { ...env }, modelConfigDir: sharedConfigDir ?? directory.path }; },
          async release(releaseOwner = owner) {
            await directory.release(releaseOwner); released = true; live.delete(prepared);
          },
        };
        stage = 'revalidate';
        await revalidate(); // source may have been revoked while the files were copied
        live.add(prepared);
        return prepared;
      } catch (error) {
        await directory.release();
        const cause = redactedCause(error);
        const { route, source, credentialId } = selected.binding;
        // eslint-disable-next-line no-console
        console.warn('[chat] credential preparation failed', JSON.stringify({ chatId: input.chatId,
          provider: route.nativeProvider, source, credentialId, home: Boolean(selected.credentialHome),
          stage, cause: cause.message }));
        throw Object.assign(harnessFailure('credential_unavailable', 'prepare', stage === 'revalidate'
          ? 'Selected chat credential cannot be prepared in an isolated runtime: it is no longer authorized for this chat.'
          : `Selected chat credential cannot be prepared in an isolated runtime: its ${route.nativeProvider} login could not be read (${cause.message}). Reconnect it in Settings or pick another credential.`),
        { cause });
      }
    },
    async revalidate(prepared) {
      if (!live.has(prepared)) throw new CollabError('forbidden', 'Unknown chat credential lease');
      await prepared.revalidate();
    },
    async release(prepared, owner) { await prepared.release(owner); },
  };
}
