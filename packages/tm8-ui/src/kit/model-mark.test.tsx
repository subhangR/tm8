// @vitest-environment jsdom
/**
 * THE MARK MUST TELL MODELS APART. That is the whole requirement, in the
 * words that produced it: "i'm not able to get and understand the icons of
 * which models are spawning if its kimi grok or claude or gpt, i need to know
 * clear icons distinguishable".
 *
 * So these tests assert the two ways that requirement fails. It fails if a
 * model in the catalog resolves to no family at all, and it fails if two
 * families that a person is choosing between draw the SAME shape — the "same
 * blob" defect `domain/kind-art.ts` documents for entity kinds and guards the
 * same way.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';

import { MODEL_FAMILY_MARKS, ModelMark } from './ModelMark';
import { MODEL_FAMILY_LABEL, modelFamilyOf, modelMarkLabel, modelServedNote } from '../domain/model-family';

const familyOfCatalog = () => LAUNCH_MODEL_CATALOG.map((row) => [row.model, modelFamilyOf(row.model)] as const);

describe('model families', () => {
  it('names a family for every model the launcher can offer', () => {
    const unplaced = familyOfCatalog().filter(([, family]) => family === 'unknown');
    expect(unplaced).toEqual([]);
  });

  /**
   * THE REGRESSION THIS EXISTS FOR. Keying the mark on the catalog's
   * `provider` would have drawn Groq's bolt on Llama, Qwen, DeepSeek, GPT-OSS
   * and Kimi-on-Groq alike — five models, one icon, which is the exact
   * complaint. Assert that the Groq-hosted rows spread across families.
   */
  it('does not collapse every Groq-hosted model onto one mark', () => {
    const hosted = LAUNCH_MODEL_CATALOG.filter((row) => row.provider === 'groq');
    expect(hosted.length).toBeGreaterThan(1);
    const families = new Set(hosted.map((row) => modelFamilyOf(row.model)));
    expect(families.size).toBeGreaterThan(1);
    expect(families.has('unknown')).toBe(false);
  });

  it('tells apart the ids that differ only by a suffix', () => {
    expect(modelFamilyOf('kimi-k2-thinking')).toBe('kimi');
    expect(modelFamilyOf('kimi-k2-thinking-turbo')).toBe('kimi');
    expect(modelFamilyOf('moonshotai/kimi-k2-instruct-0905')).toBe('kimi');
  });

  /** One transposed letter apart, and both reach `codex`. */
  it('does not confuse xAI grok with the host groq', () => {
    expect(modelFamilyOf('grok-4')).toBe('grok');
    expect(modelFamilyOf('grok-code-fast-1')).toBe('grok');
    expect(modelFamilyOf('openai/gpt-oss-120b')).toBe('gpt');
    expect(modelFamilyOf('llama-3.3-70b-versatile')).toBe('llama');
  });

  /**
   * THE ONE ID IN THE CATALOG THAT MATCHES TWO RULES.
   * `deepseek-r1-distill-llama-70b` is a DeepSeek model distilled INTO a Llama
   * architecture, and it contains both needles. Rule order decides, and if
   * anyone reorders `FAMILY_RULES` alphabetically this row starts wearing
   * Meta's mark for a model Meta did not make.
   */
  it('reads a distill as the family that made it, not the one it was poured into', () => {
    expect(modelFamilyOf('deepseek-r1-distill-llama-70b')).toBe('deepseek');
  });

  it('is blank rather than wrong when there is no model', () => {
    expect(modelFamilyOf(null)).toBe('unknown');
    expect(modelFamilyOf('')).toBe('unknown');
    expect(modelMarkLabel(null)).toBe(MODEL_FAMILY_LABEL.unknown);
  });

  /** A vendor note earns its space only when it is not the family's own home. */
  it('names the serving vendor only when it surprises', () => {
    expect(modelServedNote('claude-opus-5')).toBeNull();
    expect(modelServedNote('moonshotai/kimi-k2-instruct-0905')).toBe('Groq');
    expect(modelMarkLabel('moonshotai/kimi-k2-instruct-0905')).toBe('Kimi · served by Groq');
  });
});

describe('the drawn marks', () => {
  const svgOf = (family: keyof typeof MODEL_FAMILY_MARKS): string => {
    const Mark = MODEL_FAMILY_MARKS[family];
    const { container } = render(<Mark />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error(`${family} drew no svg`);
    return svg.innerHTML;
  };

  it('gives every family its own silhouette', () => {
    const seen = new Map<string, string>();
    for (const family of Object.keys(MODEL_FAMILY_MARKS) as (keyof typeof MODEL_FAMILY_MARKS)[]) {
      const shape = svgOf(family);
      const clash = seen.get(shape);
      expect(clash, `${family} draws the same shape as ${clash}`).toBeUndefined();
      seen.set(shape, family);
    }
    expect(seen.size).toBe(Object.keys(MODEL_FAMILY_MARKS).length);
  });

  /** `currentColor` everywhere, so one mark works in both themes. */
  it('never hard-codes a colour', () => {
    for (const family of Object.keys(MODEL_FAMILY_MARKS) as (keyof typeof MODEL_FAMILY_MARKS)[]) {
      expect(svgOf(family)).not.toMatch(/(stroke|fill)="(?!currentColor|none)[^"]/);
    }
  });

  it('carries the family as its accessible name', () => {
    const { container, getByRole } = render(<ModelMark model="moonshotai/kimi-k2-instruct-0905" />);
    expect(getByRole('img').getAttribute('aria-label')).toBe('Kimi · served by Groq');
    expect(container.querySelector('[data-model-family="kimi"]')).not.toBeNull();
  });

  /** Where the name is already written beside it, saying it twice is noise. */
  it('is silent to a screen reader when decorative', () => {
    const { container } = render(<ModelMark model="claude-opus-5" decorative />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('aria-label')).toBeNull();
  });
});
