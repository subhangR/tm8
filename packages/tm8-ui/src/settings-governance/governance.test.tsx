// @vitest-environment jsdom
/**
 * T2 GOVERNANCE — the render tests.
 *
 * THE BAR THIS FILE MEASURES is the wave's own: **link-level completeness —
 * zero silent voids**. Every control the oracle draws must EXIST on screen and
 * must either work or be disabled-with-reason. So the assertions are not
 * "the happy path renders"; they are:
 *
 *  1. NO SILENT VOID — for each frame, every drawn verb is present, and every
 *     control that cannot be performed carries a reason in the accessibility
 *     tree. A verb that is simply absent fails here.
 *  2. NO ENABLED-INERT CONTROL — the R5 #9 class. A control with no handler
 *     renders refused, never live-and-doing-nothing. Asserted by rendering the
 *     screens with NO handlers at all, which is exactly how the coordinator
 *     will first mount them.
 *  3. AN UNREAD FACT IS NEVER PAINTED AS A VERDICT — the safety assertion of
 *     this whole lane. A project with no trust read must not render `trusted`.
 *  4. THE FORM ACTUALLY WORKS — T2-5's authoring is real local state, so the
 *     tests drive it: type, pick a glyph, add and reorder fields, and watch
 *     validation answer from the real registry.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityKindDef, EntitySummary } from '@tm8/contract';
import {
  CustomKindsScreen,
  InteractionProfilesScreen,
  ProjectsTrustScreen,
  SessionProjectsCard,
  UntrustedConsentCard,
} from './index';
import { CUSTOM_KIND_FALLBACK, getKind } from '../domain';
import { known, unknown, type SessionProjects } from './governance-model';
import { GOVERNANCE_REASONS } from './reasons';

const summary = (over: Partial<EntitySummary> & Pick<EntitySummary, 'id' | 'title'>): EntitySummary =>
  ({ state: {}, spaceId: 'space-1', kind: 'x', ...over }) as EntitySummary;

/** Every screen mounts inside the app's themed root; the CSS is scoped to it. */
const mount = (ui: React.ReactElement) => render(<div className="cv2-root">{ui}</div>);

/** The refusal text a `DisabledAction` puts in the DOM, cause + remedy. */
const reasonTexts = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="disabled-with-reason"]')].map((node) => {
    const describedBy = node.getAttribute('aria-describedby');
    // Attribute selector, NOT `#${CSS.escape(id)}`: `CSS` is undefined in this
    // runner's jsdom (measured — the first red of this file was three tests
    // dying on `Cannot read properties of undefined (reading 'escape')`), and
    // React's `useId` values contain `:` which an id selector cannot take raw.
    const caption = describedBy ? container.querySelector(`[id="${describedBy}"]`) : null;
    return `${node.textContent ?? ''} :: ${caption?.textContent ?? ''}`;
  });

// ---------------------------------------------------------------------------
// T2-2 · projects & trust
// ---------------------------------------------------------------------------

