import type { LaunchCapacity, LaunchProfile, LaunchProject, LaunchTeammate } from '../domain/launch';
export type { LaunchProfile, LaunchProject, LaunchTeammate } from '../domain/launch';

/**
 * Launch-sheet fixture data (D51: "fixtures grow accordingly — profiles in the
 * T2-4 vocabulary including non-active statuses, projects with trust states").
 *
 * These live in `views/` rather than `src/fixtures/` deliberately: they are
 * SHEET-SHAPED view models, not contract DTOs. The contract-typed dataset in
 * `src/fixtures/` stays wire-shaped (D9) and is the seam's source; adding
 * view-model shapes there would blur what that directory promises. When the
 * launch flow wires to `seam.commands.spawn`, the real rows arrive as contract
 * types and these are replaced, not extended.
 *
 * The matrix is chosen to exercise the honesty states, not to look tidy: an
 * untrusted project that CANNOT host, a scratch root, a draft profile and a
 * retired one. A fixture set where everything is selectable would render a
 * sheet in which none of D51's required refusals can be seen.
 */

export const LAUNCH_TEAMMATES: readonly LaunchTeammate[] = [
  {
    id: 'ent-tm-forge',
    name: 'forge',
    initial: 'F',
    model: 'claude-sonnet-5',
    agentTool: 'claude-code',
    owner: '@ada',
    defaultProfileId: 'pf-standard',
  },
  {
    id: 'ent-tm-scout',
    name: 'scout',
    initial: 'S',
    model: 'claude-opus-5',
    agentTool: 'claude-code',
    owner: '@ada',
    liveSessions: 1,
  },
];

export const LAUNCH_PROJECTS: readonly LaunchProject[] = [
  { id: 'pj-tm8ui', name: 'tm8-ui', trusted: true, detail: 'trusted · ~/code/tm8-ui', selectedByDefault: true },
  { id: 'pj-docs', name: 'docs-site', trusted: true, detail: 'trusted · ~/code/docs' },
  {
    id: 'pj-vendor',
    name: 'vendor-import',
    trusted: false,
    detail: '',
    // The mechanism, then somewhere to go — T5-5's untrusted-row vocabulary.
    reason: "untrusted — can't host sessions · trust it in Node settings ↗",
  },
];

export const LAUNCH_PROFILES: readonly LaunchProfile[] = [
  { id: 'pf-standard', name: 'standard-agent v2', version: 2, status: 'active', isSpaceDefault: true,
    templateKey: 'tm8.chat.core', contentSurfaces: ['terminal', 'chat'], initialContentSurface: 'chat' },
  { id: 'pf-house', name: 'house-style', version: 3, status: 'active', isServerDefault: true,
    templateKey: 'tm8.chat.core', contentSurfaces: ['terminal', 'chat'], initialContentSurface: 'chat' },
  { id: 'pf-terse', name: 'terse-worker', version: 1, status: 'draft',
    templateKey: 'tm8.chat.core', contentSurfaces: ['terminal', 'chat'], initialContentSurface: 'chat' },
  { id: 'pf-old', name: 'forge-default v1', version: 1, status: 'retired',
    templateKey: 'tm8.chat.core', contentSurfaces: ['terminal', 'chat'], initialContentSurface: 'chat' },
];

/**
 * T5-5 draws capacity before commitment ("8 slots, 3 in use"). The SHAPE is
 * `domain`'s canonical `LaunchCapacity` rather than a second local vocabulary
 * — two shapes for one fact is the copy-drift class (D34), and the wording is
 * derived at the render site instead.
 */
export const LAUNCH_CAPACITY: LaunchCapacity = { slotsFree: 5, slotsTotal: 8 };
