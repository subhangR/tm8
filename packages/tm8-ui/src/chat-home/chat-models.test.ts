import { describe, expect, it } from 'vitest';
import {
  chatModelChoices,
  firstRunnableModel,
  hasRunnableModel,
  tierNote,
  type ChatModelSource,
} from './chat-models';

const SOURCE: ChatModelSource[] = [
  { model: 'claude-opus-5', label: 'Claude Opus 5', agentTool: 'claude-code', provider: 'anthropic' },
  { model: 'gpt-5.6-sol', label: 'OpenAI GPT 5.6', agentTool: 'codex', provider: 'openai' },
  { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', agentTool: 'claude-code', provider: 'anthropic' },
];

describe('the chat model seam', () => {
  /**
   * THE POINT OF THE WHOLE MODULE. The list the picker renders comes from an
   * array of four plain fields — not from the launch catalog, not from
   * localStorage. Model discovery replaces WHERE that array comes from and
   * nothing here has to change, which is the property this case pins.
   */
  it('reads a plain list and never a catalog', () => {
    const invented: ChatModelSource[] = [
      { model: 'discovered-by-some-future-registry', label: 'Something New', agentTool: 'claude-code' },
    ];
    const [choice] = chatModelChoices(invented);
    expect(choice?.model).toBe('discovered-by-some-future-registry');
    expect(choice?.label).toBe('Something New');
    expect(choice?.suitability.unavailable).toBeNull();
  });

  /**
   * NOTHING IS DROPPED. Curation is what the product decision removed; a model
   * this surface cannot run comes back WITH ITS REASON rather than vanishing,
   * because an absence teaches a person nothing and a sentence does.
   */
  it('offers every model it is given, in order, including the ones it cannot run', () => {
    const choices = chatModelChoices(SOURCE);
    expect(choices.map((choice) => choice.model)).toEqual([
      'claude-opus-5',
      'gpt-5.6-sol',
      'claude-haiku-4-5',
    ]);
  });

  it('names the tool a model it cannot run would launch under', () => {
    const [, codex] = chatModelChoices(SOURCE);
    expect(codex?.suitability.unavailable)
      .toBe('Chat runs Claude Code models — this one launches via Codex');
  });

  /**
   * A tool this UI has never been taught still produces a readable sentence.
   * Once discovery lands, an unknown agent tool is a real possibility, and
   * "launches via another tool" would be less useful than the id itself.
   */
  it('falls back to the raw tool id rather than inventing a name for it', () => {
    const [only] = chatModelChoices([
      { model: 'x', label: 'X', agentTool: 'some-future-cli' },
    ]);
    expect(only?.suitability.unavailable)
      .toBe('Chat runs Claude Code models — this one launches via some-future-cli');
  });

  /**
   * THE UNPOPULATED SLOT, STATED AS A TEST.
   *
   * DESIGN 6 tiers harnesses A/B/C by capability and the same logic applies to
   * models — but nothing in tm8 measures a model's tier yet, so every entry
   * comes back null and the row renders no tier line. This case exists so that
   * whoever lands the measurement finds the seam already shaped and already
   * asserted, rather than a guess to unpick.
   */
  it('carries a capability tier that nothing populates yet', () => {
    for (const choice of chatModelChoices(SOURCE)) {
      expect(choice.suitability.tier).toBeNull();
    }
    expect(tierNote(null)).toBeNull();
    expect(tierNote('B')).toBe('Tier B');
  });

  it('shows the provider as the row hint while no tier exists to show instead', () => {
    const [opus] = chatModelChoices(SOURCE);
    expect(opus?.hint).toBe('anthropic');
  });

  it('answers which model a new thread should start on, skipping the unrunnable', () => {
    expect(firstRunnableModel(chatModelChoices(SOURCE))?.model).toBe('claude-opus-5');
    const codexOnly = chatModelChoices([SOURCE[1]!]);
    expect(firstRunnableModel(codexOnly)).toBeNull();
    expect(hasRunnableModel(codexOnly)).toBe(false);
    expect(hasRunnableModel(chatModelChoices(SOURCE))).toBe(true);
  });
});
