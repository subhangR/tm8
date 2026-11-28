/**
 * Regression: the attach-picker dropdown collapsed to ~0px on prod.
 *
 * Two sheets style `.fn-picker`: project-folder-picker.css makes it a modal
 * (`position: fixed; inset: 0`), and attachment-strip.css makes it a dropdown
 * (`position: absolute; top: ...`). The dropdown rule never reset `bottom`,
 * so the modal's `bottom: 0` won, and with `top` at 100% of the anchor the
 * list's height came out at ~10px. This test reads both sheets and requires
 * that every inset side the modal sets is reset by the dropdown rule.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Declarations of the first top-level `.fn-picker {` block in a sheet. */
function pickerRule(file: string): Map<string, string> {
  const css = readFileSync(join(HERE, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /(^|\n)\.fn-picker\s*\{([^}]*)\}/.exec(css);
  if (!m) throw new Error(`no .fn-picker rule in ${file}`);
  const decls = new Map<string, string>();
  for (const part of m[2].split(';')) {
    const i = part.indexOf(':');
    if (i > 0) decls.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return decls;
}

describe('attach picker dropdown vs. folder-picker modal', () => {
  const modal = pickerRule('project-folder-picker.css');
  const dropdown = pickerRule('attachment-strip.css');

  it('the modal still uses inset (the leak source this test guards)', () => {
    expect(modal.get('inset') ?? modal.get('bottom')).toBeDefined();
  });

  it('the dropdown resets bottom so the modal cannot collapse it', () => {
    expect(dropdown.get('position')).toBe('absolute');
    expect(dropdown.get('bottom')).toBe('auto');
  });
});
