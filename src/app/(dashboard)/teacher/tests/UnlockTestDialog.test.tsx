import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnlockTestDialog } from './UnlockTestDialog';
import type { TestAccessLock } from '@/services/test-access';

const lock: TestAccessLock = {
  id: 'test-1--student-1',
  testId: 'test-1',
  testName: 'Reading Test',
  studentUid: 'student-1',
  studentName: 'Alex Student',
  studentEmail: 'alex@example.com',
  className: 'Class A',
  status: 'locked',
  reason: 'screen_sharing_stopped',
  lockedAttemptId: 'attempt-1',
  lockedAt: '2026-09-09T12:00:00.000Z',
};

describe('UnlockTestDialog', () => {
  it('cancels without changing access', () => {
    const onCancel = vi.fn();
    const onUnlock = vi.fn();
    render(<UnlockTestDialog lock={lock} onCancel={onCancel} onUnlock={onUnlock} onUnlocked={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it('prevents duplicate unlocks and reports success only after backend confirmation', async () => {
    let resolveUnlock!: () => void;
    const onUnlock = vi.fn(() => new Promise<void>((resolve) => { resolveUnlock = resolve; }));
    const onUnlocked = vi.fn();
    render(<UnlockTestDialog lock={lock} onCancel={vi.fn()} onUnlock={onUnlock} onUnlocked={onUnlocked} />);

    const unlock = screen.getByRole('button', { name: 'Unlock' });
    fireEvent.click(unlock);
    fireEvent.click(unlock);
    expect(onUnlock).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Unlocking...' })).toBeDisabled();
    expect(onUnlocked).not.toHaveBeenCalled();

    resolveUnlock();
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
  });

  it('keeps the dialog locked and shows the backend error when unlock fails', async () => {
    render(<UnlockTestDialog
      lock={lock}
      onCancel={vi.fn()}
      onUnlock={vi.fn().mockRejectedValue(new Error('Permission denied'))}
      onUnlocked={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
  });
});
