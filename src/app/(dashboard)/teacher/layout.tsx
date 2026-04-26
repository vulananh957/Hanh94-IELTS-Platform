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

  const [isAuthorized, setIsAuthorized] = useState(true);

  useEffect(() => {
    let active = true;
    let signedOutGraceTimer: ReturnType<typeof setTimeout> | null = null;

    const clearSignedOutGraceTimer = () => {
      if (signedOutGraceTimer) {
        clearTimeout(signedOutGraceTimer);
        signedOutGraceTimer = null;
      }
    };

    const allowAccess = () => {
      if (!active) return;
      setIsAuthorized(true);
    };

    const blockAndRedirect = (target: string) => {
      if (!active) return;
      setIsAuthorized(false);
      router.replace(target);
    };

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!active) return;
      clearSignedOutGraceTimer();

      if (!currentUser) {
        const stored = getStoredAuth();

        if (stored?.user) {
          allowAccess();

          signedOutGraceTimer = setTimeout(() => {
            if (!active) return;
            if (auth.currentUser) return;
            clearAuthState();
            blockAndRedirect('/login');
          }, 2500);
          return;
        }

        clearAuthState();
        blockAndRedirect('/login');
        return;
      }

      const stored = getStoredAuth();
      if (stored?.user?.email === currentUser.email && stored.role) {
        if (canAccessTeacherPages(stored.role)) {
          allowAccess();
          return;
        }

        blockAndRedirect(redirectPathByRole(stored.role));
        return;
      }

      // Keep UI smooth with no blocking screen while role verification runs in background.
      allowAccess();

      void (async () => {
        try {
          const role = await getUserRole(currentUser);
          if (!active) return;

          if (canAccessTeacherPages(role)) {
            allowAccess();
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

          blockAndRedirect(redirectPathByRole(role));
        } catch {
          if (!active) return;

          clearAuthState();
          blockAndRedirect('/login');
        }
      })();
    });

    return () => {
      active = false;
      clearSignedOutGraceTimer();
      unsubscribe();
    };
  }, [auth, router]);

  if (!isAuthorized) {
    return null;
  }

  return <>{children}</>;
}
