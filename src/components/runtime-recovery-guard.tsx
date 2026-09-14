'use client';

import { useEffect } from 'react';

const RECOVERY_KEY = 'hanh94esl:chunkRecoveryAt';

export function RuntimeRecoveryGuard() {
  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
      // Network/storage events during sign-in are not evidence of a stale JS chunk.
      if (!/Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module/i.test(message)) return;
      try {
        const previous = Number(sessionStorage.getItem(RECOVERY_KEY));
        if (previous && Date.now() - previous < 60000) return;
        sessionStorage.setItem(RECOVERY_KEY, String(Date.now()));
      } catch {
        return; // Without persistent bookkeeping a reload could loop indefinitely.
      }
      event.preventDefault();
      window.location.reload();
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, []);
  return null;
}
