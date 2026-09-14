// @vitest-environment node
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: {}, initialize: vi.fn(), getAuth: vi.fn() }));
vi.mock('./firebase', () => ({ firebaseApp: {} }));
vi.mock('firebase/auth', () => ({
  browserLocalPersistence: undefined, browserSessionPersistence: undefined, indexedDBLocalPersistence: undefined,
  browserPopupRedirectResolver: undefined, initializeAuth: mocks.initialize, getAuth: mocks.getAuth,
  GoogleAuthProvider: class { setCustomParameters() {} }, getRedirectResult: vi.fn(),
  signInWithPopup: vi.fn(), signInWithRedirect: vi.fn(), signInWithEmailAndPassword: vi.fn(), signOut: vi.fn(),
}));
it('does not initialize browser-only persistence during Next.js server rendering', async () => {
  mocks.getAuth.mockReturnValue(mocks.auth);
  expect((await import('./auth')).auth).toBe(mocks.auth);
  expect(mocks.initialize).not.toHaveBeenCalled();
});
