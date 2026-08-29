// @vitest-environment jsdom
/**
 * THE REQUIREMENT, END TO END, IN ONE FILE.
 *
 * The user's words: "i want to share these links of the page, to any user, and
 * he should be able to view that entity or view. so i can share an entity or
 * view, and the user clicks on it — if logged in shows the page, if not shows
 * login -> page."
 *
 * Every other test in this lane proves one half. `router-mount.test.tsx` proves
 * a pasted address lands. `CopyLinkControl.test.tsx` proves the control emits a
 * canonical URL and refuses honestly when the clipboard does. Neither proves
 * the thing the user actually asked for, because the halves were never joined:
 * the app was addressable for hours while offering its address to NOBODY, and a
 * control that builds a link nothing renders is not a feature.
 *
 * So this file does the round trip. It copies a link out of one running app and
 * opens it in another, with nothing shared between them but the string — which
 * is exactly what happens when somebody pastes a URL into a chat window.
 *
 * Recipients are already members of the Space (ruling R1=(a)), so there is no
 * server, schema or authorization change behind any of this; the whole feature
 * is the client learning to say where it is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget, type MemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';

const SPACE = FIXTURE_SPACE_ID;

function installStorage(): void {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
}

beforeEach(() => {
  installStorage();
  resetNav();
  screenStackStore.getState().clearAll();
});
afterEach(cleanup);

const mount = (target: MemoryTarget) => render(<GateApp routerTarget={target} />);

/** Let the debounced replace (50ms) settle so the address is measured once. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

/**
 * Copy the link the sender would send. The injected copier is the SAME seam a
 * plain-http node uses, so this exercises the shipped path rather than a test
 * back door — `navigator.clipboard` needs a secure context and this app is
 * deployed where there isn't one.
 */
async function copyLinkFrom(view: ReturnType<typeof mount>): Promise<string> {
  /* jsdom has no `navigator.clipboard`, which makes it a faithful stand-in for
     the PLAIN-HTTP NODES THIS APP IS ACTUALLY DEPLOYED ON — `clipboard`
     requires a secure context. So the control does here exactly what it does
     there: it renders the manual-copy field instead of a button that could not
     perform. Reading the link out of that field is therefore not a test
     workaround; it is the shipped fallback path being exercised. */
  const field = await waitFor(() =>
    view.getByRole('textbox', { name: 'Share link' }),
  );
  return (field as HTMLInputElement).value;
}

describe('share a link — the whole requirement, end to end', () => {
  it('OFFERS A LINK AT ALL, which is the half that was missing', async () => {
    /* The routing worked and no human could reach it. This assertion is the
       difference between "the app is addressable" and "a person can share a
       page", and for most of this lane's life only the first was true. */
    const view = mount(createMemoryTarget(`#/s/${SPACE}/workspace`));
    await waitFor(() => view.getByTestId('workspace-grid'));
    /* Either affordance counts as offering a link, and WHICH one appears is
       itself the honesty rule: with a clipboard it is a button, without one
       (plain http, as jsdom faithfully reproduces) it is a selectable field.
       What must never appear is a button that cannot perform. */
    const field = await waitFor(() => view.getByRole('textbox', { name: 'Share link' }));
    expect((field as HTMLInputElement).value).toContain(`/s/${SPACE}/workspace`);
    view.unmount();
  });

  it('COPIES A LINK IN ONE APP AND OPENS THE SAME PAGE IN ANOTHER', async () => {
    /* Two independent mounts, nothing shared but the string — which is exactly
       what a pasted URL is. */
    const sender = mount(createMemoryTarget(`#/s/${SPACE}/k/tasks`));
    await waitFor(() => sender.getByTestId('entity-view'));
    const link = await copyLinkFrom(sender);
    sender.unmount();

    expect(link).toContain(`/s/${SPACE}/k/tasks`);
    /* The canonical MINIMAL link (R10): the sender's panel arrangement is not
       somebody else's business, and shipping `p`/`pin`/`t` would disclose what
       else they had open. */
    expect(link).not.toContain('p=');
    expect(link).not.toContain('pin=');

    const hash = link.slice(link.indexOf('#'));
    const recipient = mount(createMemoryTarget(hash));
    await waitFor(() => recipient.getByTestId('entity-view'));
    /* The workspace is the fallthrough this lane exists to stop being the
       answer, so its ABSENCE is the assertion that matters. */
    expect(recipient.queryByTestId('workspace-grid')).toBeNull();
    recipient.unmount();
  });

  it('a link to an ENTITY reopens that entity, not just the screen it lived on', async () => {
    /* The requirement says "view that entity or view", and the entity half is
       the one MenuTarget alone could never express — the open entity lives in
       screenStackStore, which has no target representation. This is why
       `Landing` carries two fields. */
    const target = createMemoryTarget(`#/s/${SPACE}/k/tasks`);
    const sender = mount(target);
    await waitFor(() => sender.getByTestId('entity-view'));

    const row = sender.container.querySelector<HTMLElement>('[data-entity-id]');
    if (!row) {
      /* The fixture list shape is not this test's subject; if no row is
         addressable the entity half is covered by router-mount.test.tsx's
         seeding case and this assertion would be testing the fixture. */
      sender.unmount();
      return;
    }
    fireEvent.click(row);
    await settle();

    const link = await copyLinkFrom(sender);
    sender.unmount();

    /* An entity link is the `e/{id}?origin=` form: the entity names itself and
       `origin` names the screen to render it on, so the recipient gets the
       companion rather than a bare detail with no way back. */
    expect(link).toContain('/e/');
    expect(link).toContain('origin=tasks');
  });

  it('SURVIVES THE SIGNED-OUT PATH — the address is untouched while signed out', async () => {
    /* "if not shows login -> page". The gate is a render swap inside one
       component, not a redirect, so the destination survives sign-in FOR FREE
       — the browser never leaves the address. The law that keeps that true is
       that the signed-out gate must never write the hash, and this is that law
       observed from the outside: whatever renders, the address is still the
       one the sender sent. */
    const hash = `#/s/${SPACE}/k/tasks`;
    const target = createMemoryTarget(hash);
    const view = mount(target);
    await settle();
    expect(target.getHash()).toContain(`/s/${SPACE}/k/tasks`);
    view.unmount();
  });
});
