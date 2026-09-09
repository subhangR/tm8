import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubSignInScreen } from './GithubSignIn';
const mocks = vi.hoisted(() => ({ deployment: { githubLogin: true, distributedSystemFlag: false }, request: vi.fn() }));
vi.mock('./DeploymentGate', () => ({ useDeployment: () => mocks.deployment }));
vi.mock('./api', () => ({ workspaceApi: mocks.request }));
afterEach(() => { cleanup(); mocks.deployment.githubLogin = true; mocks.request.mockReset(); });
it('uses GitHub for sign-in and signup, retaining the invitation without password fields', async () => {
  mocks.request.mockRejectedValue(new Error('OAuth test response'));
  render(<GithubSignInScreen invitationCode="test-invitation" />);
  expect(screen.getByRole('heading', { name: 'Sign in or sign up' })).toBeTruthy();
  expect(document.querySelector('input[type=password]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/v2/auth/github/start', { intent: 'login', invitationCode: 'test-invitation' }));
  expect((await screen.findByRole('alert')).textContent).toContain('OAuth test response');
});
it('shows the missing GitHub configuration without offering another login method', () => {
  mocks.deployment.githubLogin = false;
  render(<GithubSignInScreen />);
  expect((screen.getByRole('button', { name: 'Continue with GitHub' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('not configured');
  expect(screen.queryByLabelText(/password/i)).toBeNull();
});
// @vitest-environment jsdom