describe('T2-2 — projects & trust', () => {
  const projects = [
    summary({ id: 'e1', title: 'tm8-ui', state: { projectId: 'proj-1' } as never }),
    summary({ id: 'e2', title: 'docs-site', state: { projectId: 'proj-2' } as never }),
  ];

  it('draws every verb the oracle draws, none of them silently absent', () => {
    const { container } = mount(
      <ProjectsTrustScreen
        spaceLabel="space · atelier"
        projects={{ phase: 'ready', value: projects }}
        // The session block is rendered WITH a session, because that is the
        // specimen the oracle draws. Found by the first red: with no session
        // selected the card collapses (design law 9) and "＋ associate" is
        // correctly absent — an affordance with no subject. The completeness
        // bar applies to the drawn state, not to every state.
        sessionProjects={{
          launchedFrom: known(null),
          associations: known([{ id: 'a1', label: 'tm8-ui' }]),
        }}
      />,
    );
    const all = container.textContent ?? '';
    // Oracle L156, L163, L194, L201, L221-224, L250 — the drawn vocabulary.
    for (const verb of ['Link project', 'unlink', 'New project', 'Save project', 'trusted', 'untrusted', 'associate']) {
      expect(all, `the oracle draws “${verb}” and this screen must too`).toContain(verb);
    }
  });

  it('renders NO enabled-inert control when mounted with no handlers at all', () => {
    const { container } = mount(
      <ProjectsTrustScreen spaceLabel="space · atelier" projects={{ phase: 'ready', value: projects }} />,
    );
    // Every <button> present must have a click handler that does something —
    // in this configuration there are no wired verbs, so any enabled button
    // would be the five-dead-verbs defect. (The consent card's own buttons
    // appear only with a pending request; see its describe block.)
    const enabled = [...container.querySelectorAll('button')].filter(
      (b) => b.getAttribute('aria-disabled') !== 'true',
    );
    expect(enabled.map((b) => b.textContent)).toEqual([]);
    expect(reasonTexts(container).length).toBeGreaterThan(6);
  });

  it('NEVER paints an unread trust level as a verdict', () => {
    const { container } = mount(
      <ProjectsTrustScreen spaceLabel="space · atelier" projects={{ phase: 'ready', value: projects }} />,
    );
    const rows = [...container.querySelectorAll('[data-testid="linked-project-row"]')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toContain('trust unread');
      // The defect this pins: a root shown as trusted that nobody verified.
      expect(row.textContent).not.toContain('✓ trusted');
    }
  });

  it('paints a SUPPLIED trust level, and only then', () => {
    const { container } = mount(
      <ProjectsTrustScreen
        spaceLabel="space · atelier"
        projects={{ phase: 'ready', value: projects }}
        factsFor={(p) => (p.id === 'e1' ? { trust: 'trusted' } : { trust: 'untrusted' })}
      />,
    );
    const rows = [...container.querySelectorAll('[data-testid="linked-project-row"]')];
    expect(rows[0]!.textContent).toContain('✓ trusted');
    expect(rows[1]!.textContent).toContain('⚠ untrusted');
    // The untrusted row states its CONSEQUENCE, not just its state (oracle L183).
    expect(rows[1]!.textContent).toContain('agents cannot run here');
  });

  it('blocks unlink on LIVE sessions, naming the number, and offers the way out', () => {
    const opened: string[] = [];
    const { container } = mount(
      <ProjectsTrustScreen
        spaceLabel="space · atelier"
        projects={{ phase: 'ready', value: projects }}
        factsFor={(p) => (p.id === 'e2' ? { usage: { recorded: 14, live: 2 } } : undefined)}
        onOpenSessions={(id) => opened.push(id)}
      />,
    );
    const row = container.querySelectorAll('[data-testid="linked-project-row"]')[1] as HTMLElement;
    expect(reasonTexts(row).join(' ')).toContain('2 live sessions still use this root');
    fireEvent.click(within(row).getByText('view sessions'));
    expect(opened).toEqual(['e2']);
  });

  it('says the node registry is UNREAD rather than rendering an empty registry', () => {
    const { container } = mount(
      <ProjectsTrustScreen spaceLabel="space · atelier" projects={{ phase: 'ready', value: [] }} />,
    );
    const unread = container.querySelector('[data-testid="unread-region"]');
    expect(unread?.textContent).toContain(GOVERNANCE_REASONS.registryRead.cause);
    // And the SPACE-side empty list is a measured empty — a different fact,
    // rendered differently. Collapsing the two is the defect.
    expect(container.querySelector('[data-testid="empty-region"]')?.textContent).toContain(
      'No projects are linked',
    );
    // The empty state is ACTIONABLE: the refusal to link here is honest, but it
    // names the real way — the CLI — instead of dead-ending.
    expect(container.querySelector('[data-testid="empty-region"]')?.textContent).toContain(
      'tm8 project link',
    );
  });

  it('distinguishes loading from failed from empty', () => {
    const loading = mount(
      <ProjectsTrustScreen spaceLabel="s" projects={{ phase: 'loading' }} />,
    );
    expect(loading.container.querySelector('[data-testid="loading-region"]')).not.toBeNull();

    const failed = mount(
      <ProjectsTrustScreen spaceLabel="s" projects={{ phase: 'failed', message: 'network refused' }} />,
    );
    expect(failed.container.textContent).toContain('network refused');
  });
});

// ---------------------------------------------------------------------------
// T2-2c · the consent moment — the one wireable control in the frame
// ---------------------------------------------------------------------------

