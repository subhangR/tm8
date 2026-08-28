/**
 * The self-serve clone path, tested where it carries weight.
 *
 * `normalizeGitHubRepoUrl` is the whole input surface of
 * `projects.createFromRepo` — the caller supplies a repo URL and nothing else
 * — so its rejections ARE the authorization story, and each one below stands
 * for a way the feature could have handed out something it should not.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';

import {
  cloneRepository,
  normalizeGitHubRepoUrl,
  projectWorkingDir,
  redactToken,
  selfServeProjectRoot,
} from '../../src/facade/services/w2/project-clone.js';

describe('normalizeGitHubRepoUrl', () => {
  it('accepts the shapes a person actually pastes', () => {
    const canonical = 'https://github.com/tarkesh/notes.git';
    for (const input of [
      'https://github.com/tarkesh/notes',
      'https://github.com/tarkesh/notes.git',
      'https://github.com/tarkesh/notes/',
      'https://GitHub.com/tarkesh/notes',
      'github.com/tarkesh/notes',
      'tarkesh/notes',
      '  tarkesh/notes  ',
    ]) {
      const repo = normalizeGitHubRepoUrl(input);
      expect(repo.url, input).toBe(canonical);
      expect(repo.owner, input).toBe('tarkesh');
      expect(repo.repo, input).toBe('notes');
    }
  });

  /**
   * Each of these is a distinct escape, not a variation on one.
   */
  it('refuses every non-github, non-https origin', () => {
    const rejected: Array<[string, string]> = [
      // Would clone another space's project — already on this node — into a
      // directory the requesting space can then read through projects.files.list.
      ['file:///home/tm8/projects/tm8', 'local path'],
      ['/home/tm8/projects/tm8', 'absolute path'],
      ['../../etc', 'relative path'],
      // Would authenticate as the NODE's ssh key rather than as the member.
      ['git@github.com:tarkesh/notes.git', 'scp-style ssh'],
      ['ssh://git@github.com/tarkesh/notes', 'ssh url'],
      // Would present a GitHub credential to a host that is not GitHub.
      ['https://gitlab.com/tarkesh/notes', 'other host'],
      ['https://github.com.evil.test/tarkesh/notes', 'lookalike host'],
      // Would launder a credential out of a URL into a stored project.
      ['https://user:ghp_secret@github.com/tarkesh/notes', 'embedded credentials'],
      // Neither of these names exactly one repository.
      ['https://github.com/tarkesh', 'owner only'],
      ['https://github.com/tarkesh/notes/tree/main', 'deep path'],
      ['', 'empty'],
    ];

    for (const [input, why] of rejected) {
      expect(() => normalizeGitHubRepoUrl(input), why).toThrow(CollabError);
    }
  });

  it('refuses path segments that could climb out of the derived directory', () => {
    for (const input of ['../notes', 'tarkesh/..', '../../x', 'tar kesh/notes']) {
      expect(() => normalizeGitHubRepoUrl(input), input).toThrow(CollabError);
    }
  });
});

describe('projectWorkingDir', () => {
  const repo = normalizeGitHubRepoUrl('tarkesh/notes');
  const space = '019fbd5a-3c5b-71ea-9b91-1d3baa50da25';

  it('derives the path from the managed root, the space and the repo', () => {
    expect(projectWorkingDir('/srv/tm8-data', space, repo))
      .toBe(`/srv/tm8-data/projects/${space}/tarkesh-notes`);
  });

  /**
   * The browse roots default to the whole filesystem and are what a node admin
   * picks from by hand. Self-serve writes must not follow them, or widening
   * the picker would silently widen this.
   */
  it('does not read TM8_PROJECT_ROOTS', () => {
    const previous = process.env.TM8_PROJECT_ROOTS;
    process.env.TM8_PROJECT_ROOTS = '/';
    try {
      expect(selfServeProjectRoot('/srv/tm8-data')).toBe('/srv/tm8-data/projects');
    } finally {
      if (previous === undefined) delete process.env.TM8_PROJECT_ROOTS;
      else process.env.TM8_PROJECT_ROOTS = previous;
    }
  });

  it('keeps two spaces that link the same repo apart', () => {
    const a = projectWorkingDir('/srv/d', '019fbd5a-3c5b-71ea-9b91-1d3baa50da25', repo);
    const b = projectWorkingDir('/srv/d', '019fd18d-1a1c-7542-943a-2a0861eb39c0', repo);
    expect(a).not.toBe(b);
  });
});

