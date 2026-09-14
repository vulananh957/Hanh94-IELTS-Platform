import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as any }, listener: null as any,
  process: vi.fn(), replace: vi.fn(), signOut: vi.fn(), clear: vi.fn(),
}));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_auth: any, callback: any) => {
  mocks.listener = callback;
  callback(mocks.auth.currentUser);
  return vi.fn();
} }));
vi.mock('@/services/auth', () => ({
  auth: mocks.auth, clearAuthState: mocks.clear, processAuthenticatedUser: mocks.process,
  getAuthErrorMessage: (error: Error) => error.message, signOutUser: mocks.signOut,
  redirectPathByRole: (role: string) => role === 'testCreator' ? '/creator' : `/${role}`,
}));
import { AuthRouteGuard } from './auth-route-guard';
const router = { replace: mocks.replace };
// Stable router identity mirrors Next; effects should only rerun on actual dependencies.
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve };
};
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = { uid: 'u1' }; });
afterEach(cleanup);

describe('AuthRouteGuard', () => {
  it('does not mount dashboard content before access has been verified', async () => {
    const pending = deferred<string>(); mocks.process.mockReturnValue(pending.promise);
    render(<AuthRouteGuard area="student"><div>Dashboard data</div></AuthRouteGuard>);
    expect(screen.queryByText('Dashboard data')).not.toBeInTheDocument();
    await act(async () => pending.resolve('student'));
    expect(screen.getByText('Dashboard data')).toBeInTheDocument();
  });
  it('redirects signed-out users without a recovery delay or a dashboard flash', () => {
    mocks.auth.currentUser = null;
    render(<AuthRouteGuard area="student"><div>Private</div></AuthRouteGuard>);
    expect(mocks.replace).toHaveBeenCalledWith('/login');
    expect(mocks.process).not.toHaveBeenCalled(); expect(screen.queryByText('Private')).not.toBeInTheDocument();
  });
  it('redirects a role mismatch without mounting the wrong dashboard', async () => {
    mocks.process.mockResolvedValue('student');
    render(<AuthRouteGuard area="teacher"><div>Teacher data</div></AuthRouteGuard>);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/student'));
    expect(screen.queryByText('Teacher data')).not.toBeInTheDocument();
  });
  it('discards an old account verification result after a newer auth event', async () => {
    const pending = deferred<string>(); mocks.process.mockReturnValue(pending.promise);
    render(<AuthRouteGuard area="teacher"><div>Teacher data</div></AuthRouteGuard>);
    await act(async () => { mocks.auth.currentUser = null; mocks.listener(null); pending.resolve('teacher'); });
    expect(screen.queryByText('Teacher data')).not.toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });
  it('shows a recoverable error instead of redirecting repeatedly on service failure', async () => {
    mocks.process.mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValue('student');
    render(<AuthRouteGuard area="student"><div>Dashboard data</div></AuthRouteGuard>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection failed');
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Dashboard data')).toBeInTheDocument();
  });
  it('protects the creator area and preserves creator access to teacher tools', async () => {
    mocks.process.mockResolvedValue('testCreator');
    const view = render(<AuthRouteGuard area="creator"><div>Creator data</div></AuthRouteGuard>);
    expect(await screen.findByText('Creator data')).toBeInTheDocument();
    view.unmount();
    render(<AuthRouteGuard area="teacher"><div>Teacher tools</div></AuthRouteGuard>);
    expect(await screen.findByText('Teacher tools')).toBeInTheDocument();
  });
});
