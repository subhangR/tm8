import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { newProjectFolder } from '../../src/facade/services/w2/projects-associations.js';
import { listProjectDirectories, projectsHome } from '../../src/facade/services/w2/project-directories.js';

/**
 * WHERE A PROJECT WITH NO `workingDir` GETS ITS FOLDER.
 *
 * Prod runs as a service account whose HOME is the root-owned install dir, so
 * `~/<name>` could not be created and every project created without a folder
 * failed with "cannot create project directory". `TM8_PROJECTS_HOME`, when
 * set, is the parent instead; `~/…` typed by the caller still means HOME.
 */

const scratch = mkdtempSync(join(tmpdir(), 'tm8-projects-home-'));
const home = join(scratch, 'home');
const projects = join(scratch, 'projects');
mkdirSync(home);
mkdirSync(projects);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('projectsHome', () => {
  it('is TM8_PROJECTS_HOME when set', () => {
    expect(projectsHome(projects, home)).toBe(projects);
  });

  it('falls back to HOME when unset or blank', () => {
    expect(projectsHome(undefined, home)).toBe(home);
    expect(projectsHome('  ', home)).toBe(home);
  });
});

describe('newProjectFolder', () => {
  it('puts the default folder under TM8_PROJECTS_HOME, not HOME', () => {
    expect(newProjectFolder({ name: 'Mobile Wordrobe' }, home, projects)).toEqual({
      workingDir: join(projects, 'mobile-wordrobe'),
      ensureWorkingDir: true,
    });
  });

  it('still defaults to ~/<name> when no projects home is set', () => {
    expect(newProjectFolder({ name: 'Docs Site' }, home, projectsHome(undefined, home)).workingDir).toBe(
      join(home, 'docs-site'),
    );
  });

  it('expands a typed ~/ path against HOME regardless of TM8_PROJECTS_HOME', () => {
    expect(newProjectFolder({ name: 'x', workingDir: '~/elsewhere' }, home, projects).workingDir).toBe(
      join(home, 'elsewhere'),
    );
  });

  it('refuses a default under TM8_PROJECTS_HOME that already exists, naming the full path', () => {
    mkdirSync(join(projects, 'taken'));
    expect(() => newProjectFolder({ name: 'Taken' }, home, projects)).toThrow(join(projects, 'taken'));
  });
});

describe('the folder picker', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('opens at TM8_PROJECTS_HOME and names it as projectsHome', async () => {
    vi.stubEnv('TM8_PROJECTS_HOME', projects);
    const listing = await listProjectDirectories(undefined, [scratch]);
    expect(listing.path).toBe(realpathSync(projects));
    expect(listing.projectsHome).toBe(realpathSync(projects));
  });

  it('omits projectsHome when it lies outside the caller\'s roots', async () => {
    vi.stubEnv('TM8_PROJECTS_HOME', projects);
    const listing = await listProjectDirectories(undefined, [home]);
    expect(listing.projectsHome).toBeUndefined();
  });
});
