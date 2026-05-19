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
	onAuthStateChanged,
	setPersistence,
	signInWithPopup,
	signInWithRedirect,
	type Auth,
	type User,
} from 'firebase/auth';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { firebaseApp } from './firebase';
import { recordManagedUserLogin } from './manage-users';

const authPersistences = [
	indexedDBLocalPersistence,
	browserLocalPersistence,
	browserSessionPersistence,
];

function initializeBrowserAuth(): Auth {
	try {
		return initializeAuth(firebaseApp, {
			persistence: authPersistences,
			popupRedirectResolver: browserPopupRedirectResolver,
		});
	} catch {
		return getAuth(firebaseApp);
	}
}

export const auth = initializeBrowserAuth();

const GET_USER_ROLE_URL =
	'https://us-central1-hanh94esl-71776.cloudfunctions.net/getUserRole';

export type UserRole = 'teacher' | 'student' | 'testCreator';
export type MessageType = 'info' | 'success' | 'error';

type StoredUser = {
	uid: string;
	email: string | null;
	displayName: string | null;
	photoURL: string | null;
};

type StoredAuth = {
	user: StoredUser | null;
	role: UserRole | null;
};

const provider = new GoogleAuthProvider();
provider.addScope('profile');
provider.addScope('https://www.googleapis.com/auth/userinfo.profile');
provider.setCustomParameters({ prompt: 'select_account' });

const AUTH_REDIRECT_PENDING_KEY = 'hanh94esl:authRedirectPending';
const AUTH_REDIRECT_STARTED_AT_KEY = 'hanh94esl:authRedirectStartedAt';
const AUTH_REDIRECT_PENDING_TTL_MS = 10 * 60 * 1000;
const AUTH_REDIRECT_IN_PROGRESS_MESSAGE = 'Redirecting to Google sign-in...';

let authPersistencePromise: Promise<void> | null = null;

async function ensureAuthPersistence() {
	if (!authPersistencePromise) {
		authPersistencePromise = (async () => {
			for (const persistence of authPersistences) {
				try {
					await setPersistence(auth, persistence);
					return;
				} catch {
					// Try the next persistence backend.
				}
			}
		})();
	}

	await authPersistencePromise;
}

function setAuthRedirectPending() {
	try {
		sessionStorage.setItem(AUTH_REDIRECT_PENDING_KEY, '1');
		sessionStorage.setItem(AUTH_REDIRECT_STARTED_AT_KEY, String(Date.now()));
	} catch {
		// Redirect can still proceed when sessionStorage is unavailable.
	}
}

function clearAuthRedirectPending() {
	try {
		sessionStorage.removeItem(AUTH_REDIRECT_PENDING_KEY);
		sessionStorage.removeItem(AUTH_REDIRECT_STARTED_AT_KEY);
	} catch {
		// Ignore storage cleanup failures.
	}
}

export function hasPendingAuthRedirect(): boolean {
	try {
		if (sessionStorage.getItem(AUTH_REDIRECT_PENDING_KEY) !== '1') return false;

		const startedAt = Number(sessionStorage.getItem(AUTH_REDIRECT_STARTED_AT_KEY));
		if (!Number.isFinite(startedAt)) {
			clearAuthRedirectPending();
			return false;
		}

		if (Date.now() - startedAt > AUTH_REDIRECT_PENDING_TTL_MS) {
			clearAuthRedirectPending();
			return false;
		}

		return true;
	} catch {
		return false;
	}
}

export function isAuthRedirectInProgressError(error: unknown): boolean {
	return error instanceof Error && error.message === AUTH_REDIRECT_IN_PROGRESS_MESSAGE;
}

