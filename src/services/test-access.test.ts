import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthMock } = vi.hoisted(() => ({ getAuthMock: vi.fn() }));

vi.mock('firebase/auth', () => ({ getAuth: getAuthMock }));
vi.mock('./firebase', () => ({ firebaseApp: {} }));

import {
  TestAccessLockedError,
  clearPendingHardLock,
  fetchAccessibleTest,
  getPendingHardLock,
  hydrateProtectedMaterialUrls,
  rememberPendingHardLock,
  requestTestAccess,
} from './test-access';

describe('test access client', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    getAuthMock.mockReset();
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

  it('can return protected preview metadata without waiting for every material download', async () => {
    const getIdToken = vi.fn().mockResolvedValue('token');
    getAuthMock.mockReturnValue({
      currentUser: { getIdToken },
    });

    const delayedMaterial = new Promise<Response>(() => undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'test-1',
        files: {
          listeningPart1: 'https://example.test/getTestMaterial?session=session-1&path=tests%2Ftest-1%2Faudio.mp3',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockReturnValueOnce(delayedMaterial));

    await expect(fetchAccessibleTest('test-1', { hydrateMaterials: false })).resolves.toMatchObject({
      files: {
        listeningPart1: expect.stringContaining('/getTestMaterial'),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns streamable preview media without downloading complete blobs first', async () => {
    const getIdToken = vi.fn().mockResolvedValue('token');
    getAuthMock.mockReturnValue({ currentUser: { getIdToken } });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(() => undefined)));

    const mediaUrl = 'https://example.test/getTestMaterial?session=session-1&path=tests%2Ftest-1%2Faudio.mp3';
    await expect(hydrateProtectedMaterialUrls([mediaUrl], { stream: true })).resolves.toEqual([mediaUrl]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
