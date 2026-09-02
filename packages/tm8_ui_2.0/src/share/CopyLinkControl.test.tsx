// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, SpaceId } from '@tm8/contract';
import { CopyLinkControl, SPACE_LINK_HINT, copyLinkUrl } from './CopyLinkControl';

const SPACE = 'space/a' as SpaceId;
const ENTITY = 'entity.1' as EntityId;
const BASE = 'https://tm8.example/app/';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyLinkUrl', () => {
  it('uses the codec for a canonical minimal entity link with its origin', () => {
    expect(
      copyLinkUrl({
        spaceId: SPACE,
        target: { type: 'kind', ref: 'task', mode: 'board' },
        openEntity: ENTITY,
        appBaseUrl: BASE,
      }),
    ).toBe('https://tm8.example/app/#/s/space%2Fa/e/entity%2E1?origin=tasks.board');
  });

  it('uses the dedicated channel route for a channel target', () => {
    expect(
      copyLinkUrl({
        spaceId: SPACE,
        target: { type: 'entity', ref: ENTITY, kind: 'channel' },
        appBaseUrl: BASE,
      }),
    ).toBe('https://tm8.example/app/#/s/space%2Fa/channel/entity%2E1');
  });

  it('refuses a target the route registry cannot address', () => {
    expect(
      copyLinkUrl({
        spaceId: SPACE,
        target: { type: 'kind', ref: 'message' },
        appBaseUrl: BASE,
      }),
    ).toBeNull();
  });
});

describe('CopyLinkControl', () => {
  it('prefers the injected copier and confirms the copy', async () => {
    const onCopy = vi.fn();
    render(
      <CopyLinkControl
        spaceId={SPACE}
        target={{ type: 'view', ref: 'feed' }}
        onCopy={onCopy}
        appBaseUrl={BASE}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(onCopy).toHaveBeenCalledWith('https://tm8.example/app/#/s/space%2Fa/feed');
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('falls back to navigator.clipboard when the host injects no copier', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <CopyLinkControl
        spaceId={SPACE}
        target={{ type: 'view', ref: 'workspace' }}
        appBaseUrl={BASE}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('https://tm8.example/app/#/s/space%2Fa/workspace');
  });

  it('does not claim success when the clipboard rejects and reaches manual copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Clipboard denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <CopyLinkControl
        spaceId={SPACE}
        target={{ type: 'view', ref: 'workspace' }}
        appBaseUrl={BASE}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    const field = await screen.findByRole('textbox', { name: 'Share link' });
    /* Plain `.value`, not `toHaveValue`: this suite does not load the jest-dom
       matchers, so `toHaveValue` is not a matcher here — it is an unknown Chai
       property, and asserting through it fails the test for a reason that has
       nothing to do with the behaviour under test. */
    expect((field as HTMLInputElement).value).toBe(
      'https://tm8.example/app/#/s/space%2Fa/workspace',
    );
    expect(screen.queryByText('Copied')).toBeNull();
    expect(screen.queryByText('Link copied')).toBeNull();
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  });

  it('continues from a rejecting async host copier to the browser clipboard', async () => {
    const onCopy = vi.fn().mockRejectedValue(new Error('Host bridge unavailable'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <CopyLinkControl
        spaceId={SPACE}
        target={{ type: 'view', ref: 'feed' }}
        onCopy={onCopy}
        appBaseUrl={BASE}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('https://tm8.example/app/#/s/space%2Fa/feed');
  });

  it('renders a selectable manual-copy field when no clipboard exists', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(
      <CopyLinkControl
        spaceId={SPACE}
        target={{ type: 'view', ref: 'inbox' }}
        appBaseUrl={BASE}
      />,
    );

    const field = screen.getByRole('textbox', { name: 'Share link' }) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe('https://tm8.example/app/#/s/space%2Fa/inbox');
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('says on hover WHAT THE LINK EXPOSES — the space, not just the page', () => {
    /* User-ordered 2026-08-31: "when they hover over copy link give
       information that they are sharing the space". Before this the control
       carried no title at all, so hovering taught a person nothing about the
       consequence of pasting the link somewhere.

       The assertions are on the CLAIMS the wording has to make, not on the
       sentence — the words may be edited, but a version that stops naming the
       space, stops saying what the recipient sees, or starts promising access
       the link cannot grant is a different (and, in the last case, false)
       message and should fail here. */
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <CopyLinkControl spaceId={SPACE} target={{ type: 'view', ref: 'feed' }} appBaseUrl={BASE} />,
    );

    const title = screen.getByRole('button', { name: 'Copy link' }).getAttribute('title') ?? '';
    expect(title).toBe(SPACE_LINK_HINT);
    // 1. it names the SPACE as the thing being shared
    expect(title).toMatch(/this space/i);
    // 2. it says what the recipient will be able to see
    expect(title).toMatch(/conversations|people|work/i);
    // 3. it does not promise access the link cannot grant (R1=(a): recipients
    //    are already members; the codec authorizes nobody)
    expect(title).toMatch(/sign in|already in this space/i);
    // 4. customer language — no mechanism words
    expect(title).not.toMatch(/entity|target|route|codec|URL|hash/i);
  });

  it('carries the same hover text on the manual-copy fallback', () => {
    /* The plain-http path is the one most viewers actually get (clipboard
       needs a secure context), so it must not be the path with no warning. */
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { container } = render(
      <CopyLinkControl spaceId={SPACE} target={{ type: 'view', ref: 'feed' }} appBaseUrl={BASE} />,
    );
    expect(container.querySelector('.copy-link--manual')?.getAttribute('title')).toBe(
      SPACE_LINK_HINT,
    );
  });

  it('wears the host’s row class when a host hangs it in its own chrome', () => {
    /* The account menu passes `auth-menu__row` so a hosted row and a
       menu-owned row sit on one grid (2026-08-31). Asserted here because the
       class is the whole seam: without it the control keeps bar-chip clothes
       inside a menu. */
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <CopyLinkControl
        spaceId={SPACE}
        target={{ type: 'view', ref: 'feed' }}
        appBaseUrl={BASE}
        className="auth-menu__row auth-menu__row--live"
      />,
    );
    const button = screen.getByRole('button', { name: 'Copy link' });
    expect(button.classList.contains('auth-menu__row')).toBe(true);
    expect(button.classList.contains('copy-link__button')).toBe(true);
  });

  it('renders disabled-with-reason for an unaddressable destination', () => {
    render(
      <CopyLinkControl
        spaceId={SPACE}
        target={{ type: 'kind', ref: 'message' }}
        appBaseUrl={BASE}
      />,
    );

    expect(screen.getByTestId('disabled-with-reason').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/route registry does not address/)).toBeTruthy();
  });
});