function waitForInitialAuthState(timeoutMs: number): Promise<void> {
	if ('authStateReady' in auth && typeof auth.authStateReady === 'function') {
		return Promise.race([
			auth.authStateReady().catch(() => undefined),
			new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
		]);
	}

	return new Promise<void>((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;

		const finish = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeoutId);
			unsubscribe?.();
			resolve();
		};

		const timeoutId = window.setTimeout(finish, timeoutMs);
		unsubscribe = onAuthStateChanged(auth, finish, finish);
	});
}

function withTimeoutSignal(timeoutMs: number) {
	const controller = new AbortController();
	const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		clear: () => window.clearTimeout(timeoutId),
	};
}

function toStoredUser(user: User): StoredUser {
	return {
		uid: user.uid,
		email: user.email,
		displayName: user.displayName,
		photoURL: user.photoURL,
	};
}

function normalizeRole(value: unknown): UserRole | null {
	const normalized = String(value ?? '').trim().toLowerCase();
	if (normalized === 'teacher') return 'teacher';
	if (normalized === 'student') return 'student';
	if (normalized === 'testcreator' || normalized === 'test_creator' || normalized === 'creator') {
		return 'testCreator';
	}
	return null;
}

function normalizeAccountStatus(value: unknown): string {
	return String(value ?? '').trim().toLowerCase();
}

export async function isManagedUserDisabled(email: string | null | undefined): Promise<boolean> {
	const rawEmail = String(email ?? '').trim();
	if (!rawEmail) return false;
	const lookupEmails = rawEmail.toLowerCase() === rawEmail ? [rawEmail] : [rawEmail, rawEmail.toLowerCase()];

	try {
		const db = getFirestore(firebaseApp);
		for (const lookupEmail of lookupEmails) {
			const snap = await getDoc(doc(db, 'users', lookupEmail));
			if (!snap.exists()) {
				continue;
			}

			const data = snap.data() as Record<string, unknown>;
			const status = normalizeAccountStatus(data.status ?? data.accountStatus);
			if (status === 'disabled' || status === 'deleted') {
				return true;
			}

			if (data.isActive === false || data.disabled === true || data.deletedAt || data.removedAt) {
				return true;
			}

			return false;
		}

		return false;
	} catch {
		return false;
	}
}

async function getRoleFromTokenClaims(user: User): Promise<UserRole | null> {
	try {
		const tokenResult = await user.getIdTokenResult();
		return normalizeRole(tokenResult.claims.role ?? tokenResult.claims.userRole);
	} catch {
		return null;
	}
}

function getStoredRoleForUser(user: User): UserRole | null {
	const stored = getStoredAuth();
	if (
		stored
		&& stored.user?.email?.toLowerCase() === user.email?.toLowerCase()
		&& stored.role
	) {
		return stored.role;
	}
	return null;
}

export function getStoredAuth(): StoredAuth | null {
	const userRaw = localStorage.getItem('user');
	const roleRaw = localStorage.getItem('userRole');
	const normalizedRole = normalizeRole(roleRaw);

	if (!userRaw || !normalizedRole) {
		return null;
	}

	try {
		const user = JSON.parse(userRaw) as StoredUser;
		return { user, role: normalizedRole };
	} catch {
		return null;
	}
}

export function clearAuthState() {
	localStorage.removeItem('user');
	localStorage.removeItem('userRole');
	localStorage.removeItem('userClass');
}

function persistAuthState(user: User, role: UserRole) {
	localStorage.setItem('user', JSON.stringify(toStoredUser(user)));
	localStorage.setItem('userRole', role);
}

export async function getRedirectResultIfAny(options: {
	waitForCurrentUser?: boolean;
	timeoutMs?: number;
} = {}): Promise<User | null> {
	await ensureAuthPersistence();

	const wasPending = hasPendingAuthRedirect();
	try {
		const result = await getRedirectResult(auth);
		if (result?.user) return result.user;

		if (wasPending || options.waitForCurrentUser) {
			await waitForInitialAuthState(options.timeoutMs ?? 5000);
			return auth.currentUser;
		}

		return null;
	} finally {
		if (wasPending) {
			clearAuthRedirectPending();
		}
	}
}

