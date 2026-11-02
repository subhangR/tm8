// @vitest-environment jsdom
/**
 * Two reloads in flight: the slot shown is the NEWER read's, even when the
 * older one lands last (a submit's re-read racing an event's).
 */
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createFixtureFormsPort } from './fixture-port';
import { FORM_FIXTURE_FORMS, FORM_FIXTURE_IDS, FORM_FIXTURE_RESPONSES } from './fixtures';
import { FormsPortProvider, type FormsPort, type MyFormSlot } from './seam';
import { useQuestionnaire } from './useQuestionnaire';

const release = FORM_FIXTURE_FORMS.find((f) => f.id === FORM_FIXTURE_IDS.release)!;
const detail = { id: release.id, title: release.title, version: release.version, content: { kind: 'form', ...release.content } };

describe('useQuestionnaire reload order', () => {
  it('an older slot read landing after a newer one does not replace it', async () => {
    const base = createFixtureFormsPort({ now: () => '2026-09-30T00:00:00.000Z' });
    const pending: Array<(slot: MyFormSlot) => void> = [];
    const port: FormsPort = { ...base, mine: () => new Promise<MyFormSlot>((resolve) => pending.push(resolve)) };
    const wrapper = ({ children }: { children?: ReactNode }) => <FormsPortProvider port={port}>{children}</FormsPortProvider>;
    const { result } = renderHook(() => useQuestionnaire(detail as never), { wrapper });

    const submitted = FORM_FIXTURE_RESPONSES[0]!;
    await act(async () => { void result.current.reload(); });
    expect(pending).toHaveLength(2);
    // The newer read (after the submit) lands first, the mount's read last.
    await act(async () => { pending[1]!({ current: submitted, draft: null, history: [submitted] }); });
    await act(async () => { pending[0]!({ current: null, draft: null, history: [] }); });

    expect(result.current.mine?.current?.id).toBe(submitted.id);
  });
});
