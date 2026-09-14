import { getFirestore } from 'firebase-admin/firestore';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { firebaseAdminApp } from './firebase-admin';
import { isDisabledAccount, normalizeRole } from '@/lib/auth-role';

export class AccountAccessError extends Error {
  constructor(message: string, public readonly status = 403) {
    super(message);
  }
}

export async function findManagedUser(email: string) {
  const db = getFirestore(firebaseAdminApp);
  const candidates = [...new Set([email.trim().toLowerCase(), email.trim()].filter(Boolean))];
  for (const id of candidates) {
    const ref = db.collection('users').doc(id);
    const snap = await ref.get();
    if (snap.exists) return { ref, snap };
  }
  for (const value of candidates) {
    const result = await db.collection('users').where('email', '==', value).limit(1).get();
    if (!result.empty) return { ref: result.docs[0].ref, snap: result.docs[0] };
  }
  return null;
}

/** Only managed records and signed claims may grant access; browser data never does. */
export async function resolveManagedAccess(decoded: DecodedIdToken) {
  if (!decoded.email || decoded.email_verified !== true) {
    throw new AccountAccessError('Please sign in with a verified email address.');
  }
  const existing = await findManagedUser(decoded.email);
  const data = existing?.snap.data();
  if (isDisabledAccount(data)) {
    throw new AccountAccessError('Your account has been disabled. Please contact administrator.');
  }
  // An existing record takes precedence over old token claims after a role change.
  const role = existing ? normalizeRole(data?.role) : normalizeRole(decoded.role ?? decoded.userRole);
  if (!role) {
    throw new AccountAccessError('Your account does not have access. Please contact administrator.');
  }
  return { existing, data, role, email: decoded.email.trim().toLowerCase() };
}
