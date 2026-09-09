import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerOperation } from './providers.mjs';
import { executionOperation } from './execution.mjs';
const exec = promisify(execFile);
const HOME = '/home/user';
const id = value => { if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value ?? '')) throw new Error('invalid_id'); return value; };
const git = async (cwd, args, options = {}) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=always', '-C', cwd, ...args], { maxBuffer: 96 * 1024 * 1024, timeout: 120000, ...options })).stdout;
const projectPath = input => path.join(HOME, 'projects', id(input.projectId));
async function safePath(root, relative, mayCreate = false) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('invalid_path');
  const target = path.resolve(root, relative);
  const resolvedRoot = await fs.realpath(root);
  let resolved;
  try { resolved = await fs.realpath(target); }
  catch (error) { if (!mayCreate || error.code !== 'ENOENT') throw error; resolved = path.join(await fs.realpath(path.dirname(target)), path.basename(target)); }
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}/`)) throw new Error('path_outside_project');
  return target;
}
function githubUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(parsed.pathname)) throw new Error('https_github_remote_required');
  return parsed.href;
}
async function branchName(cwd, branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.length > 200) throw new Error('invalid_branch');
  await git(cwd, ['check-ref-format', '--branch', branch]); return branch;
}
async function temporaryBundle(bytes, fn) {
  const dir = await fs.mkdtemp('/tmp/tm8-git-');
  const file = path.join(dir, 'bundle');
  try { if (bytes) await fs.writeFile(file, Buffer.from(bytes, 'base64'), { mode: 0o600 }); return await fn(file); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function ensureIdentity(cwd, input) {
  await git(cwd, ['config', 'user.name', input.gitName ?? 'tm8 user']);
  await git(cwd, ['config', 'user.email', `${id(input.accountId)}@users.tm8.local`]);
  await git(cwd, ['config', 'pull.ff', 'only']);
}
async function managedRemote(cwd, projectId) {
  const remotes = (await git(cwd, ['remote'])).split('\n');
  await git(cwd, ['remote', remotes.includes('tm8') ? 'set-url' : 'add', 'tm8', `tm8://${id(projectId)}`]);
}