export async function handleGoogleSignIn(): Promise<User> {
	await ensureAuthPersistence();

	try {
		const result = await signInWithPopup(auth, provider);
		return result.user;
	} catch (error) {
		const code =
			typeof error === 'object' && error && 'code' in error
				? String((error as { code?: string }).code)
				: '';

		if (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user') {
			setAuthRedirectPending();
			try {
				await signInWithRedirect(auth, provider);
			} catch (redirectError) {
				clearAuthRedirectPending();
				throw redirectError;
			}
			throw new Error(AUTH_REDIRECT_IN_PROGRESS_MESSAGE);
		}

		// Ensure error is always an Error instance
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(typeof error === 'string' ? error : 'Authentication failed. Please try again.');
	}
}

export async function getUserRole(
	user: User,
	options: { idTokenPromise?: Promise<string> } = {},
): Promise<UserRole> {
	if (await isManagedUserDisabled(user.email)) {
		throw new Error('Access denied. Your account has been disabled. Please contact administrator.');
	}

	const claimRole = await getRoleFromTokenClaims(user);
	if (claimRole) {
		return claimRole;
	}

	const timeout = withTimeoutSignal(8000);
	try {
		const idToken = await (options.idTokenPromise ?? user.getIdToken());
		const response = await fetch(GET_USER_ROLE_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${idToken}`,
			},
			body: JSON.stringify({ email: user.email }),
			signal: timeout.signal,
		});

		if (!response.ok) {
			const message = await response.text();
			throw new Error(`Failed to get user role (${response.status}): ${message}`);
		}

		const data = (await response.json()) as { role?: string };
		const normalizedRole = normalizeRole(data.role);
		if (!normalizedRole) {
			throw new Error('No valid role returned from server');
		}

		return normalizedRole;
	} catch {
		const storedRole = getStoredRoleForUser(user);
		if (storedRole) {
			return storedRole;
		}
		throw new Error('Access denied. You are not authorized to use this system. Please contact administrator.');
	} finally {
		timeout.clear();
	}
}

async function saveUserInfoWithToken(params: {
	user: User;
	idToken: string;
	role: UserRole;
	classCode?: string | null;
}) {
	try {
		await recordManagedUserLogin({
			email: params.user.email || '',
			role: params.role,
			displayName: params.user.displayName,
			photoURL: params.user.photoURL,
			classCode: params.classCode ?? null,
			idToken: params.idToken,
		});
	} catch {
		// Keep the login flow best-effort.
	}
}

export async function processAuthenticatedUser(user: User): Promise<UserRole> {
	const idTokenPromise = user.getIdToken();
	const role = await getUserRole(user, { idTokenPromise });

	persistAuthState(user, role);

	void idTokenPromise
		.then((idToken) => saveUserInfoWithToken({ user, idToken, role }))
		.catch(() => {
			// Keep profile sync best-effort without slowing down redirect after login.
		});

	return role;
}

export function redirectPathByRole(role: UserRole): string {
	if (role === 'teacher') return '/teacher';
	if (role === 'student') return '/student';
	if (role === 'testCreator') return '/creator';
	return '/';
}

export function onAuthStateChangedCleanup(onSignedOut: () => void) {
	return onAuthStateChanged(auth, (user) => {
		if (!user) {
			onSignedOut();
		}
	});
}

export async function waitForAuthSession(timeoutMs = 8000): Promise<boolean> {
	if (auth.currentUser) return true;

	return await new Promise<boolean>((resolve) => {
		const unsubscribe = onAuthStateChanged(auth, (user) => {
			if (user) {
				window.clearTimeout(timeoutId);
				unsubscribe();
				resolve(true);
			}
		});

		const timeoutId = window.setTimeout(() => {
			unsubscribe();
			resolve(Boolean(auth.currentUser));
		}, timeoutMs);
	});
}
