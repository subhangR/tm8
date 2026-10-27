// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { captureMcpCallback, rememberMcpOAuth, type McpCallback } from './oauth-callback';
import { McpOAuthCallback } from './McpOAuthCallback';
afterEach(()=>{cleanup();sessionStorage.clear();localStorage.clear();});
it('captures callback fields then removes them from history without persisting the code',()=>{
  rememberMcpOAuth('https://fixture.example/authorize?state=one','space');
  const replaceState=vi.fn();
  const result=captureMcpCallback({pathname:'/mcp/oauth/callback',search:'?state=one&code=private-code&iss=https%3A%2F%2Ffixture.example',hash:''},{replaceState});
  expect(result).toMatchObject({valid:true,serverId:'local',spaceId:'space',input:{state:'one',code:'private-code',issuer:'https://fixture.example'}});
  expect(replaceState).toHaveBeenCalledWith(null,'','/mcp/oauth/callback');
  expect(sessionStorage.length).toBe(0);
});
it('rejects unsolicited callback state',()=>{
  expect(captureMcpCallback({pathname:'/mcp/oauth/callback',search:'?state=unknown&code=private-code',hash:''},{replaceState:vi.fn()})?.valid).toBe(false);
});
const callback: McpCallback={valid:true,serverId:'local',spaceId:'space',input:{state:'one',code:'private-code'}};
it('completes once under StrictMode without displaying callback secrets',async()=>{
  const complete=vi.fn(async()=>({})); render(<StrictMode><McpOAuthCallback callback={callback} complete={complete}/></StrictMode>);
  await screen.findByText(/Your private account is connected/);expect(complete).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain('private-code');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/#/s/space/settings/connectors');
});
it('never sends a code to a different active server',async()=>{
  localStorage.setItem('tm8-ui:active-server','other');const complete=vi.fn();
  render(<McpOAuthCallback callback={callback} complete={complete}/>);await screen.findByRole('alert');expect(complete).not.toHaveBeenCalled();
});
it('offers recovery without showing provider error text',async()=>{
  const complete=vi.fn().mockRejectedValue(new Error('provider-token-secret'));
  render(<McpOAuthCallback callback={callback} complete={complete}/>);
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('start a new connection'));
  expect(document.body.textContent).not.toContain('provider-token-secret');
});
