'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import {
  auth,
  clearAuthState,
  getRedirectResultIfAny,
  getStoredAuth,
  getUserRole,
  hasPendingAuthRedirect,
  isManagedUserDisabled,
  redirectPathByRole,
  waitForAuthSession,
} from '@/services/auth';

function canAccessTeacherPages(role: string | null | undefined): boolean {
  return role === 'teacher' || role === 'testCreator';
}

export default function TeacherRouteLayout({ children }: { children: ReactNode }) {
  const router = useRouter();

  const [isAuthorized, setIsAuthorized] = useState(true);

  useEffect(() => {
    let active = true;
    let recoveryAttemptId = 0;

    const waitForAuthRecovery = async (timeoutMs: number): Promise<boolean> => {
      if (auth.currentUser) return true;

      try {
        const recoveredUser = await getRedirectResultIfAny({
          waitForCurrentUser: true,
          timeoutMs,
        });
        if (recoveredUser || auth.currentUser) return true;
      } catch {
        // Ignore recovery errors and keep waiting for auth state.
      }

      return await waitForAuthSession(timeoutMs);
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
        const shouldWaitForRedirect = hasPendingAuthRedirect();

        const thisAttemptId = ++recoveryAttemptId;
        void (async () => {
          if (stored?.user?.email && await isManagedUserDisabled(stored.user.email)) {
            if (!active) return;
            clearAuthState();
            blockAndRedirect('/login');
            return;
          }

          if (stored?.user) {
            allowAccess();
          } else {
            setIsAuthorized(false);
          }

          const recovered = await waitForAuthRecovery(
            shouldWaitForRedirect || stored?.user ? 12000 : 2500,
          );
          if (!active) return;
          if (thisAttemptId !== recoveryAttemptId) return;
          if (recovered) {
            allowAccess();
            return;
          }

          clearAuthState();
          blockAndRedirect('/login');
        })();
        return;
      }

      void (async () => {
        // Cancel any pending null-user recovery flow once a real user appears.
        recoveryAttemptId += 1;

        if (await isManagedUserDisabled(currentUser.email)) {
          if (!active) return;
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
  }, [router]);

  if (!isAuthorized) {
    return null;
  }

  return <>{children}</>;
}