async function githubRequest(token, route, payload) {
  if (!/^[A-Za-z0-9_]{20,256}$/.test(token)) throw new Error('invalid_github_token');
  const dir = await fs.mkdtemp('/tmp/tm8-github-');
  try {
    const args = ['--config', '-', '--fail-with-body', '--silent', '--show-error', '--max-time', '30'];
    if (payload) { const file = path.join(dir, 'request.json'); await fs.writeFile(file, JSON.stringify(payload), { mode: 0o600 }); args.push('--data-binary', `@${file}`); }
    // execFile's callback API does not expose an input option. Feed the curl
    // config directly to stdin so the token never appears in argv or env.
    const config = `url = "https://api.github.com${route}"\nheader = "Authorization: Bearer ${token}"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: 2022-11-28"\nheader = "Content-Type: application/json"\nuser-agent = "tm8-workspace"\n`;
    const result = await new Promise((resolve, reject) => {
      const child = execFile('curl', args, { timeout: 35000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new Error('github_request_failed')) : resolve(stdout));
      child.stdin.end(config);
    });
    return JSON.parse(result);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export async function run(input) {
  if (['execution-prepare', 'execution-stop', 'execution-ready'].includes(input.action)) return executionOperation(input);
  if (['providers-status', 'provider-probe', 'provider-ready', 'provider-stop', 'provider-disconnect'].includes(input.action)) return providerOperation(input);
  if (input.action === 'home') {
    await fs.mkdir(`${HOME}/projects`, { recursive: true, mode: 0o700 });
    await fs.mkdir(`${HOME}/.config/tm8`, { recursive: true, mode: 0o700 });
    await git(HOME, ['config', '--global', 'credential.https://github.com.helper', '!node /opt/tm8/git-credential.mjs']);
    return { homePath: HOME };
  }
  if (input.action === 'github-credential') {
    const file = `${HOME}/.config/tm8/github-token`;
    if (input.token === null) { await fs.rm(file, { force: true }); return { connected: false }; }
    if (input.token === undefined) { try { await fs.access(file); return { connected: true }; } catch { return { connected: false }; } }
    const account = await githubRequest(input.token, '/user');
    await fs.writeFile(file, input.token, { mode: 0o600 }); await fs.chmod(file, 0o600);
    return { connected: true, login: account.login };
  }
  if (input.action === 'repo-init') {
    const repo = `/repos/${id(input.projectId)}.git`;
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '--bare', '--initial-branch=main']);
    return { ready: true };
  }
  if (input.action === 'repo-export') {
    const repo = `/repos/${id(input.projectId)}.git`;
    return temporaryBundle(null, async file => {
      await git(repo, ['bundle', 'create', file, '--all']);
      return { bundle: (await fs.readFile(file)).toString('base64') };
    });
  }
  if (input.action === 'repo-push') {
    const repo = `/repos/${id(input.projectId)}.git`;
    const branch = await branchName(repo, input.branch);
    return temporaryBundle(input.bundle, async file => {
      await git(repo, ['bundle', 'verify', file]);
      // Updating a heads ref without '+' rejects non-fast-forward history.
      let unborn = false; try { await git(repo, ['rev-parse', '--verify', 'HEAD']); } catch { unborn = true; }
      await git(repo, ['fetch', '--no-tags', file, `HEAD:refs/heads/${branch}`]);
      if (unborn) await git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      return { branch, commit: (await git(repo, ['rev-parse', `refs/heads/${branch}`])).trim() };
    });
  }
  const cwd = projectPath(input);
  if (input.action === 'project-create') {
    const marker = `${HOME}/.config/tm8/project-${id(input.projectId)}.json`;
    try { return JSON.parse(await fs.readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (input.source.kind === 'init') {
      await fs.mkdir(cwd, { recursive: true });
      await git(cwd, ['init', '--initial-branch=main']);
    } else if (input.source.kind === 'clone') {
      const url = githubUrl(input.source.url);
      try { await fs.access(path.join(cwd, '.git')); }
      catch {
        const temp = `${cwd}.clone-${randomUUID()}`;
        try { await git(HOME, ['clone', '--', url, temp]); await fs.rename(temp, cwd); }
        finally { await fs.rm(temp, { recursive: true, force: true }); }
      }
    } else if (input.source.kind === 'import') {
      const source = await safePath(HOME, input.source.relativePath);
      if (source === HOME || source === cwd || cwd.startsWith(`${source}/`)) throw new Error('invalid_import_source');
      // Reflinks/copies preserve uncommitted files and .git; never move originals.
      await fs.cp(source, cwd, { recursive: true, force: false, errorOnExist: false, dereference: false });
      try { await git(cwd, ['rev-parse', '--git-dir']); } catch { await git(cwd, ['init', '--initial-branch=main']); }
    } else throw new Error('invalid_project_source');
    await ensureIdentity(cwd, input);
    try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); }
    catch { await git(cwd, ['commit', '--allow-empty', '-m', 'Initialize tm8 project']); }
    await managedRemote(cwd, input.projectId);
    const result = { relativePath: `projects/${input.projectId}`, branch: (await git(cwd, ['branch', '--show-current'])).trim() };
    await fs.writeFile(marker, JSON.stringify(result), { mode: 0o600 });
    return result;
  }
  if (input.action === 'checkout-create') {
    try { await fs.access(path.join(cwd, '.git')); return { relativePath: `projects/${input.projectId}` }; } catch {}
    await temporaryBundle(input.bundle, async file => { await git(HOME, ['clone', '--', file, cwd]); });
    await ensureIdentity(cwd, input); await managedRemote(cwd, input.projectId);
    return { relativePath: `projects/${input.projectId}` };
  }
  if (input.action === 'files-list') {
    const dir = await safePath(cwd, input.path ?? '');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return { entries: entries.filter(entry => entry.name !== '.git').slice(0, 2000).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })) };
  }
  if (input.action === 'files-read') {
    const file = await safePath(cwd, input.path);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('file_too_large_or_not_file');
    return { content: (await fs.readFile(file)).toString('base64'), encoding: 'base64' };
  }
  if (input.action === 'files-write') {
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 6 * 1024 * 1024) throw new Error('file_too_large');
    const file = await safePath(cwd, input.path, true);
    if (input.path.split('/').includes('.git')) throw new Error('git_metadata_is_managed');
    await fs.writeFile(file, Buffer.from(input.content, 'base64'), { mode: 0o600 });
    return { written: true };
  }
  if (input.action === 'git-status') {
    return { status: await git(cwd, ['status', '--porcelain=v1', '-b']), branch: (await git(cwd, ['branch', '--show-current'])).trim(), remotes: await git(cwd, ['remote', '-v']) };
  }
  if (input.action === 'git-commit') {
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4096) throw new Error('invalid_commit_message');
    await git(cwd, ['add', '--all']); await git(cwd, ['commit', '-m', input.message]);
    return { commit: (await git(cwd, ['rev-parse', 'HEAD'])).trim() };
  }
  if (input.action === 'git-export') {
    const branch = await branchName(cwd, input.branch || (await git(cwd, ['branch', '--show-current'])).trim());
    // Use HEAD as a stable bundle source; refuse to label another branch's HEAD.
    if ((await git(cwd, ['branch', '--show-current'])).trim() !== branch) throw new Error('checkout_branch_mismatch');
    return temporaryBundle(null, async file => {
      await git(cwd, ['bundle', 'create', file, 'HEAD']);
      return { bundle: (await fs.readFile(file)).toString('base64'), branch };
    });
  }
  if (input.action === 'git-import') {
    const branch = await branchName(cwd, input.branch || (await git(cwd, ['branch', '--show-current'])).trim());
    if (input.pull && (await git(cwd, ['status', '--porcelain'])).trim()) throw new Error('dirty_worktree');
    return temporaryBundle(input.bundle, async file => {
      await git(cwd, ['fetch', '--no-tags', file, `refs/heads/${branch}:refs/remotes/tm8/${branch}`]);
      if (input.pull) await git(cwd, ['merge', '--ff-only', `refs/remotes/tm8/${branch}`]);
      return { branch, commit: (await git(cwd, ['rev-parse', 'HEAD'])).trim() };
    });
  }
  if (input.action === 'git-origin') {
    const url = githubUrl((await git(cwd, ['remote', 'get-url', 'origin'])).trim());
    const branch = await branchName(cwd, input.branch || (await git(cwd, ['branch', '--show-current'])).trim());
    if (input.verb === 'pull') {
      if ((await git(cwd, ['status', '--porcelain'])).trim()) throw new Error('dirty_worktree');
      await git(cwd, ['pull', '--ff-only', url, branch]);
    } else if (input.verb === 'fetch') await git(cwd, ['fetch', 'origin']);
    else if (input.verb === 'push') await git(cwd, ['push', '--', url, `HEAD:refs/heads/${branch}`]);
    else throw new Error('invalid_git_action');
    return { branch };
  }
  if (input.action === 'git-connect') {
    const url = githubUrl(input.url);
    const remotes = (await git(cwd, ['remote'])).split('\n');
    await git(cwd, ['remote', remotes.includes('origin') ? 'set-url' : 'add', 'origin', url]);
    return { remote: 'origin', url };
  }
  if (input.action === 'github-create') {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(input.name ?? '')) throw new Error('invalid_repository_name');
    const token = (await fs.readFile(`${HOME}/.config/tm8/github-token`, 'utf8')).trim();
    const repo = await githubRequest(token, '/user/repos', { name: input.name, private: input.private !== false });
    const url = githubUrl(repo.clone_url);
    const remotes = (await git(cwd, ['remote'])).split('\n');
    await git(cwd, ['remote', remotes.includes('origin') ? 'set-url' : 'add', 'origin', url]);
    return { remote: 'origin', url };
  }
  throw new Error('unknown_runner_action');
}

if (process.argv[1] === '/opt/tm8/runner.mjs') {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 128 * 1024 * 1024) throw new Error('request_too_large'); }
    process.stdout.write(JSON.stringify({ data: await run(JSON.parse(input)) }));
  } catch (error) {
    // stderr from Git can contain remote user data. Bound it, never echo inputs
    // or command lines (which might carry private source or credential material).
    process.stdout.write(JSON.stringify({ error: { code: error.code === undefined ? error.message : 'runner_operation_failed', detail: typeof error.stderr === 'string' ? error.stderr.slice(0, 2000) : undefined } }));
    process.exitCode = 1;
  }
}
