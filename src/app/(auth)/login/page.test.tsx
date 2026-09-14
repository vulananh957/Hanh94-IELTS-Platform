import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as any }, restore: vi.fn(), popup: vi.fn(), process: vi.fn(), clear: vi.fn(),
  router: { replace: vi.fn(), prefetch: vi.fn() }, signOut: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('@/services/auth', () => ({
  auth: mocks.auth, clearAuthState: mocks.clear, getRedirectResultIfAny: mocks.restore,
  handleGoogleSignIn: mocks.popup, processAuthenticatedUser: mocks.process, signOutUser: mocks.signOut,
  redirectPathByRole: (role: string) => `/${role}`,
  getAuthErrorMessage: (error: Error) => error.message, isAuthRedirectInProgressError: () => false,
}));
import LoginPage from './page';
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve };
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.currentUser = null;
  mocks.restore.mockResolvedValue(null); mocks.process.mockResolvedValue('student');
});
afterEach(cleanup);

describe('LoginPage', () => {
  it('waits for restoration and does not prefetch all dashboards', async () => {
    const pending = deferred<any>(); mocks.restore.mockReturnValue(pending.promise);
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: 'Checking your session…' })).toBeDisabled();
    await act(async () => pending.resolve(null));
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
    expect(mocks.router.prefetch).not.toHaveBeenCalled(); expect(mocks.router.replace).not.toHaveBeenCalled();
  });
  it('restores an existing Firebase session once under Strict Mode', async () => {
    const user = { uid: 'u1' }; mocks.auth.currentUser = user; mocks.restore.mockResolvedValue(user);
    render(<StrictMode><LoginPage /></StrictMode>);
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/student'));
    expect(mocks.process).toHaveBeenCalledTimes(1); expect(mocks.router.replace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Opening your dashboard…' })).toBeDisabled();
  });
  it('prevents double submission and holds the busy state until navigation', async () => {
    const pending = deferred<any>(); mocks.popup.mockReturnValue(pending.promise);
    render(<LoginPage />);
    const button = await screen.findByRole('button', { name: 'Sign in with Google' });
    fireEvent.click(button); fireEvent.click(button); expect(mocks.popup).toHaveBeenCalledTimes(1);
    const user = { uid: 'u1' };
    await act(async () => { mocks.auth.currentUser = user; pending.resolve(user); });
    expect(mocks.router.replace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Opening your dashboard…' })).toBeDisabled();
  });
  it('keeps errors visible and lets the user retry verification or switch accounts', async () => {
    const user = { uid: 'u1' }; mocks.auth.currentUser = user; mocks.restore.mockResolvedValue(user);
    mocks.process.mockRejectedValueOnce(new Error('Unable to verify')).mockResolvedValue('student');
    render(<LoginPage />);
    expect(await screen.findByRole('status')).toHaveTextContent('Unable to verify');
    expect(screen.getByRole('button', { name: 'Use another account' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/student'));
    expect(mocks.popup).not.toHaveBeenCalled();
  });
  it('does not navigate after the login page has unmounted', async () => {
    const pending = deferred<any>(); mocks.popup.mockReturnValue(pending.promise);
    const view = render(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    view.unmount();
    await act(async () => { const user = { uid: 'u1' }; mocks.auth.currentUser = user; pending.resolve(user); });
    expect(mocks.router.replace).not.toHaveBeenCalled(); expect(mocks.process).not.toHaveBeenCalled();
  });
});
