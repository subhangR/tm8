// @vitest-environment jsdom
/**
 * NO YELLOW IN THE CHAT COMPOSER (Subhang, 2026-10-18, task 01a14b82): "No
 * yellow shit should be shown in the chat composer."
 *
 * jsdom loads no stylesheets, so this renders the composer, then reads every
 * rule of the sheets it is styled by and asks the rendered subtree whether the
 * rule applies (`Element.matches`, pseudo-classes stripped). A rule that
 * applies may not reach for a warning tone. The popovers' sheets are portaled
 * and not rendered here, so their rules are checked by class prefix.
 */
import { readFileSync } from 'node:fs';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatHomeScreen, NO_TEAMMATE_REFUSAL } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000091';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const SHEETS = ['./chat-home.css', './crew/crew.css', '../rich-input/rich-input.css', '../mcp/mcp.css'].map((path) => ({
  path,
  css: readFileSync(new URL(path, import.meta.url), 'utf8'),
}));

/** Amber/warning tokens and literals: the wait tone, a warn token, a named yellow. */
const WARNING_TONE = /--pn-wait|--pn-warn|\bamber\b|\byellow\b|\bgold\b|\borange\b/i;
/** Warning-named classes, which would carry the tone whatever the sheet says. */
const WARNING_CLASS = /(?:^|[-_])(warn|warning|amber|caution|yellow)(?:$|[-_])/i;
/** Popover bodies the composer opens (portaled, so not in the rendered tree). */
const POPOVER_PREFIXES = ['.tch-pickmenu', '.tch-submenu', '.tch-effort', '.tch-optform', '.tch-modelrow', '.tch-modelmenu', '.tch-menu', '.tch-slider', '.tch-teampick'];

interface Rule { selectors: string[]; body: string; sheet: string }

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const { path, css } of SHEETS) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Innermost `selector { body }` pairs; @media wrappers fall away.
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = match[1]!.trim();
      if (head.startsWith('@')) continue;
      out.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), body: match[2]!, sheet: path });
    }
  }
  return out;
}

function applies(root: Element, selector: string): boolean {
  const plain = selector
    .replace(/::?[a-z-]+\([^)]*\)/gi, (m) => (m.startsWith(':not(') || m.startsWith(':is(') || m.startsWith(':has(') ? m : ''))
    .replace(/::?(hover|focus|focus-visible|focus-within|active|disabled|checked|placeholder|before|after|first-child|last-child|placeholder-shown|-webkit-[a-z-]+)/gi, '')
    .trim();
  if (!plain) return false;
  try {
    return root.matches(plain) || root.querySelector(plain) !== null;
  } catch {
    return false;
  }
}

function offences(root: Element): string[] {
  const found: string[] = [];
  for (const rule of rules()) {
    if (!WARNING_TONE.test(rule.body)) continue;
    for (const selector of rule.selectors) {
      const popover = POPOVER_PREFIXES.some((prefix) => selector.startsWith(prefix));
      if (popover || applies(root, selector)) found.push(`${rule.sheet}: ${selector} { ${rule.body.trim()} }`);
    }
  }
  root.querySelectorAll('[class]').forEach((el) => {
    for (const token of el.classList) if (WARNING_CLASS.test(token)) found.push(`class ${token}`);
  });
  return found;
}

const composerOf = (container: HTMLElement) => container.querySelector('.tch-composer-wrap')!;

describe('the chat composer shows no warning tone', () => {
  it('a new chat in a space with no agent teammate: a muted line inside the card, the reason on Send', async () => {
    const fixture = createChatHomeFixturePort([]);
    const port: ChatHomePort = { ...fixture.port, async listTeammates() { return []; } };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer" />);
    const note = await view.findByTestId('tch-compose-refusal');
    expect(note.textContent).toBe(NO_TEAMMATE_REFUSAL);
    expect(note.closest('.ri-card')).not.toBeNull();
    const send = view.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('title')).toBe(NO_TEAMMATE_REFUSAL);
    expect(offences(composerOf(view.container))).toEqual([]);
  });

  it('says nothing about teammates while the roster is still being read', async () => {
    const fixture = createChatHomeFixturePort([]);
    const port: ChatHomePort = { ...fixture.port, listTeammates: () => new Promise(() => {}) };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer" />);
    await waitFor(() => expect(composerOf(view.container)).not.toBeNull());
    expect(view.queryByTestId('tch-compose-refusal')).toBeNull();
    expect(view.queryByText(NO_TEAMMATE_REFUSAL)).toBeNull();
    expect(view.getByRole('button', { name: 'Send' }).getAttribute('title')).not.toBe(NO_TEAMMATE_REFUSAL);
  });

  it('a started thread', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.container.querySelector('.tch-title strong')?.textContent).toBe('Plan the launch sequence'));
    expect(offences(composerOf(view.container))).toEqual([]);
  });

  it('the composer’s status lines and popovers are styled in ink, not amber', () => {
    const sheet = rules();
    for (const selector of ['.tch-refusal', '.tch-phase']) {
      const rule = sheet.find((entry) => entry.selectors.includes(selector));
      expect(rule, `no rule for ${selector}`).toBeDefined();
      expect(rule!.body).not.toMatch(WARNING_TONE);
    }
    const popovers = sheet.flatMap((rule) =>
      rule.selectors.filter((s) => POPOVER_PREFIXES.some((p) => s.startsWith(p)) && WARNING_TONE.test(rule.body)));
    expect(popovers).toEqual([]);
  });
});
