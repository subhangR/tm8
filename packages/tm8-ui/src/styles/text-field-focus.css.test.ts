/**
 * TEXT FIELDS DRAW NO FOCUS BOX (user report, 2026-10-17).
 *
 * A wildcard ring rule (`.tws-root :focus-visible { outline … offset: -2px }`)
 * matched every textarea and input — a text field is ALWAYS `:focus-visible`
 * once focused — and drew a gold box inside the composer and every editor.
 * jsdom loads no stylesheets, so this reads the sheets as text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(new URL('.', import.meta.url).pathname, '..');

function sheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sheets(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

/** Split a selector list on its top-level commas only. */
function splitSelectors(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

describe('text-field focus', () => {
  it('app.css strips the outline from every text-entry field under .cv2-root', () => {
    const css = readFileSync(join(SRC, 'styles/app.css'), 'utf8');
    expect(css).toMatch(/\.cv2-root :where\(\s*textarea,\s*input:not\([^)]*\),\s*\[contenteditable\][^)]*\),\s*\[role='textbox'\]\s*\):where\(:focus, :focus-visible\)\s*\{\s*outline:\s*none;/);
  });

  it('no wildcard `X :focus-visible` ring rule reaches text fields', () => {
    const offenders: string[] = [];
    for (const file of sheets(SRC)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/outline\s*:(?!\s*(none|0)\b)/.test(body)) continue;
        for (const part of splitSelectors(selector)) {
          // A bare `:focus-visible` after a combinator matches ANY descendant.
          if (/(^|[\s>+~]):focus-visible/.test(part.trim()) && !part.includes(':not(textarea')) {
            offenders.push(`${relative(SRC, file)} → ${part.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
