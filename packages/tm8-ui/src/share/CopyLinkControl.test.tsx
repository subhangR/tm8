// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, SpaceId } from '@tm8/contract';
import { CopyLinkControl, copyLinkUrl } from './CopyLinkControl';

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
  it('prefers the injected copier and confirms the copy', () => {
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
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('falls back to navigator.clipboard when the host injects no copier', () => {
    const writeText = vi.fn();
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
