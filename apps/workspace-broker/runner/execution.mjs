import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const id = value => { if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value ?? '')) throw new Error('invalid_id'); return value; };
export const executionDirectory = sessionId => `/home/user/.local/share/tm8/sessions/${id(sessionId)}`;

export function agentArguments(input) {
  if (!['claude-code', 'codex'].includes(input.agentTool)) throw new Error('unsupported_agent_tool');
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,150}$/.test(input.model)) throw new Error('invalid_model');
  if (!['safe', 'acceptEdits', 'auto', 'plan', 'fullAccess'].includes(input.accessMode)) throw new Error('invalid_access_mode');
  if (input.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.reasoningEffort)) throw new Error('invalid_effort');
  if (typeof input.prompt !== 'string' || input.prompt.length > 100000 || input.prompt.includes('\0')) throw new Error('invalid_prompt');
  const args = ['--model', input.model];
  if (input.agentTool === 'claude-code') {
    args.push('--session-id', id(input.sessionId));
    if (input.accessMode === 'fullAccess') args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', { safe: 'default', plan: 'plan', auto: 'auto', acceptEdits: 'acceptEdits' }[input.accessMode]);
    if (input.reasoningEffort) {
      if (input.reasoningEffort === 'ultra') throw new Error('invalid_effort');
      args.push('--effort', input.reasoningEffort);
    }
  } else {
    args.push('--no-alt-screen');
    if (input.accessMode === 'fullAccess') args.push('--dangerously-bypass-approvals-and-sandbox');
    else {
      args.push('--sandbox', input.accessMode === 'plan' ? 'read-only' : 'workspace-write');
      args.push('--ask-for-approval', ['safe', 'plan'].includes(input.accessMode) ? 'on-request' : 'never');
      // The outer container only reaches the public egress proxy. No graph,
      // host, metadata endpoint, or other user's network is reachable here.
      if (input.accessMode !== 'plan') args.push('-c', 'sandbox_workspace_write.network_access=true');
    }
    if (input.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`);
  }
  if (input.prompt) args.push('--', input.prompt);
  return { binary: input.agentTool === 'claude-code' ? '/usr/local/bin/claude' : '/usr/local/bin/codex', args };
}

async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (await fs.realpath(dir) !== dir) throw new Error('workspace_symlink_refused');
  return dir;
}
async function git(cwd, args) {
  return (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { timeout: 30000, maxBuffer: 65536 })).stdout.trim();
}
async function configureClaude(cwd) {
  const file = '/home/user/.claude.json';
  let config = {};
  try {
    if (await fs.realpath(file) !== file) throw new Error('workspace_symlink_refused');
    config = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid_claude_configuration');
  const projects = config.projects ?? {}, current = projects[cwd] ?? {};
  if (current.hasTrustDialogAccepted === false) throw new Error('workspace_trust_refused');
  // The broker has verified the existing login, and tm8 has authorized this
  // exact directory. Otherwise the first interactive launch asks to sign in
  // again despite a valid OAuth credential, and never receives its task.
  const next = { ...config, theme: config.theme ?? 'dark', hasCompletedOnboarding: true,
    projects: { ...projects, [cwd]: { ...current, hasTrustDialogAccepted: true } } };
  const temporary = `${file}.tm8-${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
  await fs.rename(temporary, file);
}
export async function executionOperation(input) {
  const dir = executionDirectory(input.sessionId);
  if (input.action === 'execution-ready') {
    for (let i = 0; i < 100; i++) {
      try { await fs.access(`${dir}/process.json`); return { ready: true }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('execution_start_timed_out');
  }
  if (input.action === 'execution-stop') {
    let state;
    try { state = JSON.parse(await fs.readFile(`${dir}/process.json`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { stopped: true }; throw error; }
    if (!state.finished && Number.isInteger(state.pid) && state.pid > 1) {
      // A PID can be reused after a runner restart. Compare its kernel start
      // time before signalling the process group belonging to this session.
      try {
        const stat = await fs.readFile(`/proc/${state.pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === state.started) process.kill(-state.pid, 'SIGKILL');
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    return { stopped: true };
  }
  if (input.action !== 'execution-prepare') throw new Error('unsupported_execution_action');
  const command = agentArguments(input);
  let cwd;
  if (input.workdirMode === 'scratch') {
    cwd = await privateDirectory(`/home/user/scratch/${id(input.workdirId)}`);
    await git(cwd, ['init', '--initial-branch=main']);
  } else {
    const project = `/home/user/projects/${id(input.projectId)}`;
    if (await fs.realpath(project) !== project) throw new Error('workspace_symlink_refused');
    if (input.workdirMode === 'project') cwd = project;
    else if (input.workdirMode === 'worktree') {
      await privateDirectory('/home/user/worktrees');
      cwd = `/home/user/worktrees/${id(input.workdirId)}`;
      const baseRef = input.baseRef ?? 'HEAD';
      if (typeof baseRef !== 'string' || baseRef.startsWith('-') || baseRef.length > 200 || /[\x00-\x20]/.test(baseRef)) throw new Error('invalid_base_ref');
      const commit = await git(project, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
      await git(project, ['worktree', 'add', '-b', `tm8/${input.workdirId}`, cwd, commit]);
    } else throw new Error('invalid_workdir_mode');
  }
  if (input.agentTool === 'claude-code') await configureClaude(cwd);
  else command.args.unshift('-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`);
  await privateDirectory(dir);
  // Exclusive create makes a session UUID a once-only launch. Retrying the
  // facade's mutation must replay its graph result, never overwrite a run.
  await fs.writeFile(`${dir}/launch.json`, JSON.stringify({ ...command, cwd }), { flag: 'wx', mode: 0o600 });
  let branch = null;
  try { branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']); } catch {}
  return { cwd, branch };
}
