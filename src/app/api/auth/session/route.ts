import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { firebaseAdminApp } from '@/services/firebase-admin';
import { AccountAccessError, resolveManagedAccess } from '@/services/managed-user-access';

export const runtime = 'nodejs';

function respond(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return respond({ error: 'Please sign in again.' }, 401);

  try {
    const decoded = await getAuth(firebaseAdminApp).verifyIdToken(token, true);
    const { existing, data, role, email } = await resolveManagedAccess(decoded);
    const ref = existing?.ref ?? getFirestore(firebaseAdminApp).collection('users').doc(email);
    const timestamp = Timestamp.now();
    // Finish first-login provisioning before the dashboard starts reading Firestore.
    // Never accept role, email or class changes from the client during login.
    await ref.set({
      email,
      ...(!existing ? { role } : {}),
      name: data?.name || decoded.name || email.split('@')[0],
      displayName: decoded.name || data?.displayName || null,
      photoURL: decoded.picture || data?.photoURL || null,
      lastLogin: timestamp,
      lastLoginAt: timestamp,
      updatedAt: timestamp,
    }, { merge: true });
    return respond({ role });
  } catch (error) {
    if (error instanceof AccountAccessError) return respond({ error: error.message }, error.status);
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (['auth/id-token-expired', 'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/argument-error', 'auth/user-disabled', 'auth/user-not-found'].includes(code)) {
      return respond({ error: 'Your session has expired or is no longer valid. Please sign in again.' }, 401);
    }
    console.error('[auth/session] Session verification failed', code || 'service-unavailable');
    return respond({ error: 'Unable to verify your account right now. Please try again.' }, 503);
  }
}
