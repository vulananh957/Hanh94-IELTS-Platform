// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), get: vi.fn(), query: vi.fn(), set: vi.fn(), doc: vi.fn() }));
vi.mock('@/services/firebase-admin', () => ({ firebaseAdminApp: {} }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mocks.verify }) }));
vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => 'timestamp' },
  getFirestore: () => ({ collection: () => ({ doc: mocks.doc, where: () => ({ limit: () => ({ get: mocks.query }) }) }) }),
}));
import { POST } from './route';
const request = (token = 'token') => new NextRequest('http://localhost/api/auth/session', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ uid: 'u1', email: 'student@example.com', email_verified: true, role: 'teacher', name: 'Student' });
  mocks.doc.mockReturnValue({ get: mocks.get, set: mocks.set });
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ role: 'student', classCode: 'A1' }) });
  mocks.query.mockResolvedValue({ empty: true });
  mocks.set.mockResolvedValue(undefined);
});

describe('POST /api/auth/session', () => {
  it('uses the current managed role over stale claims and does not overwrite role/class', async () => {
    const result = await POST(request());
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ role: 'student' });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.verify).toHaveBeenCalledWith('token', true);
    const data = mocks.set.mock.calls[0][0];
    expect(data).not.toHaveProperty('role'); expect(data).not.toHaveProperty('classCode');
  });
  it.each([
    { status: 'disabled' }, { accountStatus: 'deleted' }, { status: 'active', accountStatus: 'inactive' },
    { isActive: false }, { disabled: true }, { deletedAt: 1 }, { removedAt: 1 },
  ])('rejects a disabled managed account: %j', async (flags) => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ role: 'teacher', ...flags }) });
    expect((await POST(request())).status).toBe(403); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('does not grant access to an unmanaged user without signed role claims', async () => {
    mocks.verify.mockResolvedValue({ uid: 'new', email: 'new@example.com', email_verified: true });
    mocks.get.mockResolvedValue({ exists: false });
    expect((await POST(request())).status).toBe(403); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('provisions a user with signed role claims before returning success', async () => {
    mocks.get.mockResolvedValue({ exists: false });
    let finish!: () => void; mocks.set.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    let completed = false;
    const result = POST(request()).then((value) => { completed = true; return value; });
    await vi.waitFor(() => expect(mocks.set).toHaveBeenCalled());
    expect(completed).toBe(false);
    expect(mocks.set.mock.calls[0][0]).toMatchObject({ role: 'teacher', email: 'student@example.com' });
    finish(); expect((await result).status).toBe(200);
  });
  it('requires a verified email', async () => {
    mocks.verify.mockResolvedValue({ email: 'student@example.com', email_verified: false });
    expect((await POST(request())).status).toBe(403);
  });
  it('rejects missing, expired, revoked and disabled credentials', async () => {
    expect((await POST(request(''))).status).toBe(401);
    for (const code of ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled']) {
      mocks.verify.mockRejectedValue({ code }); expect((await POST(request())).status).toBe(401);
    }
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('reports service failure separately from access denial', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.get.mockRejectedValue(new Error('unavailable'));
    expect((await POST(request())).status).toBe(503); log.mockRestore();
  });
});
