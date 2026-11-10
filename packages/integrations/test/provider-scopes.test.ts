import {expect,it} from 'vitest';
import {providerGrantedScopes} from '../src/providers.js';
it('normalizes GitHub comma-delimited actual grants without splitting another provider’s valid comma-containing scope',()=>{
 expect(providerGrantedScopes('https://api.githubcopilot.com/mcp/','repo,read:user, repo')).toEqual(['repo','read:user']);
 expect(providerGrantedScopes('https://example.test/mcp','scope,one scope:two')).toEqual(['scope,one','scope:two']);
 expect(providerGrantedScopes('https://api.githubcopilot.com/mcp/','')).toEqual([]);
});
