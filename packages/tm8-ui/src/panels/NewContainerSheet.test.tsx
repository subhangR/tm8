// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { ContainersCreateInputSchema } from '@tm8/contract';
import type { ContainersCreateInput, SpaceId } from '@tm8/contract';
import {
  NEW_CONTAINER_DEFAULTS,
  NewContainerSheet,
  buildContainersCreateInput,
} from './NewContainerSheet';

/**
 * THE BIRTH FLOW — it must build a `ContainersCreateInput` VERBATIM.
 *
 * THE PAYLOAD IS VALIDATED AGAINST THE CONTRACT'S OWN ZOD SCHEMA, not against
 * a shape written here. `ContainersCreateInputSchema` is `.strict()`, which is
 * what makes this a real test rather than a restatement: a field the sheet
 * invents, misspells, or sends as `null` where the server expects it absent is
 * a parse failure here, exactly as it would be a 400 there. Asserting against
 * a locally-written expected object would pass while the wire shape was wrong.
 *
 * THE BUILDER IS PURE AND IS TESTED AS SUCH. The acceptance criterion is about
 * the PAYLOAD; driving it through a rendered form would test the form's labels
 * as much as the DTO. The component tests below cover the form's own
 * behaviour — which is a different question.
 */

const SPACE = 'sp-atelier' as SpaceId;
const CMID = 'containers.create:test-1';

function build(over: Partial<typeof NEW_CONTAINER_DEFAULTS> = {}): ContainersCreateInput {
  return buildContainersCreateInput(
    { ...NEW_CONTAINER_DEFAULTS, ...over },
    { spaceId: SPACE, clientMutationId: CMID },
  );
}

