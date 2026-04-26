'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import {
  clearAuthState,
  getRedirectResultIfAny,
  getStoredAuth,
  getUserRole,
  redirectPathByRole,
} from '@/services/auth';
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
    let recoveryAttemptId = 0;

    const waitForAuthRecovery = async (timeoutMs: number): Promise<boolean> => {
      if (auth.currentUser) return true;

      try {
        // In redirect flow, this finalizes pending auth result if available.
        await getRedirectResultIfAny();
      } catch {
        // Ignore recovery errors and keep waiting for auth state.
      }

      if (auth.currentUser) return true;

      return await new Promise<boolean>((resolve) => {
        const startedAt = Date.now();
        const pollInterval = setInterval(() => {
          if (auth.currentUser) {
            clearInterval(pollInterval);
            resolve(true);
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            clearInterval(pollInterval);
            resolve(false);
          }
        }, 250);
      });
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

      if (!currentUser) {
        const stored = getStoredAuth();

        if (stored?.user) {
          allowAccess();

          const thisAttemptId = ++recoveryAttemptId;
          void (async () => {
            const recovered = await waitForAuthRecovery(12000);
            if (!active) return;
            if (thisAttemptId !== recoveryAttemptId) return;
            if (recovered) return;

            clearAuthState();
            blockAndRedirect('/login');
          })();
          return;
        }

        clearAuthState();
        blockAndRedirect('/login');
        return;
      }

      // Cancel any pending null-user recovery flow once a real user appears.
      recoveryAttemptId += 1;

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
      recoveryAttemptId += 1;
      unsubscribe();
    };
  }, [auth, router]);

  if (!isAuthorized) {
    return null;
  }

  return <>{children}</>;
}