describe('cloneRepository', () => {
  const repo = normalizeGitHubRepoUrl('tarkesh/notes');

  // `cloneRepository` really does create the parent directory — only the git
  // invocation is injected — so these run against a real writable temp root.
  let root = '';
  let workingDir = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tm8-clone-test-'));
    workingDir = join(root, 'projects', 'space', 'tarkesh-notes');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  interface Captured {
    file: string;
    args: readonly string[];
    env: Record<string, string>;
  }

  function capture(): { calls: Captured[]; run: never } {
    const calls: Captured[] = [];
    const run = ((file: string, args: readonly string[], options: { env: Record<string, string> }) => {
      calls.push({ file, args, env: options.env });
      return Promise.resolve({ stdout: '', stderr: '' });
    }) as never;
    return { calls, run };
  }

  /**
   * The token must reach git ONLY through the environment. In a URL it would
   * be written into `.git/config` inside the clone, and that file is then
   * readable by the whole space through `projects.files.list`.
   */
  it('never puts the token in the argv or the remote url', async () => {
    const { calls, run } = capture();
    await cloneRepository({
      repo, workingDir,
      token: 'ghp_supersecret', login: 'tarkesh', run,
    });

    const call = calls[0]!;
    expect(call.file).toBe('git');
    expect(call.args.join(' ')).not.toContain('ghp_supersecret');
    expect(call.args).toContain('https://github.com/tarkesh/notes.git');
    expect(call.env.GH_TOKEN).toBe('ghp_supersecret');
    expect(call.env.TM8_GIT_LOGIN).toBe('tarkesh');
  });

  /**
   * A missing or wrong token must FAIL. Without these, git would fall through
   * to a machine-wide helper and clone as the node — which is precisely the
   * impersonation this feature exists to avoid — or block on a prompt.
   */
  it('disables prompting and inherited credential helpers', async () => {
    const { calls, run } = capture();
    await cloneRepository({
      repo, workingDir,
      token: 't', login: 'tarkesh', run,
    });

    const { env } = calls[0]!;
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    // The node's own environment must not leak in wholesale.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it('does not run hooks out of the cloned tree', async () => {
    const { calls, run } = capture();
    await cloneRepository({
      repo, workingDir,
      token: 't', login: 'tarkesh', run,
    });
    expect(calls[0]!.args.join(' ')).toContain('core.hooksPath=/dev/null');
  });

  it('reports an unreadable repository as one refusal, not two guesses', async () => {
    const run = (() => Promise.reject(
      Object.assign(new Error('exit 128'), { stderr: 'remote: Repository not found.' }),
    )) as never;

    await expect(cloneRepository({
      repo, workingDir,
      token: 'ghp_supersecret', login: 'tarkesh', run,
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  /**
   * Redaction is a substring replace, so a token whose characters occur inside
   * ordinary words rewrites git's own wording. Classifying on redacted text
   * therefore loses the diagnosis — silently, and only for some tokens. This
   * pins the order: classify on raw, redact for display.
   */
  it('classifies the failure before redacting, whatever the token looks like', async () => {
    const run = (() => Promise.reject(
      Object.assign(new Error('exit 128'), { stderr: 'remote: Repository not found.' }),
    )) as never;

    await expect(cloneRepository({
      repo, workingDir,
      token: 't', login: 'tarkesh', run,
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('never lets the token reach the surfaced message', async () => {
    const run = (() => Promise.reject(
      Object.assign(new Error('exit 128'), { stderr: 'fatal: bad url https://ghp_leaky@github.com' }),
    )) as never;

    await expect(cloneRepository({
      repo, workingDir,
      token: 'ghp_leaky', login: 'tarkesh', run,
    })).rejects.toThrow(/\[redacted\]/);
  });
});

describe('redactToken', () => {
  it('scrubs the token from anything on its way to a caller', () => {
    expect(redactToken('fatal: bad credentials ghp_abc', 'ghp_abc'))
      .toBe('fatal: bad credentials [redacted]');
  });

  it('leaves text alone when there is no token to hide', () => {
    expect(redactToken('fatal: whatever', '')).toBe('fatal: whatever');
  });
});
