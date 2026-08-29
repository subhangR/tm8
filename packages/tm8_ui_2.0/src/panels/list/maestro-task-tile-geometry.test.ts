import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  fileURLToPath(new URL('./maestro-task-tile.css', import.meta.url)),
  'utf8',
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return CSS.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
}

describe('MaestroTaskTile geometry contract', () => {
  it('reserves a five-slot cluster from its rendered child count at each floating breakpoint', () => {
    const fiveSlots = ':has(> .pn-tt__actions > :nth-child(5):last-child)';
    const escaped = fiveSlots.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(CSS).toMatch(
      new RegExp(`${escaped}\\s*\\{\\s*--tt-actions-reserve:\\s*131px`),
    );
    expect(CSS).toMatch(/@container task-tile \(max-width: 360px\)[\s\S]*?:nth-child\(5\):last-child\)\s*\{\s*--tt-actions-reserve:\s*127px/);
    expect(CSS).toMatch(/@container task-tile \(max-width: 200px\)[\s\S]*?:nth-child\(5\):last-child\)\s*\{\s*--tt-actions-reserve:\s*104px/);
  });

  it('keeps the disclosure in flow instead of positioning it over status', () => {
    const arrow = ruleBody('.cv2-root .pn-tt__arrow');
    expect(arrow).toMatch(/flex:\s*0 0 16px/);
    expect(arrow).not.toMatch(/position:\s*absolute/);
    expect(arrow).not.toMatch(/(?:^|;)\s*(?:top|left|z-index)\s*:/);
  });
});
