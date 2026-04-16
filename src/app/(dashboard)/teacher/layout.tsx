'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { clearAuthState, getStoredAuth, getUserRole, redirectPathByRole } from '@/services/auth';
import { firebaseApp } from '@/services/firebase';

function canAccessTeacherPages(role: string | null | undefined): boolean {
  return role === 'teacher' || role === 'testCreator';
}

export default function TeacherRouteLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const auth = useMemo(() => getAuth(firebaseApp), []);

  const [isChecking, setIsChecking] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!active) return;

      if (!currentUser) {
        clearAuthState();
        setIsAuthorized(false);
        setIsChecking(false);
        router.replace('/login');
        return;
      }

      const stored = getStoredAuth();
      if (stored?.user?.email === currentUser.email && stored.role) {
        if (canAccessTeacherPages(stored.role)) {
          setIsAuthorized(true);
          setAccessError(null);
          setIsChecking(false);
          return;
        }

        setIsAuthorized(false);
        setAccessError('Access denied: student accounts cannot access teacher pages.');
        setIsChecking(false);
        router.replace(redirectPathByRole(stored.role));
        return;
      }

      setIsChecking(true);

      void (async () => {
        try {
          const role = await getUserRole(currentUser);
          if (!active) return;

          if (canAccessTeacherPages(role)) {
            setIsAuthorized(true);
            setAccessError(null);
            localStorage.setItem('userRole', role);
            localStorage.setItem(
              'user',
              JSON.stringify({
                uid: currentUser.uid,
                email: currentUser.email,
                displayName: currentUser.displayName,
                photoURL: currentUser.photoURL,
              }),
            );
            return;
          }

          setIsAuthorized(false);
          setAccessError('Access denied: student accounts cannot access teacher pages.');
          router.replace(redirectPathByRole(role));
        } catch (err) {
          if (!active) return;

          setIsAuthorized(false);
          setAccessError(err instanceof Error ? err.message : 'Failed to verify account role.');
          clearAuthState();
          router.replace('/login');
        } finally {
          if (active) {
            setIsChecking(false);
          }
        }
      })();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [auth, router]);

  if (isChecking) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <div style={{
          border: '1px solid rgba(14, 165, 233, 0.28)',
          background: 'rgba(240, 249, 255, 0.94)',
          color: '#0369a1',
          borderRadius: '12px',
          padding: '0.75rem 0.95rem',
          fontSize: '0.95rem',
          fontWeight: 600,
        }}>
          Verifying teacher page access...
        </div>
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
        {accessError ? (
          <div style={{
            border: '1px solid rgba(244, 63, 94, 0.3)',
            background: 'rgba(255, 241, 242, 0.92)',
            color: '#be123c',
            borderRadius: '12px',
            padding: '0.75rem 0.95rem',
            fontSize: '0.93rem',
            fontWeight: 600,
            maxWidth: '42rem',
            textAlign: 'center',
          }}>
            {accessError}
          </div>
        ) : null}
      </div>
    );
  }

  return <>{children}</>;
}
