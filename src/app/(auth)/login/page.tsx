'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  auth, clearAuthState, getRedirectResultIfAny, getAuthErrorMessage, handleGoogleSignIn,
  isAuthRedirectInProgressError, processAuthenticatedUser, redirectPathByRole, signOutUser,
  type MessageType,
} from '@/services/auth';
import type { User } from 'firebase/auth';

type Phase = 'restoring' | 'idle' | 'signingIn' | 'verifying' | 'redirecting';

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('restoring');
  const [toast, setToast] = useState<{ text: string; type: MessageType } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const navigated = useRef(false);

  const completeSignIn = useCallback(async (user: User, isActive: () => boolean) => {
    if (!isActive()) return;
    setPhase('verifying');
    const role = await processAuthenticatedUser(user);
    if (!isActive() || auth.currentUser !== user || navigated.current) return;
    navigated.current = true;
    setPhase('redirecting');
    router.replace(redirectPathByRole(role));
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void (async () => {
      try {
        const user = await getRedirectResultIfAny();
        if (!active) return;
        if (user) await completeSignIn(user, () => active);
        else { clearAuthState(); setPhase('idle'); }
      } catch (error) {
        if (!active) return;
        setToast({ text: getAuthErrorMessage(error), type: 'error' });
        setPhase('idle');
      }
    })();
    return () => { active = false; mounted.current = false; };
  }, [completeSignIn]);

  const signIn = useCallback(async () => {
    if (busy.current || phase !== 'idle') return;
    busy.current = true;
    setToast(null);
    setPhase(auth.currentUser ? 'verifying' : 'signingIn');
    try {
      const user = auth.currentUser ?? await handleGoogleSignIn();
      await completeSignIn(user, () => mounted.current);
    } catch (error) {
      if (!mounted.current || isAuthRedirectInProgressError(error)) return;
      setToast({ text: getAuthErrorMessage(error), type: 'error' });
      setPhase('idle');
    } finally {
      busy.current = false;
    }
  }, [phase, completeSignIn]);

  return (
    <div className="login-page">
      <Link href="/" className="login-back-to-home">
        <i className="fas fa-arrow-left" />
        Back to Home
      </Link>

      {toast ? (
        <div className={`login-toast ${toast.type}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}

      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">
            <i className="fas fa-graduation-cap" />
          </div>

          <div className="login-brand-name">hanh94esl</div>

          <h1 className="login-title">Welcome to hanh94esl</h1>
          <p className="login-subtitle">Sign in to begin your IELTS journey</p>

          <button className="login-signin-btn" onClick={signIn} disabled={phase !== 'idle'} aria-busy={phase !== 'idle'}>
            <div className="login-google-icon" />
            {phase === 'restoring' ? 'Checking your session…' : phase === 'signingIn' ? 'Opening Google…' : phase === 'verifying' ? 'Verifying your account…' : phase === 'redirecting' ? 'Opening your dashboard…' : toast && auth.currentUser ? 'Try again' : 'Sign in with Google'}
          </button>

          {phase === 'idle' && toast && auth.currentUser && (
            <button className="login-switch-account" onClick={() => {
              setPhase('restoring');
              void signOutUser().then(() => setToast(null)).catch((error) => setToast({ text: getAuthErrorMessage(error), type: 'error' })).finally(() => setPhase('idle'));
            }}>Use another account</button>
          )}

          <div className="login-security-note">
            <p>
              <i className="fas fa-shield-alt" />
              We use your Google profile to identify your account and provide access to your classes and tests.
            </p>
          </div>

          <div className="login-footer-links">
            <a href="#privacy">Privacy Policy</a>
            <a href="#terms">Terms of Service</a>
            <a href="#support">Support</a>
          </div>
        </div>
      </div>
    </div>
  );
}
