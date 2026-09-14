import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as any, authStateReady: vi.fn() },
  popup: vi.fn(), redirect: vi.fn(), redirectResult: vi.fn(), signOut: vi.fn(), fetch: vi.fn(),
}));
vi.mock('./firebase', () => ({ firebaseApp: {} }));
vi.mock('firebase/auth', () => ({
  browserLocalPersistence: {}, browserSessionPersistence: {}, indexedDBLocalPersistence: {}, browserPopupRedirectResolver: {},
  initializeAuth: () => mocks.auth, getAuth: () => mocks.auth,
  GoogleAuthProvider: class { setCustomParameters() {} },
  getRedirectResult: mocks.redirectResult, signInWithPopup: mocks.popup,
  signInWithRedirect: mocks.redirect, signInWithEmailAndPassword: vi.fn(), signOut: mocks.signOut,
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const response = (role: string, status = 200) => ({ ok: status === 200, status, json: async () => ({ role, error: 'Account denied' }) });
let service: typeof import('./auth');
let user: any;

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  mocks.auth.authStateReady.mockResolvedValue(undefined);
  mocks.redirectResult.mockResolvedValue(null);
  mocks.signOut.mockImplementation(async () => { mocks.auth.currentUser = null; });
  mocks.fetch.mockResolvedValue(response('student'));
  vi.stubGlobal('fetch', mocks.fetch);
  user = { uid: 'u1', email: 'student@example.com', displayName: 'Student', photoURL: null, getIdToken: vi.fn().mockResolvedValue('token') };
  mocks.auth.currentUser = user;
  service = await import('./auth');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('session verification', () => {
  it('shares one request across login and dashboard, including concurrent callers', async () => {
    const [a, b] = await Promise.all([service.processAuthenticatedUser(user), service.processAuthenticatedUser(user)]);
    expect([a, b]).toEqual(['student', 'student']);
    expect(await service.processAuthenticatedUser(user)).toBe('student');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith('/api/auth/session', expect.objectContaining({ method: 'POST', cache: 'no-store', headers: { Authorization: 'Bearer token' } }));
  });
  it('does not trust a stored role when the server denies access', async () => {
    localStorage.setItem('userRole', 'teacher');
    localStorage.setItem('user', JSON.stringify(user));
    mocks.fetch.mockResolvedValue(response('', 403));
    await expect(service.processAuthenticatedUser(user)).rejects.toMatchObject({ status: 403 });
  });
  it('revalidates the role after the short navigation cache expires', async () => {
    vi.useFakeTimers();
    expect(await service.processAuthenticatedUser(user)).toBe('student');
    await vi.advanceTimersByTimeAsync(60001);
    mocks.fetch.mockResolvedValue(response('teacher'));
    expect(await service.processAuthenticatedUser(user)).toBe('teacher');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not persist a late response after logout', async () => {
    const pending = deferred<any>(); mocks.fetch.mockReturnValue(pending.promise);
    const result = service.processAuthenticatedUser(user);
    const rejection = expect(result).rejects.toMatchObject({ status: 401 });
    await Promise.resolve();
    await service.signOutUser();
    pending.resolve(response('teacher'));
    await rejection;
    expect(service.getStoredAuth()).toBeNull();
  });
  it('does not accept a result belonging to the previous account', async () => {
    const pending = deferred<any>(); mocks.fetch.mockReturnValue(pending.promise);
    const result = service.processAuthenticatedUser(user);
    mocks.auth.currentUser = { ...user, uid: 'u2' };
    pending.resolve(response('teacher'));
    await expect(result).rejects.toMatchObject({ status: 401 });
    expect(service.getStoredAuth()).toBeNull();
  });
  it('allows retry after a temporary server failure', async () => {
    mocks.fetch.mockResolvedValueOnce(response('', 503));
    await expect(service.processAuthenticatedUser(user)).rejects.toMatchObject({ status: 503 });
    expect(await service.processAuthenticatedUser(user)).toBe('student');
  });
  it('bounds token/network waits and aborts the request', async () => {
    vi.useFakeTimers(); mocks.fetch.mockReturnValue(new Promise(() => {}));
    const result = service.processAuthenticatedUser(user);
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(12000);
    await rejection;
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(service.getStoredAuth()).toBeNull();
  });
  it('handles a token failure without making a role request', async () => {
    user.getIdToken.mockRejectedValue(new Error('token failed'));
    await expect(service.processAuthenticatedUser(user)).rejects.toThrow('token failed');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('works when browser storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(await service.processAuthenticatedUser(user)).toBe('student');
    expect(service.getStoredAuth()).toBeNull();
    await expect(service.signOutUser()).resolves.toBeUndefined();
  });
  it('does not pretend logout succeeded when Firebase sign-out fails', async () => {
    await service.processAuthenticatedUser(user);
    mocks.signOut.mockRejectedValue(new Error('storage failed'));
    await expect(service.signOutUser()).rejects.toThrow('storage failed');
    expect(mocks.auth.currentUser).toBe(user);
    expect(service.getStoredAuth()?.user.uid).toBe(user.uid);
  });
});

describe('Google sign-in and restoration', () => {
  it('opens the popup immediately in the click invocation', async () => {
    mocks.popup.mockResolvedValue({ user });
    const pending = service.handleGoogleSignIn();
    expect(mocks.popup).toHaveBeenCalledTimes(1);
    expect(await pending).toBe(user);
  });
  it('treats popup closure as cancellation without starting a redirect', async () => {
    mocks.popup.mockRejectedValue({ code: 'auth/popup-closed-by-user' });
    await expect(service.handleGoogleSignIn()).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it('falls back to redirect only for a blocked popup', async () => {
    mocks.popup.mockRejectedValue({ code: 'auth/popup-blocked' }); mocks.redirect.mockResolvedValue(undefined);
    await expect(service.handleGoogleSignIn()).rejects.toMatchObject({ status: 302 });
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(service.hasPendingAuthRedirect()).toBe(true);
  });
  it('restores Firebase sessions without relying on a redirect marker', async () => {
    const users = await Promise.all([service.getRedirectResultIfAny(), service.getRedirectResultIfAny()]);
    expect(users).toEqual([user, user]);
    expect(mocks.redirectResult).toHaveBeenCalledTimes(1);
  });
  it('ignores stale localStorage when Firebase is signed out', async () => {
    mocks.auth.currentUser = null;
    localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('userRole', 'teacher');
    expect(await service.getRedirectResultIfAny()).toBeNull();
  });
  it('never resurrects the user from a consumed redirect result', async () => {
    mocks.redirectResult.mockResolvedValue({ user });
    expect(await service.getRedirectResultIfAny()).toBe(user);
    mocks.auth.currentUser = null;
    expect(await service.getRedirectResultIfAny()).toBeNull();
  });
});
