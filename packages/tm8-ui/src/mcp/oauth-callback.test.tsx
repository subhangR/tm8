// @vitest-environment jsdom
/**
 * The callback page. Two security items meet here:
 *
 *  - **S14(a), the sending half** — the popup posts ONE message type and only
 *    to its own origin, so it is undeliverable to any window that is not tm8's.
 *  - **S14(b)/S4** — nothing about which connector, which Space or where to
 *    land is read out of the callback URL. The server's single-use pending row
 *    decides all three, and this page learns `returnTo` from the RESPONSE. The
 *    local stash is a HINT naming which tm8 NODE began the connect, and a
 *    missing one no longer fails the callback: that was why a connect begun
 *    from the CLI or another tab always read "could not be completed".
 */
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { captureMcpCallback, rememberMcpOAuth, takeConnectedToast, type McpCallback } from './oauth-callback';
import { McpOAuthCallback } from './McpOAuthCallback';
import { OAUTH_MESSAGE_TYPE } from './useConnect';
afterEach(()=>{cleanup();sessionStorage.clear();localStorage.clear();});
it('captures callback fields then removes them from history without persisting the code',()=>{
  rememberMcpOAuth('https://fixture.example/authorize?state=one','space');
  const replaceState=vi.fn();
  const result=captureMcpCallback({pathname:'/mcp/oauth/callback',search:'?state=one&code=private-code&iss=https%3A%2F%2Ffixture.example',hash:''},{replaceState});
  expect(result).toMatchObject({valid:true,serverId:'local',spaceId:'space',input:{state:'one',code:'private-code',issuer:'https://fixture.example'}});
  expect(replaceState).toHaveBeenCalledWith(null,'','/mcp/oauth/callback');
  expect(sessionStorage.length).toBe(0);
});
it('S14(b): takes nothing but the state, code and issuer out of the URL',()=>{
  // A connect begun elsewhere (the CLI, another tab) has no stash here. S4: it
  // still completes, against the node this browser is pointed at — and the
  // serverId and spaceId the redirect CLAIMS are not read at all.
  const result=captureMcpCallback({pathname:'/mcp/oauth/callback',search:'?state=unknown&code=private-code&serverId=attacker&spaceId=attacker&return_to=%2Fevil',hash:''},{replaceState:vi.fn()});
  expect(result).toMatchObject({valid:true,serverId:'local',spaceId:''});
  expect(Object.keys(result!.input).sort()).toEqual(['code','state']);
});
it('refuses a redirect the contract would refuse anyway',()=>{
  const capture=(search:string)=>captureMcpCallback({pathname:'/mcp/oauth/callback',search,hash:''},{replaceState:vi.fn()})?.valid;
  expect(capture('?code=private-code')).toBe(false);                      // no state
  expect(capture('?state=one')).toBe(false);                              // neither code nor error
  expect(capture('?state=one&code=c&error=access_denied')).toBe(false);   // both
  expect(capture('?state=one&error=access_denied')).toBe(true);
});
it('follows the stash HINT to the node the connect was begun against',()=>{
  localStorage.setItem('tm8-ui:active-server','other');
  rememberMcpOAuth('https://fixture.example/authorize?state=one','space');
  localStorage.setItem('tm8-ui:active-server','local');
  expect(captureMcpCallback({pathname:'/mcp/oauth/callback',search:'?state=one&code=c',hash:''},{replaceState:vi.fn()})?.serverId).toBe('other');
});
const callback: McpCallback={valid:true,serverId:'local',spaceId:'space',input:{state:'one',code:'private-code'}};
it('completes once under StrictMode without displaying callback secrets',async()=>{
  const complete=vi.fn(async()=>({id:'cred'})); render(<StrictMode><McpOAuthCallback callback={callback} complete={complete} opener={null}/></StrictMode>);
  await screen.findByText(/Your account is connected/);expect(complete).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain('private-code');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/#/s/space/settings/connectors');
});
it('S14(a): posts one type, to its own origin, and nothing else',async()=>{
  const postMessage=vi.fn();
  const opener={postMessage} as unknown as Window;
  const complete=vi.fn(async()=>({id:'cred',accountLabel:'subhang@gmail.com',returnTo:'/#/s/space/settings/connectors'}));
  // A stand-in window, as the §10.2 cell below uses: after posting, the page
  // closes ITS window 150ms later, and on the real jsdom window that close
  // tore the document down under whichever test happened to be running then —
  // `document.body` undefined in the next cell on a slow machine.
  const close=vi.fn();
  const view={location:{origin:window.location.origin,replace:vi.fn()},setTimeout:window.setTimeout.bind(window),close,opener} as unknown as Window;
  render(<McpOAuthCallback callback={callback} complete={complete} opener={opener} view={view}/>);
  await waitFor(()=>expect(postMessage).toHaveBeenCalled());
  await waitFor(()=>expect(close).toHaveBeenCalled());
  expect(postMessage).toHaveBeenCalledWith(
    {type:OAUTH_MESSAGE_TYPE,status:'connected',credentialId:'cred',accountLabel:'subhang@gmail.com'},
    window.location.origin,
  );
  // Never a wildcard, and never the provider's origin.
  expect(postMessage.mock.calls.every(call=>call[1]===window.location.origin)).toBe(true);
  // The opener owns the outcome, so the same-tab navigation must NOT also run.
  expect(takeConnectedToast()).toBeNull();
});
it('§10.2: with no opener it lands on the return_to the SERVER kept',async()=>{
  const replace=vi.fn();
  const view={location:{origin:window.location.origin,replace},setTimeout:window.setTimeout.bind(window),close:vi.fn(),opener:null} as unknown as Window;
  const complete=vi.fn(async()=>({id:'cred',accountLabel:'subhang@gmail.com',returnTo:'/#/s/space/settings/connectors'}));
  render(<McpOAuthCallback callback={callback} complete={complete} opener={null} view={view}/>);
  await waitFor(()=>expect(replace).toHaveBeenCalledWith('/#/s/space/settings/connectors'));
  expect(takeConnectedToast()).toBe('Connected as subhang@gmail.com.');
});
it('offers recovery without showing provider error text',async()=>{
  const complete=vi.fn().mockRejectedValue(new Error('provider-token-secret'));
  render(<McpOAuthCallback callback={callback} complete={complete} opener={null}/>);
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('start a new connection'));
  expect(document.body.textContent).not.toContain('provider-token-secret');
});
