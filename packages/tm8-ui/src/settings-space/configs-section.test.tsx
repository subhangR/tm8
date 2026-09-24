// @vitest-environment jsdom
/**
 * Settings → Configs draws what `spaces.configs` answers and nothing else:
 * grouped knobs with value, source, default and definition; a secret as
 * presence only; the server's own reason when node env is withheld.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ConfigKnobView, SpaceConfigsView } from '@tm8/contract';
import { ConfigsSection, valueLabel } from './ConfigsSection';

afterEach(cleanup);

const knob = (over: Partial<ConfigKnobView>): ConfigKnobView => ({
  name: 'X', group: 'G', summary: 's', value: { kind: 'unset' }, source: 'default',
  default: null, definedAt: 'a.ts:1', change: 'env', ...over,
});

const VIEW: SpaceConfigsView = {
  spaceId: 's1',
  node: {
    visible: true,
    knobs: [
      knob({ name: 'TM8_DB_POOL_MAX', group: 'Storage & database', value: { kind: 'value', text: '16' }, source: 'env', default: '8', definedAt: 'packages/server/src/http/config.ts:471' }),
      knob({ name: 'TYPESAFE_API_KEY', group: 'Keys', value: { kind: 'secret', present: true }, source: 'env' }),
    ],
  },
  cli: [knob({ name: 'TM8_BASE_URL', group: 'CLI', value: { kind: 'unobservable', reason: 'r' }, source: 'env' })],
  code: [knob({ name: 'MEMORY_TICK_LIMIT', group: 'Jev selection', value: { kind: 'value', text: '32' }, source: 'code', change: 'code' })],
  teammates: [{ id: 't1', name: 'Ada', knobs: [knob({ name: 'capabilities.launch.harnessSurface', group: 'Teammate launch', value: { kind: 'value', text: 'minimal' }, source: 'persona', change: 'persona' })] }],
  profiles: [],
};

describe('ConfigsSection', () => {
  it('renders every knob the server returns, grouped, with source and definition', async () => {
    render(<ConfigsSection heading="Configs" load={async () => VIEW} />);
    const pool = await screen.findByTestId('config-TM8_DB_POOL_MAX');
    expect(pool.textContent).toContain('16');
    expect(pool.textContent).toContain('default 8');
    expect(pool.textContent).toContain('packages/server/src/http/config.ts:471');
    expect(pool.textContent).toContain('set TM8_DB_POOL_MAX in the server environment and restart');
    expect(screen.getByTestId('config-TYPESAFE_API_KEY').textContent).toContain('set (value hidden)');
    expect(screen.getByTestId('config-MEMORY_TICK_LIMIT').textContent).toContain('code constant');
    expect(screen.getByTestId('config-capabilities.launch.harnessSurface').textContent).toContain('persona');
    expect(screen.getByTestId('config-TM8_BASE_URL').textContent).toContain('set TM8_BASE_URL in your shell');
    expect(screen.getByText('Storage & database')).toBeTruthy();
  });

  it('states the server reason when node env is withheld', async () => {
    const hidden: SpaceConfigsView = { ...VIEW, node: { visible: false, reason: 'node admins only' } };
    render(<ConfigsSection heading="Configs" load={async () => hidden} />);
    expect((await screen.findByTestId('configs-node-hidden')).textContent).toBe('node admins only');
    expect(screen.queryByTestId('config-TM8_DB_POOL_MAX')).toBeNull();
  });

  it('says a failed read out loud', async () => {
    render(<ConfigsSection heading="Configs" load={async () => { throw new Error('forbidden'); }} />);
    expect(await screen.findByText('Configs could not be read.')).toBeTruthy();
  });

  it('labels secrets by presence only', () => {
    expect(valueLabel({ kind: 'secret', present: false })).toBe('not set');
    expect(valueLabel({ kind: 'secret', present: true })).toBe('set (value hidden)');
  });
});