describe('buildContainersCreateInput → the contract DTO', () => {
  it('the default draft parses against the strict contract schema', () => {
    const parsed = ContainersCreateInputSchema.safeParse(build());
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('every draft the form can produce parses — not just the default one', () => {
    // The form's whole reachable space, walked. A field that only breaks on a
    // non-default combination is the one a single happy-path test misses.
    for (const profile of ['shell', 'desktop', 'browser', 'dind'] as const) {
      for (const network of ['locked', 'balanced', 'open'] as const) {
        for (const persistent of [true, false]) {
          const input = build({ profile, network, persistent, title: 'build box', projectId: 'ent-prj-1' });
          const parsed = ContainersCreateInputSchema.safeParse(input);
          expect(parsed.success, `${profile}/${network}/${String(persistent)}`).toBe(true);
        }
      }
    }
  });

  it('carries the profile, the space and the caller’s mutation id verbatim', () => {
    const input = build({ profile: 'browser' });
    expect(input.profile).toBe('browser');
    expect(input.spaceId).toBe(SPACE);
    expect(input.clientMutationId).toBe(CMID);
  });

  it('the mutation id is the CALLER’S, so a replay returns the first container', () => {
    /*
     * `containers.create` is ledgered (`internal.ledger_replay`) and a replay
     * with the same id returns the FIRST result. A builder that minted its own
     * id would make that unreachable — a double submit would be two machines —
     * so passing the same draft twice with one id must produce one id.
     */
    expect(build().clientMutationId).toBe(build().clientMutationId);
  });

  it('OMITS an empty title rather than sending the empty string', () => {
    // `title: ''` would name a container the empty string. Absent means "no
    // title" and is a different instruction — the schema is `.strict()`, so
    // the distinction is real on the wire.
    expect('title' in build({ title: '   ' })).toBe(false);
    expect(build({ title: '  build box  ' }).title).toBe('build box');
  });

  it('SENDS a null provider, because null is meaningful there', () => {
    // Unlike `title`, `provider: null` is an instruction: "the node picks the
    // best provider satisfying policy". Omitting it would be the same request
    // by luck rather than by statement.
    expect(build().provider).toBeNull();
    expect(build({ provider: 'fake' }).provider).toBe('fake');
  });

  it('maps the form’s "persistent" to the wire’s `ephemeral`, inverted', () => {
    // The form asks "keep it afterwards"; the contract records the opposite
    // fact. Getting this backwards ships a machine that deletes itself.
    expect(build({ persistent: true }).lifecycle?.ephemeral).toBe(false);
    expect(build({ persistent: false }).lifecycle?.ephemeral).toBe(true);
  });

  it('starts the container: `start` is TRUE and is stated, not defaulted', () => {
    // The contract defaults it true and the form offers no control. Pinning it
    // here is what stops the default moving underneath the sheet silently.
    expect(build().start).toBe(true);
  });

  it('omits `projectId` when none is chosen, and sends it when one is', () => {
    expect('projectId' in build()).toBe(false);
    expect(build({ projectId: 'ent-prj-1' }).projectId).toBe('ent-prj-1');
  });

  it('sends `confirmUntrusted` ONLY when confirmed — never as false', () => {
    // The contract types it `true` (not `boolean`): the field's presence IS
    // the confirmation, so a `false` would be a schema violation rather than
    // a polite "not confirmed".
    expect('confirmUntrusted' in build()).toBe(false);
    expect(build({ confirmUntrusted: true }).confirmUntrusted).toBe(true);
  });

  it('carries NO env, ever — secrets do not travel this way (§12.3)', () => {
    // The form has no env field by design, and this is the assertion that
    // keeps someone from adding one for convenience.
    expect(build().spec?.env).toBeUndefined();
  });

  it('sends no mounts, so no host path can be built here (ruling R5)', () => {
    // P0 mounts a project by ID and lets the node resolve the working dir —
    // the one form of "mount something" that needs no client-held host path.
    expect(build({ projectId: 'ent-prj-1' }).spec?.mounts).toBeUndefined();
  });
});

describe('the sheet itself', () => {
  it('commits the built input through onCreate', async () => {
    const onCreate = vi.fn();
    const { getByText, getByTestId } = render(
      <NewContainerSheet spaceId={SPACE} onCreate={onCreate} mutationId={() => CMID} />,
    );
    fireEvent.click(getByText('Create container'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const sent = onCreate.mock.calls[0]![0] as ContainersCreateInput;
    expect(ContainersCreateInputSchema.safeParse(sent).success).toBe(true);
    expect(sent.profile).toBe('shell');
    expect(getByTestId('new-container-sheet')).toBeTruthy();
  });

  it('selecting a profile changes what is sent', async () => {
    const onCreate = vi.fn();
    const { getByText } = render(
      <NewContainerSheet spaceId={SPACE} onCreate={onCreate} mutationId={() => CMID} />,
    );
    fireEvent.click(getByText('Browser'));
    fireEvent.click(getByText('Create container'));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect((onCreate.mock.calls[0]![0] as ContainersCreateInput).profile).toBe('browser');
  });

  it('marks the selected card in the DOM, since no vitest here sees the tint', () => {
    // The stylesheet colours `[data-selected='yes']`, and jsdom loads no
    // stylesheets — so the attribute has to carry the meaning on its own or
    // selection is untestable in this package.
    const { getByText } = render(<NewContainerSheet spaceId={SPACE} onCreate={vi.fn()} />);
    const shell = getByText('Shell').closest('button')!;
    expect(shell.getAttribute('data-selected')).toBe('yes');
    expect(shell.getAttribute('aria-checked')).toBe('true');
  });

  it('with no onCreate the control is DISABLED WITH A REASON, never inert', () => {
    // A node with TM8_CONTAINERS=off answers 501 for every runtime op. That
    // refusal has to be visible: an enabled button that does nothing is the
    // failure mode this package's honesty rules exist to prevent.
    const { getByTestId, container } = render(<NewContainerSheet spaceId={SPACE} />);
    /*
     * `DisabledAction` renders a `<span role="button" aria-disabled="true">`,
     * NOT a `<button disabled>` — so the assertion is on `aria-disabled` and on
     * the absence of a real submit control. Checking `queryByRole('button')`
     * would find the refusal itself and read it as a live control, which is the
     * mistake this comment exists to stop the next reader repeating.
     */
    const refusal = getByTestId('disabled-with-reason');
    expect(refusal.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    // The reason is REACHABLE, not merely present — a refusal nobody can read
    // is the same as no refusal.
    expect(container.textContent).toContain('not_implemented');
  });

  it('refuses to commit while an untrusted project is unconfirmed', async () => {
    /*
     * The same gate a spawn applies. The server refuses without the confirm,
     * so the button must refuse first — a click that discovers a refusal the
     * form could have stated is a round trip spent on a known answer.
     */
    const onCreate = vi.fn();
    const { getByTestId, container } = render(
      <NewContainerSheet
        spaceId={SPACE}
        onCreate={onCreate}
        projects={[{ id: 'ent-prj-1', title: 'tm8', trusted: false }]}
      />,
    );
    fireEvent.change(container.querySelector('select')!, { target: { value: 'ent-prj-1' } });
    // Same shape as above: the submit control is GONE and a refusal stands in
    // its place, naming the untrusted project rather than a generic failure.
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(getByTestId('disabled-with-reason').getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('not marked trusted');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('commits once the untrusted project is confirmed, and says so on the wire', async () => {
    const onCreate = vi.fn();
    const { getByText, container } = render(
      <NewContainerSheet
        spaceId={SPACE}
        onCreate={onCreate}
        mutationId={() => CMID}
        projects={[{ id: 'ent-prj-1', title: 'tm8', trusted: false }]}
      />,
    );
    fireEvent.change(container.querySelector('select')!, { target: { value: 'ent-prj-1' } });
    fireEvent.click(container.querySelector('input[type="checkbox"]')!);
    fireEvent.click(getByText('Create container'));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    const sent = onCreate.mock.calls[0]![0] as ContainersCreateInput;
    expect(sent.confirmUntrusted).toBe(true);
    expect(sent.projectId).toBe('ent-prj-1');
    expect(ContainersCreateInputSchema.safeParse(sent).success).toBe(true);
  });
});
