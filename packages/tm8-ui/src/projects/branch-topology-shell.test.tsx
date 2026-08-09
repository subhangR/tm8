// @vitest-environment jsdom
/**
 * THE FOUR-LINKS TEST for the branch-topology section: declaration (seam
 * Amendment 5) → data (fixtures/branches) → implementation (fixture seam) →
 * CALL can each be green while the feature is dead, because nobody asserted
 * the shell's `projects` slot actually mounts the section and the section's
 * port actually reaches a seam. So this test drives the REAL SettingsShell
 * with the section injected exactly the way GateApp injects it, over an
 * actual `createFixtureSeam()` — and asserts on what comes BACK.
 *
 * (GateApp's own call site is typechecked but not rendered here: its test
 * file is the known-red localStorage set, and adding to it would bury this
 * assertion in a file that cannot pass.)
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { SettingsShell, settingsPortFromSeam } from '../settings-space';
import { ProjectBranchesSection, type ProjectBranchesPort } from './BranchTopologyList';

describe('SettingsShell × ProjectBranchesSection over a real fixture seam', () => {
  it('the projects slot mounts the section and branches arrive from the seam', async () => {
    const seam = createFixtureSeam();
    // The port shape GateApp builds: spaceId closed over, two reads, no more.
    const port: ProjectBranchesPort = {
      projects: () => seam.projects(FIXTURE_SPACE_ID),
      branches: (projectId) => seam.projectBranches(projectId),
    };

    const r = render(
      <SettingsShell
        port={settingsPortFromSeam(seam, FIXTURE_SPACE_ID)}
        initialSection="projects"
        sections={{ projects: <ProjectBranchesSection port={port} /> }}
      />,
    );

    // The slot is FILLED — the shell's own "built in another module and not
    // mounted here" fallback must be gone.
    await waitFor(() => expect(r.getByTestId('project-branches-section')).toBeTruthy());
    expect(r.queryByTestId('section-absent')).toBeNull();

    // The fixture seam's linked project appears…
    await waitFor(() => expect(r.getByTestId('project-branches-row').textContent).toContain('tm8-ui'));

    // …and expanding it renders the seam's topology, provenance included.
    fireEvent.click(r.getByRole('button', { name: 'show branches' }));
    await waitFor(() => expect(r.getByTestId('branch-topology')).toBeTruthy());
    expect(r.getAllByTestId('branch-row').length).toBe(5);
    expect(r.getByTestId('trunk-source').textContent).toBe("from the remote's HEAD");
  });
});
