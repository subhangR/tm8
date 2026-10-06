/**
 * The launch notes placeholder: a design says what Run does (Craft → Designs,
 * D4); continuing and every other subject keep their own text.
 */
import { describe, expect, it } from 'vitest';
import { notesPlaceholderFor } from './LaunchComposerPopup';

describe('notesPlaceholderFor', () => {
  it('a design says Run creates what its graph pages describe', () => {
    expect(notesPlaceholderFor('design', false)).toContain('Run this design: the agent creates what its graph pages describe.');
  });
  it('a task keeps "the task stays as written"', () => {
    expect(notesPlaceholderFor('task', false)).toContain('the task stays as written');
  });
  it('continuing wins over the subject kind', () => {
    expect(notesPlaceholderFor('design', true)).toContain('transcript first');
  });
});
