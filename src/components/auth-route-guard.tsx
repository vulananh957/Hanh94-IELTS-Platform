'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  auth, clearAuthState, getAuthErrorMessage, processAuthenticatedUser,
  redirectPathByRole, signOutUser, type UserRole,
} from '@/services/auth';

const allowedRoles: Record<'student' | 'teacher' | 'creator', UserRole[]> = {
  student: ['student'], teacher: ['teacher', 'testCreator'], creator: ['testCreator', 'teacher'],
};

export function AuthRouteGuard({ area, children }: { area: keyof typeof allowedRoles; children: ReactNode }) {
  const router = useRouter();
  const [authorizedUser, setAuthorizedUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let sequence = 0;
    const timeout = window.setTimeout(() => {
      if (active) setError('Connection timed out. Please try again.');
    }, 15000);
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const currentSequence = ++sequence;
      setAuthorizedUser(null);
      setError(null);
      if (!user) {
        clearAuthState();
        router.replace('/login');
        return;
      }
      void processAuthenticatedUser(user).then((role) => {
        if (!active || sequence !== currentSequence) return;
        window.clearTimeout(timeout);
        setError(null);
        if (allowedRoles[area].includes(role)) setAuthorizedUser(user);
        else router.replace(redirectPathByRole(role));
      }).catch((reason) => {
        if (!active || sequence !== currentSequence) return;
        window.clearTimeout(timeout);
        setError(getAuthErrorMessage(reason));
      });
    }, (reason) => {
      if (active) {
        window.clearTimeout(timeout);
        setError(getAuthErrorMessage(reason));
      }
    });
    return () => { active = false; sequence += 1; window.clearTimeout(timeout); unsubscribe(); };
  }, [area, attempt, router]);

  if (authorizedUser && authorizedUser === auth.currentUser && !error) return <>{children}</>;
  return (
    <main className="auth-session-screen" aria-busy={!error}>
      <div role={error ? 'alert' : 'status'} className="auth-session-box">
        {!error && <div className="auth-loading-spinner" aria-hidden="true" />}
        <p>{error || 'Loading...'}</p>
        {error && <div className="auth-session-actions">
          <button onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button>
          <button onClick={() => {
            void signOutUser().then(() => router.replace('/login')).catch((reason) => setError(getAuthErrorMessage(reason)));
          }}>Back to sign in</button>
        </div>}
      </div>
    </main>
  );
}
