import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TestAccessLockedError,
  clearPendingHardLock,
  getPendingHardLock,
  rememberPendingHardLock,
  requestTestAccess,
} from './test-access';

describe('test access client', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('surfaces backend lock responses as a stable domain error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: 'Test Locked' }),
      { status: 423, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(requestTestAccess({
      path: '/getTest?id=test-1',
      method: 'GET',
      token: 'token',
    })).rejects.toBeInstanceOf(TestAccessLockedError);
  });

  it('retains one pending hard-lock incident across reload until backend confirms it', () => {
    rememberPendingHardLock({ testId: 'test-1', attemptId: 'attempt-1', studentUid: 'student-1' });
    rememberPendingHardLock({ testId: 'test-1', attemptId: 'attempt-1', studentUid: 'student-1' });

    expect(getPendingHardLock('test-1', 'student-1')).toEqual({
      testId: 'test-1',
      attemptId: 'attempt-1',
      studentUid: 'student-1',
      reason: 'screen_sharing_stopped',
    });

    clearPendingHardLock('test-1', 'student-1');
    expect(getPendingHardLock('test-1', 'student-1')).toBeNull();
  });
});