describe('the untrusted-run consent moment', () => {
  const request = { actorLabel: 'scout', projectLabel: 'vendor-scripts', projectId: 'proj-9' };

  it('collapses to one honest line when nothing is pending', () => {
    const { container } = mount(<UntrustedConsentCard request={null} />);
    expect(container.querySelector('[data-testid="consent-idle"]')).not.toBeNull();
    expect(container.textContent).toContain('Nothing is waiting on consent');
  });

  it('states the CONSEQUENCE before the choice, in the oracle’s order', () => {
    const { container } = mount(<UntrustedConsentCard request={request} onDecision={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Run scout in an untrusted project?');
    expect(text).toContain('read, write and execute anything in it');
    expect(text).toContain('this run is on you, not the space’s trust policy');
    // The verb NAMES the risk. "OK" would be the defect.
    expect(text).toContain('Run untrusted');
  });

  it('refuses to confirm until the risk is acknowledged — the tick IS the consent', () => {
    const decisions: unknown[] = [];
    const { container, getByLabelText } = mount(
      <UntrustedConsentCard request={request} onDecision={(d) => decisions.push(d)} />,
    );
    const confirm = () => within(container).getByText('Run untrusted ▸');
    expect(confirm().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(confirm());
    expect(decisions, 'an unchecked confirm must not produce a decision').toEqual([]);

    fireEvent.click(getByLabelText('I understand the risk'));
    fireEvent.click(confirm());
    expect(decisions).toEqual([{ consented: true, confirmUntrusted: true, projectId: 'proj-9' }]);
  });

  it('carries the CONTRACT’s own consent member, not an invented flag', () => {
    const decisions: { confirmUntrusted?: true }[] = [];
    const { container, getByLabelText } = mount(
      <UntrustedConsentCard request={request} onDecision={(d) => decisions.push(d as never)} />,
    );
    fireEvent.click(getByLabelText('I understand the risk'));
    fireEvent.click(within(container).getByText('Run untrusted ▸'));
    // `confirmUntrusted?: true` is ExecutionSpawnInput's member (contract.ts:1046):
    // this decision is spawnable as-is, which is why the card is wireable today.
    expect(decisions[0]?.confirmUntrusted).toBe(true);
  });

  it('refuses BOTH buttons when the host wired no decision handler', () => {
    const { container } = mount(<UntrustedConsentCard request={request} />);
    const enabled = [...container.querySelectorAll('button')].filter(
      (b) => b.getAttribute('aria-disabled') !== 'true' && b.getAttribute('type') === 'button',
    );
    expect(enabled).toEqual([]);
    expect(reasonTexts(container).join(' ')).toContain('nowhere to send the decision');
  });
});

// ---------------------------------------------------------------------------
// T2-2d · association vs provenance
// ---------------------------------------------------------------------------

describe('session projects — association is not provenance', () => {
  const withBoth: SessionProjects = {
    launchedFrom: known({ projectId: 'proj-1', label: 'tm8-ui', workingDir: known('/home/ada/work/tm8') }),
    associations: known([{ id: 'a1', label: 'tm8-ui' }, { id: 'a2', label: 'docs-site' }]),
  };

  it('renders the launch root as an immutable line with NO remove control', () => {
    const { container } = mount(<SessionProjectsCard projects={withBoth} />);
    const provenance = container.querySelector('.gov-provenance') as HTMLElement;
    expect(provenance.textContent).toContain('launched from');
    expect(provenance.textContent).toContain('immutable');
    // The law, structurally: the provenance region contains no control at all.
    expect(provenance.querySelectorAll('button, [role="button"]')).toHaveLength(0);
  });

  it('labels a scratch session rather than leaving it blank', () => {
    const { container } = mount(
      <SessionProjectsCard
        projects={{ launchedFrom: known(null), associations: known([]) }}
      />,
    );
    expect(container.textContent).toContain('sandboxed · no project');
  });

  it('keeps “no associations” distinct from “associations unread”', () => {
    const measured = mount(
      <SessionProjectsCard projects={{ launchedFrom: known(null), associations: known([]) }} />,
    );
    expect(measured.container.textContent).toContain('no project associations');

    const unread = mount(
      <SessionProjectsCard
        projects={{
          launchedFrom: known(null),
          associations: unknown(GOVERNANCE_REASONS.associateProject),
        }}
      />,
    );
    expect(unread.container.textContent).toContain('associations unread');
  });
});

// ---------------------------------------------------------------------------
// T2-4 · interaction profiles
// ---------------------------------------------------------------------------

describe('T2-4 — interaction profiles', () => {
  const profile = (id: string, status: string, activeVersion: number | null = null) =>
    summary({
      id,
      title: id,
      state: { status, currentDraftVersion: 1, activeVersion } as never,
    });

  const profiles = [
    profile('forge-default', 'active', 3),
    profile('careful-reviewer', 'active', 1),
    profile('terse-worker', 'draft'),
  ];

  it('renders every lifecycle group, empty ones included, with measured counts', () => {
    const { container } = mount(
      <InteractionProfilesScreen spaceLabel="space · atelier" profiles={{ phase: 'ready', value: profiles }} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('ACTIVE · 2');
    expect(text).toContain('DRAFT · 1');
    // The empty group still teaches that the state exists — a MEASURED zero.
    expect(text).toContain('RETIRED · 0');
    expect(text).toContain('none in this state');
  });

  it('leaves run counts and defaults hollow rather than claiming zero', () => {
    const { container } = mount(
      <InteractionProfilesScreen spaceLabel="s" profiles={{ phase: 'ready', value: profiles }} />,
    );
    const row = container.querySelector('[data-testid="profile-row"]') as HTMLElement;
    expect(row.textContent).toContain('defaults unread');
    expect(row.textContent).not.toContain('0 runs');
    expect(row.textContent).toContain('v3');
  });

  it('shows the outranked default beside the winner, never instead of it', () => {
    const { container } = mount(
      <InteractionProfilesScreen
        spaceLabel="s"
        profiles={{ phase: 'ready', value: [profile('forge-default', 'active', 3)] }}
        defaultsFor={() => [
          { scope: 'space', label: 'space · atelier' },
          { scope: 'teammate', label: 'scout’s default' },
        ]}
      />,
    );
    const row = container.querySelector('[data-testid="profile-row"]') as HTMLElement;
    expect(row.textContent).toContain('scout’s default');
    expect(row.textContent).toContain('space · atelier');
  });

  it('refuses every lifecycle verb with the mechanism named', () => {
    const { container } = mount(
      <InteractionProfilesScreen spaceLabel="s" profiles={{ phase: 'ready', value: profiles }} />,
    );
    const reasons = reasonTexts(container).join(' ');
    for (const verb of ['New', 'Duplicate as draft', 'Retire', 'Set default', 'Link', 'Add child']) {
      expect(container.textContent, `“${verb}” must be drawn`).toContain(verb);
    }
    expect(reasons).toContain('no interaction-profile command');
    // The oracle's own restricted-kind sentences, kept verbatim.
    expect(reasons).toContain('Profiles are restricted — no free linking');
    expect(reasons).toContain('Profiles don’t take children');
  });

  it('refuses to open a row when the host wired no opener, instead of doing nothing', () => {
    const { container } = mount(
      <InteractionProfilesScreen spaceLabel="s" profiles={{ phase: 'ready', value: profiles }} />,
    );
    const row = container.querySelector('[data-testid="profile-row"]') as HTMLElement;
    expect(reasonTexts(row).join(' ')).toContain('onOpenProfile');
  });

  it('opens the row through the host when one IS wired', () => {
    const opened: string[] = [];
    const { container } = mount(
      <InteractionProfilesScreen
        spaceLabel="s"
        profiles={{ phase: 'ready', value: profiles }}
        onOpenProfile={(id) => opened.push(id)}
      />,
    );
    fireEvent.click(within(container).getByText('forge-default'));
    expect(opened).toEqual(['forge-default']);
  });
});

// ---------------------------------------------------------------------------
// T2-5 · custom-kind authoring
// ---------------------------------------------------------------------------

describe('T2-5 — custom-kind authoring', () => {
  const kindDef = (over: Partial<EntityKindDef>): EntityKindDef =>
    ({
      id: 'k1',
      kind: 'c:ritual',
      origin: 'custom',
      spaceId: 'space-1',
      fieldSchema: [],
      capabilities: {},
      createdAt: '2026-07-29T00:00:00Z',
      ...over,
    }) as EntityKindDef;

  const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

  it('is a REAL form: typing, glyph choice and fields all change state', () => {
    const { container, getByLabelText, getAllByTestId } = mount(
      <CustomKindsScreen spaceLabel="space · atelier" kinds={{ phase: 'ready', value: [] }} />,
    );
    const nameInput = container.querySelector('input') as HTMLInputElement;
    type(nameInput, 'incident');
    expect(nameInput.value).toBe('incident');

    fireEvent.click(getByLabelText('Glyph ◮'));
    expect(getByLabelText('Glyph ◮').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(container).getByText('＋ field'));
    fireEvent.click(within(container).getByText('＋ field'));
    expect(getAllByTestId('field-row')).toHaveLength(2);
  });

  it('validates against the REAL registry — a reserved route word is refused', () => {
    const { container } = mount(
      <CustomKindsScreen spaceLabel="s" kinds={{ phase: 'ready', value: [] }} />,
    );
    type(container.querySelector('input') as HTMLElement, 'settings');
    expect(container.querySelector('[data-testid="draft-issues"]')?.textContent).toContain('reserved');
  });

  it('refuses a kind the space already defines, from the real entityKinds read', () => {
    const { container } = mount(
      <CustomKindsScreen spaceLabel="s" kinds={{ phase: 'ready', value: [kindDef({ kind: 'c:incident' })] }} />,
    );
    type(container.querySelector('input') as HTMLElement, 'incident');
    expect(container.textContent).toContain('already defines c:incident');
  });

  it('composes the payload only for a valid draft, and shows it', () => {
    const { container, getByLabelText } = mount(
      <CustomKindsScreen spaceLabel="s" kinds={{ phase: 'ready', value: [] }} />,
    );
    const inputs = container.querySelectorAll('input');
    type(inputs[0] as HTMLElement, 'incident');
    type(inputs[1] as HTMLElement, 'Incidents');
    fireEvent.click(getByLabelText('Glyph ◮'));
    const payload = container.querySelector('[data-testid="payload-card"]') as HTMLElement;
    expect(payload.textContent).toContain('"kind": "c:incident"');
    expect(payload.textContent).toContain('"icon": "◮"');
    // …and the commit is still refused, for the one honest reason.
    expect(payload.textContent).toContain(GOVERNANCE_REASONS.createKind.cause);
  });

  it('tells the truth about the mark: the registry paints the FALLBACK ARTWORK, not the glyph you picked', () => {
    const { container, getByLabelText } = mount(
      <CustomKindsScreen spaceLabel="s" kinds={{ phase: 'ready', value: [] }} />,
    );
    type(container.querySelector('input') as HTMLElement, 'incident');
    fireEvent.click(getByLabelText('Glyph ◮'));
    const verdict = container.querySelector('[data-testid="registry-verdict"]') as HTMLElement;
    // The finding this screen surfaces, asserted so it cannot be quietly lost:
    // the authored glyph is stored and unread; the fallback row is what paints.
    // It is asserted on the DRAWN mark now. The old assertion looked for the
    // character `◇` in the verdict's text, and that stopped being what the app
    // paints the moment kinds got artwork — a text-content check would have
    // gone on passing against a `◇` that no surface renders any more, which is
    // the exact species of lie this screen exists to prevent.
    const drawn = verdict.querySelector('svg.kit-vicon');
    expect(drawn).not.toBeNull();
    const paths = [...drawn!.querySelectorAll('path')].map((el) => el.getAttribute('d'));
    expect(paths).toEqual([...getKind(CUSTOM_KIND_FALLBACK).iconArt]);
    // The authored glyph is still NAMED — as the thing that does not paint.
    expect(verdict.textContent).toContain('NOT the ◮ you picked');
    expect(verdict.textContent).toContain('no consumer reads it yet');
    expect(verdict.textContent).toContain('k/c-incident');
  });

  it('reorders a field from the keyboard — the ⠿ handle is a control, not a cursor', () => {
    const { container, getAllByTestId } = mount(
      <CustomKindsScreen spaceLabel="s" kinds={{ phase: 'ready', value: [] }} />,
    );
    fireEvent.click(within(container).getByText('＋ field'));
    fireEvent.click(within(container).getByText('＋ field'));
    const rows = () => getAllByTestId('field-row');
    type(rows()[0]!.querySelector('input') as HTMLElement, 'severity');
    type(rows()[1]!.querySelector('input') as HTMLElement, 'service');

    const secondHandle = rows()[1]!.querySelector('.gov-handle') as HTMLElement;
    fireEvent.keyDown(secondHandle, { key: 'ArrowUp' });
    expect((rows()[0]!.querySelector('input') as HTMLInputElement).value).toBe('service');
  });

  it('renders existing kinds raw, and states the fallback rather than hiding it', () => {
    const { container } = mount(
      <CustomKindsScreen
        spaceLabel="s"
        kinds={{
          phase: 'ready',
          value: [
            kindDef({
              kind: 'c:ritual',
              fieldSchema: [{ name: 'cadence', type: 'text', required: true }],
            }),
          ],
        }}
      />,
    );
    const row = container.querySelector('[data-testid="existing-kind-row"]') as HTMLElement;
    expect(row.textContent).toContain('c:ritual');
    expect(row.textContent).toContain('cadence: text (req)');
    expect(container.textContent).toContain('only typed rendering is missing');
  });

  it('says the space defines none rather than rendering a bare list', () => {
    const { container } = mount(
      <CustomKindsScreen spaceLabel="s" kinds={{ phase: 'ready', value: [] }} />,
    );
    expect(container.querySelector('[data-testid="empty-region"]')?.textContent).toContain(
      'no custom kinds',
    );
  });
});
