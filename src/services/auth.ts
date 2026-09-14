'use client';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  getAuth,
  getRedirectResult,
  initializeAuth,
  signInWithPopup,
  signInWithRedirect,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { firebaseApp } from './firebase';
import { normalizeRole, type UserRole } from '@/lib/auth-role';

export type { UserRole } from '@/lib/auth-role';
export type MessageType = 'info' | 'success' | 'error';

type StoredUser = Pick<User, 'uid' | 'email' | 'displayName' | 'photoURL'>;
type StoredAuth = { user: StoredUser; role: UserRole };

function initializeBrowserAuth(): Auth {
  // Client components are also pre-rendered by Next.js on the server.
  if (typeof window === 'undefined') return getAuth(firebaseApp);
  try {
    // Firebase selects the first available backend; do not migrate storage on each click.
    return initializeAuth(firebaseApp, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/already-initialized') return getAuth(firebaseApp);
    throw error;
  }
}

export const auth = initializeBrowserAuth();
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const REDIRECT_KEY = 'hanh94esl:authRedirectStartedAt';
const REDIRECT_TTL = 10 * 60 * 1000;
let redirectResultPromise: Promise<User | null> | null = null;
let sessionGeneration = 0;
let sessionRequest: { user: User; generation: number; promise: Promise<UserRole> } | null = null;
let verifiedSession: { user: User; role: UserRole; expiresAt: number } | null = null;
let signOutRequest: Promise<void> | null = null;

export class AuthSessionError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); }
}

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function getStoredAuth(): StoredAuth | null {
  try {
    const role = normalizeRole(storageGet('userRole'));
    const user = JSON.parse(storageGet('user') || 'null') as StoredUser | null;
    return role && user && typeof user.uid === 'string' && user.uid ? { user, role } : null;
  } catch { return null; }
}

function clearRedirectPending() {
  try {
    sessionStorage.removeItem(REDIRECT_KEY);
    sessionStorage.removeItem('hanh94esl:authRedirectPending');
  } catch { /* Storage is optional. */ }
}

export function hasPendingAuthRedirect(): boolean {
  try {
    const started = Number(sessionStorage.getItem(REDIRECT_KEY));
    if (started > 0 && Date.now() >= started && Date.now() - started < REDIRECT_TTL) return true;
    clearRedirectPending();
  } catch { /* Storage is optional. */ }
  return false;
}

export function clearAuthState() {
  sessionGeneration += 1;
  verifiedSession = null;
  sessionRequest = null;
  clearRedirectPending();
  for (const key of ['user', 'userRole', 'userClass']) {
    try { localStorage.removeItem(key); } catch { /* Storage is optional. */ }
  }
}

function persistAuthState(user: User, role: UserRole) {
  try {
    localStorage.setItem('user', JSON.stringify({ uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL }));
    localStorage.setItem('userRole', role);
  } catch { /* Firebase remains the session authority when storage is unavailable. */ }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthSessionError('Connection timed out. Please try again.')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function getRedirectResultIfAny(options: { waitForCurrentUser?: boolean; timeoutMs?: number } = {}): Promise<User | null> {
  const timeoutMs = options.timeoutMs ?? 12000;
  if (!redirectResultPromise) {
    // Read once, including when sessionStorage is blocked. Strict Mode shares this request.
    redirectResultPromise = getRedirectResult(auth).then((result) => result?.user ?? null);
  }
  try {
    await withDeadline(Promise.all([redirectResultPromise, auth.authStateReady()]), timeoutMs);
    return auth.currentUser;
  } catch (error) {
    redirectResultPromise = null;
    throw error;
  } finally {
    clearRedirectPending();
  }
}

export function isAuthRedirectInProgressError(error: unknown): boolean {
  return error instanceof AuthSessionError && error.status === 302;
}

export async function handleGoogleSignIn(): Promise<User> {
  try {
    // Open directly from the click, without awaiting persistence or network work first.
    return (await signInWithPopup(auth, provider)).user;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/popup-blocked') {
      try { sessionStorage.setItem(REDIRECT_KEY, String(Date.now())); } catch { /* Firebase manages redirect state. */ }
      try { await signInWithRedirect(auth, provider); } catch (redirectError) {
        clearRedirectPending();
        throw redirectError;
      }
      throw new AuthSessionError('Redirecting to Google sign-in...', 302);
    }
    // Closing the popup is cancellation, not consent to navigate away.
    throw error;
  }
}

export async function handleEmailSignIn(email: string, password: string): Promise<User> {
  return (await signInWithEmailAndPassword(auth, email.trim(), password)).user;
}

export function getAuthErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was cancelled. You can try again when ready.';
  if (code === 'auth/network-request-failed') return 'Unable to connect. Check your internet connection and try again.';
  if (code === 'auth/unauthorized-domain') return 'Google sign-in is not configured for this website. Please contact administrator.';
  if (code === 'auth/web-storage-unsupported') return 'Please allow browser storage for this website and try again.';
  return error instanceof AuthSessionError ? error.message : 'Sign-in failed. Please try again.';
}

export function processAuthenticatedUser(user: User): Promise<UserRole> {
  if (auth.currentUser !== user || signOutRequest) return Promise.reject(new AuthSessionError('Your session has changed. Please sign in again.', 401));
  if (verifiedSession?.user === user && verifiedSession.expiresAt > Date.now()) return Promise.resolve(verifiedSession.role);
  if (sessionRequest?.user === user && sessionRequest.generation === sessionGeneration) return sessionRequest.promise;

  const generation = sessionGeneration;
  const request = (async () => {
    const controller = new AbortController();
    try {
      const role = await withDeadline((async () => {
        const idToken = await user.getIdToken();
        const response = await fetch('/api/auth/session', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({})) as { role?: unknown; error?: string };
        if (!response.ok) throw new AuthSessionError(data.error || 'Unable to verify your account. Please try again.', response.status);
        const resolvedRole = normalizeRole(data.role);
        if (!resolvedRole) throw new AuthSessionError('Unable to verify your account. Please try again.');
        return resolvedRole;
      })(), 12000);
      if (generation !== sessionGeneration || auth.currentUser !== user || signOutRequest) {
        throw new AuthSessionError('Your session has changed. Please sign in again.', 401);
      }
      verifiedSession = { user, role, expiresAt: Date.now() + 60000 };
      persistAuthState(user, role);
      return role;
    } finally {
      controller.abort();
      if (sessionRequest?.generation === generation && sessionRequest.user === user) sessionRequest = null;
    }
  })();
  sessionRequest = { user, generation, promise: request };
  return request;
}

export async function signOutUser(): Promise<void> {
  if (signOutRequest) return signOutRequest;
  sessionGeneration += 1;
  verifiedSession = null;
  sessionRequest = null;
  signOutRequest = signOut(auth).then(() => {
    clearAuthState();
    redirectResultPromise = null;
  }).finally(() => { signOutRequest = null; });
  return signOutRequest;
}

export function redirectPathByRole(role: UserRole): string {
  return role === 'teacher' ? '/teacher' : role === 'testCreator' ? '/creator' : '/student';
}
