'use client';

import { useEffect, useRef } from 'react';

export function RuntimeRecoveryGuard() {
  const hasRecoveredRef = useRef(false);

  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const reasonText =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : String(reason);

      const isEventReason = reason instanceof Event || reasonText === '[object Event]';
      const isChunkIssue = /Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module|reading 'call'/i.test(reasonText);

      if (!isEventReason && !isChunkIssue) return;

      event.preventDefault();

      if (!hasRecoveredRef.current) {
        hasRecoveredRef.current = true;
        window.location.reload();
      }
    };

    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, []);

  return null;
}
