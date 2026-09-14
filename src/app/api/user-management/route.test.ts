// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), get: vi.fn(), query: vi.fn(), set: vi.fn() }));
vi.mock('@/services/firebase-admin', () => ({ firebaseAdminApp: {} }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mocks.verify }) }));
vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => 'timestamp' },
  getFirestore: () => ({ collection: () => ({
    doc: () => ({ get: mocks.get, set: mocks.set }),
    where: () => ({ limit: () => ({ get: mocks.query }) }),
  }) }),
}));
import { POST } from './route';
const request = (body: object) => new NextRequest('http://localhost/api/user-management', {
  method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ uid: 'student', email: 'student@example.com', email_verified: true });
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ role: 'student', classCode: 'A1' }) });
  mocks.query.mockResolvedValue({ empty: true }); mocks.set.mockResolvedValue(undefined);
});
describe('account management authorization', () => {
  it('does not let a student add a privileged user', async () => {
    const result = await POST(request({ action: 'addUser', email: 'other@example.com', role: 'teacher' }));
    expect(result.status).toBe(403); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('does not let login profile sync assign a role or move the user to another class', async () => {
    const result = await POST(request({ action: 'syncLogin', role: 'teacher', classCode: 'SECRET' }));
    expect(result.status).toBe(200);
    expect(mocks.set.mock.calls[0][0]).not.toHaveProperty('role');
    expect(mocks.set.mock.calls[0][0].classCode).toBe('A1');
  });
  it('does not let an unmanaged user self-provision via syncLogin', async () => {
    mocks.get.mockResolvedValue({ exists: false });
    const result = await POST(request({ action: 'syncLogin', role: 'teacher' }));
    expect(result.status).toBe(403); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('rejects profile sync for a different identity', async () => {
    expect((await POST(request({ action: 'syncLogin', email: 'other@example.com' }))).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('rejects disabled administrators before any action', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ role: 'teacher', accountStatus: 'disabled' }) });
    expect((await POST(request({ action: 'addUser', email: 'new@example.com', role: 'student' }))).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('preserves authorized teacher user creation', async () => {
    mocks.get.mockResolvedValueOnce({ exists: true, data: () => ({ role: 'teacher' }) }).mockResolvedValue({ exists: false });
    expect((await POST(request({ action: 'addUser', email: 'new@example.com', role: 'student' }))).status).toBe(200);
    expect(mocks.set.mock.calls[0][0]).toMatchObject({ email: 'new@example.com', role: 'student', status: 'active' });
  });
});
