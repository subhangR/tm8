// Redaction of credential-shaped tokens from launch artifacts — the seam that
// keeps the S15 DB guard (006/073/086) a tripwire instead of a launch killer.
//
// The fake tokens below are synthetic bytes shaped like real prefixes; none is
// or ever was a live credential.
import { describe, expect, it } from 'vitest';
import {
  REDACTION_MARKER,
  containsSecretToken,
  redactSecretTokens,
  redactSecretsDeep,
} from '../src/spawn/secret-redaction.js';

const FAKE_ANTHROPIC = `sk-ant-oat01-${'A'.repeat(80)}`;
const FAKE_OPENAI = `sk-proj-${'b'.repeat(40)}`;
const FAKE_GHP = `ghp_${'C'.repeat(36)}`;
const FAKE_GHO = `gho_${'D'.repeat(36)}`;
const FAKE_GH_PAT = `github_pat_${'e'.repeat(60)}`;
const FAKE_SLACK = `xoxb-${'1'.repeat(12)}-abcdef`;

describe('redactSecretTokens', () => {
  it('redacts credential-shaped tokens wherever they sit in free text', () => {
    for (const token of [FAKE_ANTHROPIC, FAKE_OPENAI, FAKE_GHP, FAKE_GHO, FAKE_GH_PAT, FAKE_SLACK]) {
      const text = `the key is ${token} — use it`;
      expect(containsSecretToken(text)).toBe(true);
      const redacted = redactSecretTokens(text);
      expect(redacted).toBe(`the key is ${REDACTION_MARKER} — use it`);
      expect(redacted).not.toContain(token.slice(0, 24));
    }
  });

  it('redacts a token at the very start of the text', () => {
    expect(redactSecretTokens(FAKE_ANTHROPIC)).toBe(REDACTION_MARKER);
  });

  it('redacts tokens after quotes, equals and colons — how they appear in JSON and env text', () => {
    expect(redactSecretTokens(`{"apiKey":"${FAKE_OPENAI}"}`)).toBe(`{"apiKey":"${REDACTION_MARKER}"}`);
    expect(redactSecretTokens(`ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}`)).toBe(
      `ANTHROPIC_API_KEY=${REDACTION_MARKER}`,
    );
  });

  it('redacts every occurrence, not just the first', () => {
    const redacted = redactSecretTokens(`${FAKE_GHP} and ${FAKE_SLACK}`);
    expect(redacted).toBe(`${REDACTION_MARKER} and ${REDACTION_MARKER}`);
  });

  // THE FALSE-POSITIVE CLASS THAT MADE SESSIONS UNSPAWNABLE. `sk-` is the tail
  // of the word "task"; 073's unanchored pattern matched ordinary branch names
  // and slugs. The redactor (and the 086 guard, same grammar) must leave these
  // alone.
  it('leaves ordinary task-/risk-/desk- words untouched', () => {
    const benign = [
      'fix/task-acceptance-criteria-cleanup',
      'agent/task-tile-row-controls-extra',
      'task-0123456789abcdef',
      'the disk-usage-monitoring-alerts dashboard',
      'the task-bodies-and-content migration',
      'ask-the-coordinator-before-changing-anything',
    ];
    for (const text of benign) {
      expect(containsSecretToken(text)).toBe(false);
      expect(redactSecretTokens(text)).toBe(text);
    }
  });

  it('still requires the minimum token length', () => {
    expect(redactSecretTokens('sk-short')).toBe('sk-short');
    expect(redactSecretTokens('ghp_tooshort')).toBe('ghp_tooshort');
  });
});

describe('redactSecretsDeep', () => {
  it('scrubs strings recursively through objects and arrays, preserving structure', () => {
    const input = {
      title: 'Fix claude credential connection.',
      tasks: [{ description: `paste: ${FAKE_ANTHROPIC}`, priority: 'high', points: 3 }],
      nested: { list: [`ok`, `${FAKE_GHP}`], flag: true, nothing: null },
    };
    const out = redactSecretsDeep(input);
    expect(out.title).toBe('Fix claude credential connection.');
    expect(out.tasks[0]?.description).toBe(`paste: ${REDACTION_MARKER}`);
    expect(out.tasks[0]?.points).toBe(3);
    expect(out.nested.list).toEqual(['ok', REDACTION_MARKER]);
    expect(out.nested.flag).toBe(true);
    expect(out.nested.nothing).toBeNull();
    // The input is not mutated — composeManifest's inputs belong to the caller.
    expect(input.tasks[0]?.description).toContain('sk-ant-oat01-');
  });
});
