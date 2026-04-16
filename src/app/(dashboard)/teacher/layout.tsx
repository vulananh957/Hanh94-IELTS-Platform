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

      if (!currentUser) {
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
      unsubscribe();
    };
  }, [auth, router]);

  if (!isAuthorized) {
    return null;
  }

  return <>{children}</>;
}
