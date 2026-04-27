'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getRedirectResultIfAny,
  getStoredAuth,
  hasPendingAuthRedirect,
  handleGoogleSignIn,
  isAuthRedirectInProgressError,
  processAuthenticatedUser,
  redirectPathByRole,
  waitForAuthSession,
  type MessageType,
} from '@/services/auth';

type ToastState = {
  text: string;
  type: MessageType;
};

export default function LoginPage() {
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((text: string, type: MessageType = 'info') => {
    setToast({ text, type });
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const redirectByRole = useCallback(
    (role: 'teacher' | 'student' | 'testCreator') => {
      router.replace(redirectPathByRole(role));
    },
    [router]
  );

  const signIn = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const user = await handleGoogleSignIn();
      const role = await processAuthenticatedUser(user);
      await waitForAuthSession(10000);
      redirectByRole(role);
    } catch (error) {
      if (isAuthRedirectInProgressError(error)) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Login failed. Please try again.';
      showToast(message, 'error');
      setIsSubmitting(false);
    }
  }, [isSubmitting, redirectByRole, showToast]);

  useEffect(() => {
    router.prefetch('/student');
    router.prefetch('/teacher');
    router.prefetch('/creator');

    let active = true;

    const resolveInitialAuth = async () => {
      const blockedEmail = localStorage.getItem('blockedUser');
      if (blockedEmail) {
        if (active) {
          showToast('Your account has been blocked due to repeated violations. Please contact admin for support.', 'error');
          router.replace('/');
        }
        return;
      }

      const hasPendingRedirect = hasPendingAuthRedirect();
      if (hasPendingRedirect && active) {
        setIsSubmitting(true);
      }

      try {
        const redirectUser = await getRedirectResultIfAny({
          waitForCurrentUser: hasPendingRedirect,
          timeoutMs: 10000,
        });

        if (!active) return;

        if (redirectUser) {
          const role = await processAuthenticatedUser(redirectUser);
          await waitForAuthSession(10000);
          if (active) redirectByRole(role);
          return;
        }

        const stored = getStoredAuth();
        if (stored?.user && stored.role) {
          redirectByRole(stored.role);
        }
      } catch {
        if (active && hasPendingRedirect) {
          showToast('Login failed. Please try again.', 'error');
        }
      } finally {
        if (active) {
          setIsSubmitting(false);
        }
      }
    };

    void resolveInitialAuth();

    const onMouseMove = (e: MouseEvent) => {
      const card = cardRef.current;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      const rotateX = (y / rect.height) * 5;
      const rotateY = (x / rect.width) * -5;
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    };

    const onMouseLeave = () => {
      const card = cardRef.current;
      if (!card) return;
      card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
    };

    document.addEventListener('mousemove', onMouseMove);
    cardRef.current?.addEventListener('mouseleave', onMouseLeave);

    return () => {
      active = false;
      document.removeEventListener('mousemove', onMouseMove);
      cardRef.current?.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [redirectByRole, router, showToast]);

  const buttonLabel = useMemo(() => {
    return isSubmitting ? 'Signing in...' : 'Sign in with Google';
  }, [isSubmitting]);

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
        <div className="login-card" ref={cardRef}>
          <div className="login-logo">
            <i className="fas fa-graduation-cap" />
          </div>

          <div className="login-brand-name">hanh94esl</div>

          <h1 className="login-title">Welcome to hanh94esl</h1>
          <p className="login-subtitle">Sign in with Google to begin your IELTS journey</p>

          <button className="login-signin-btn" onClick={signIn} disabled={isSubmitting}>
            <div className="login-google-icon" />
            {buttonLabel}
          </button>

          <div className="login-divider">
            <span>Secure Authentication</span>
          </div>

          <div className="login-security-note">
            <p>
              <i className="fas fa-shield-alt" />
              Your privacy and security are our top priorities. We use industry-standard encryption and never store your personal information.
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
