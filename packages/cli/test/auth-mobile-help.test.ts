/**
 * TM8 Mobile S4 (task 01a1867c): the mobile sign-in is discoverable by intent,
 * and `tm8 help auth login` names the kind, its lifetime and the device label.
 */
import { describe, expect, it } from 'vitest';

import { searchHelp } from '../src/discovery/help.js';
import { commandDiscovery } from '../src/discovery/operations.js';

describe('the mobile auth kind in help', () => {
  it('`tm8 help --query` finds auth login for the phone sign-in intents', () => {
    for (const query of ['mobile sign in', 'phone login', 'login kind mobile']) {
      const commands = searchHelp(query).matches.map((match) => match.command);
      expect(commands, query).toContain('auth login');
    }
  });

  it('`tm8 help auth login` shows --kind browser|cli|mobile and says what mobile is', () => {
    const login = commandDiscovery(['auth', 'login']);
    expect(login?.syntax).toContain('[--kind browser|cli|mobile]');
    expect(login?.notes.join('\n')).toMatch(/mobile live 90 days/);
    expect(login?.notes.join('\n')).toMatch(/--label/);
  });

  it('`tm8 help auth sessions` says each row shows its kind and label', () => {
    expect(commandDiscovery(['auth', 'sessions'])?.notes.join('\n')).toMatch(/kind \(browser, cli, mobile/);
  });
});
