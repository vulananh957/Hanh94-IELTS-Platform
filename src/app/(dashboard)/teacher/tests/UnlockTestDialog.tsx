import { useState } from 'react';
import type { TestAccessLock } from '@/services/test-access';

function formatLockedAt(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function UnlockTestDialog({
  lock,
  onCancel,
  onUnlock,
  onUnlocked,
}: {
  lock: TestAccessLock;
  onCancel: () => void;
  onUnlock: (lock: TestAccessLock) => Promise<void>;
  onUnlocked: (lock: TestAccessLock) => void;
}) {
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (isUnlocking) return;
    setIsUnlocking(true);
    setError(null);
    try {
      await onUnlock(lock);
      onUnlocked(lock);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlock the test. Please try again.');
      setIsUnlocking(false);
    }
  };

  return (
    <div className="modal" onClick={() => { if (!isUnlocking) onCancel(); }}>
      <div className="modal-content small-modal unlock-modal" role="dialog" aria-modal="true" aria-labelledby="unlock-test-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title" id="unlock-test-title">Unlock test?</h3>
          <button className="modal-close" type="button" aria-label="Close" onClick={onCancel} disabled={isUnlocking}>
            <i className="fas fa-times" />
          </button>
        </div>
        <div className="modal-body">
          <p>This student will be allowed to start a new attempt. The locked attempt will remain available for audit.</p>
          <dl className="unlock-summary">
            <div><dt>Student</dt><dd>{lock.studentName}</dd></div>
            {lock.studentEmail ? <div><dt>Email</dt><dd>{lock.studentEmail}</dd></div> : null}
            <div><dt>Class</dt><dd>{lock.className || 'No Class'}</dd></div>
            <div><dt>Test</dt><dd>{lock.testName}</dd></div>
            <div><dt>Reason</dt><dd>Screen sharing stopped</dd></div>
            <div><dt>Locked at</dt><dd>{formatLockedAt(lock.lockedAt)}</dd></div>
            <div><dt>Attempt ID</dt><dd>{lock.lockedAttemptId}</dd></div>
          </dl>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
        </div>
        <div className="modal-actions">
          <button className="btn btn-cancel" type="button" onClick={onCancel} disabled={isUnlocking}>Cancel</button>
          <button className="btn btn-unlock" type="button" onClick={() => void submit()} disabled={isUnlocking}>
            <i className={`fas ${isUnlocking ? 'fa-spinner fa-spin' : 'fa-lock-open'}`} /> {isUnlocking ? 'Unlocking...' : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  );
}
