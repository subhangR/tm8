import { describe, expect, it } from 'vitest';
import { checkFormAction, checkNavigationChain, checkPasswordFieldLocation, checkTopFrameUrl, observedOrigin } from '../../src/browser/policy.js';

describe('exact-origin fill policy (acceptance 3, 4, 6)', () => {
  const bound = 'https://github.com';
  it.each(['https://login.github.com/login', 'https://githhub.com/login', 'https://github.com:444/login', 'https://github.com.attacker.com'])('refuses %s', (url) => {
    expect(checkTopFrameUrl(url, bound, false)).toBe('origin_mismatch');
  });
  it('canonicalizes default ports and case through the shared origin helper', () => {
    expect(checkTopFrameUrl('https://GITHUB.com:443/login?next=1', bound, false)).toBeNull();
  });
  it('requires item dev mode for http and still compares the scheme', () => {
    expect(checkTopFrameUrl('http://github.com', bound, false)).toBe('insecure_context');
    expect(checkTopFrameUrl('http://github.com', bound, true)).toBe('origin_mismatch');
    expect(checkTopFrameUrl('http://localhost:8080/a', 'http://localhost:8080', true)).toBeNull();
    expect(checkTopFrameUrl('http://localhost:8081/a', 'http://localhost:8080', true)).toBe('origin_mismatch');
  });
  it('remembers a redirect that left and returned', () => {
    expect(checkNavigationChain([`${bound}/a`, 'https://githhub.com/', `${bound}/b`], bound, false)).toBe('cross_origin_redirect');
    expect(checkNavigationChain([`${bound}/a`, `${bound}/b`], bound, false)).toBeNull();
  });
  it.each(['https://githhub.com/post', '//login.github.com/post', 'javascript:submit()', 'data:text/html,x', 'https://name:pass@github.com'])('refuses action %s', (action) => {
    expect(checkFormAction(action, `${bound}/login`, bound, false)).toBe('cross_origin_form_action');
  });
  it.each(['', '/session', './session', '?session=1', 'https://github.com/session'])('allows relative or exact-origin action %s', (action) => {
    expect(checkFormAction(action, `${bound}/login`, bound, false)).toBeNull();
  });
  it('refuses a downgraded form action', () => {
    expect(checkFormAction('http://github.com/post', bound, bound, false)).toBe('insecure_context');
  });
  it('refuses an iframe-only password field without touching it', () => {
    expect(checkPasswordFieldLocation(false, true)).toBe('not_top_frame');
    expect(checkPasswordFieldLocation(false, false)).toBe('fields_not_found');
    expect(checkPasswordFieldLocation(true, true)).toBeNull();
  });
  it('returns only origin metadata', () => {
    expect(observedOrigin('https://github.com/a?private=fixture#x')).toBe(bound);
    expect(observedOrigin('data:text/plain,fixture')).toBeNull();
    expect(observedOrigin('https://name:pass@github.com')).toBeNull();
  });
});
