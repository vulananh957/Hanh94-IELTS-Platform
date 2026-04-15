'use client';
import {
	GoogleAuthProvider,
	getAuth,
	getRedirectResult,
	onAuthStateChanged,
	signInWithPopup,
	signInWithRedirect,
	type User,
} from 'firebase/auth';
import { firebaseApp } from './firebase';

export const auth = getAuth(firebaseApp);

const GET_USER_ROLE_URL =
	'https://us-central1-hanh94esl-71776.cloudfunctions.net/getUserRole';
const SAVE_USER_INFO_URL =
	'https://us-central1-hanh94esl-71776.cloudfunctions.net/saveUserInfo';

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

function isValidRole(value: string): value is UserRole {
	return value === 'teacher' || value === 'student' || value === 'testCreator';
}

export function getStoredAuth(): StoredAuth | null {
	const userRaw = localStorage.getItem('user');
	const roleRaw = localStorage.getItem('userRole');

	if (!userRaw || !roleRaw || !isValidRole(roleRaw)) {
		return null;
	}

	try {
		const user = JSON.parse(userRaw) as StoredUser;
		return { user, role: roleRaw };
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

export async function getRedirectResultIfAny(): Promise<User | null> {
	const result = await getRedirectResult(auth);
	return result?.user ?? null;
}

export async function handleGoogleSignIn(): Promise<User> {
	try {
		const result = await signInWithPopup(auth, provider);
		return result.user;
	} catch (error) {
		const code =
			typeof error === 'object' && error && 'code' in error
				? String((error as { code?: string }).code)
				: '';

		if (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user') {
			await signInWithRedirect(auth, provider);
			throw new Error('Redirecting to Google sign-in...');
		}

		// Ensure error is always an Error instance
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(typeof error === 'string' ? error : 'Authentication failed. Please try again.');
	}
}

export async function getUserRole(user: User): Promise<UserRole> {
	const timeout = withTimeoutSignal(10000);
	try {
		const response = await fetch(GET_USER_ROLE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email }),
			signal: timeout.signal,
		});

		if (!response.ok) {
			const message = await response.text();
			throw new Error(`Failed to get user role (${response.status}): ${message}`);
		}

		const data = (await response.json()) as { role?: string };
		if (!data.role || !isValidRole(data.role)) {
			throw new Error('No valid role returned from server');
		}

		return data.role;
	} catch {
		const stored = getStoredAuth();
		if (stored?.user?.email === user.email && stored.role) {
			return stored.role;
		}
		throw new Error('Access denied. You are not authorized to use this system. Please contact administrator.');
	} finally {
		timeout.clear();
	}
}

async function saveUserInfoWithToken(params: {
	user: User;
	idToken: string;
	classCode?: string | null;
}) {
	const timeout = withTimeoutSignal(10000);
	try {
		const response = await fetch(SAVE_USER_INFO_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${params.idToken}`,
			},
			body: JSON.stringify({
				email: params.user.email,
				displayName: params.user.displayName,
				photoURL: params.user.photoURL,
				classCode: params.classCode ?? null,
			}),
			signal: timeout.signal,
		});

		if (!response.ok) {
			throw new Error('Failed to save user info');
		}
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return;
		}
		throw error;
	} finally {
		timeout.clear();
	}
}

export async function processAuthenticatedUser(user: User): Promise<UserRole> {
	// Run parallel to reduce end-to-end login latency.
	const [role, idToken] = await Promise.all([getUserRole(user), user.getIdToken()]);

	if (!isValidRole(role)) {
		throw new Error('Role not found. Please contact administrator.');
	}

	persistAuthState(user, role);

	if (role === 'teacher' || role === 'student' || role === 'testCreator') {
		await saveUserInfoWithToken({ user, idToken, classCode: null });
		return role;
	}

	throw new Error('Access denied. You are not authorized to use this system. Please contact administrator.');
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
