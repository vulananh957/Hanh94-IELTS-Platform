'use client';

import { getAuth } from 'firebase/auth';
import { firebaseApp } from './firebase';

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'hanh94esl-71776';
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_FUNCTIONS_EMULATOR === 'true';
const FUNCTIONS_BASE_URL = USE_EMULATOR
  ? `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
  : `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;

export type TestAccessLock = {
  id: string;
  testId: string;
  testName: string;
  studentUid: string;
  studentName: string;
  studentEmail?: string;
  classId?: string;
  className?: string;
  status: 'locked' | 'unlocked';
  reason: 'screen_sharing_stopped';
  lockedAttemptId: string;
  lockedResultId?: string;
  lockedAt: string | null;
  unlockedAt?: string | null;
  unlockedBy?: string;
};

export type AssignedTestSummary = {
  id: string;
  name: string;
  skill: string;
  createdAt: string | null;
  classAssignment?: Record<string, unknown> | null;
  accessLock?: TestAccessLock | null;
};

export type PendingHardLock = {
  testId: string;
  attemptId: string;
  studentUid: string;
  reason: 'screen_sharing_stopped';
};

export class TestAccessLockedError extends Error {
  readonly status = 423;

  constructor(message = 'Test Locked') {
    super(message);
    this.name = 'TestAccessLockedError';
  }
}

export class TestAccessRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'TestAccessRequestError';
  }
}

function pendingKey(testId: string, studentUid: string): string {
  return `hanh94esl:pending-hard-lock:${testId}:${studentUid}`;
}

export function rememberPendingHardLock(input: Omit<PendingHardLock, 'reason'>): void {
  if (typeof localStorage === 'undefined') return;
  const incident: PendingHardLock = { ...input, reason: 'screen_sharing_stopped' };
  localStorage.setItem(pendingKey(input.testId, input.studentUid), JSON.stringify(incident));
}

export function getPendingHardLock(testId: string, studentUid: string): PendingHardLock | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingKey(testId, studentUid)) || 'null') as PendingHardLock | null;
    if (!parsed || parsed.testId !== testId || parsed.studentUid !== studentUid || !parsed.attemptId) return null;
    return { ...parsed, reason: 'screen_sharing_stopped' };
  } catch {
    return null;
  }
}

export function clearPendingHardLock(testId: string, studentUid: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(pendingKey(testId, studentUid));
}

export async function requestTestAccess<T>(input: {
  path: string;
  method: 'GET' | 'POST';
  token: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}${input.path}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = String(payload?.error || payload?.message || `Request failed (${response.status}).`);
  if (response.status === 423) throw new TestAccessLockedError(message);
  if (!response.ok) throw new TestAccessRequestError(message, response.status);
  return payload as T;
}

async function token(): Promise<string> {
  const currentUser = getAuth(firebaseApp).currentUser;
  if (!currentUser) throw new TestAccessRequestError('Please sign in again.', 401);
  return currentUser.getIdToken();
}

export async function fetchAssignedTestSummaries(): Promise<AssignedTestSummary[]> {
  const result = await requestTestAccess<{ tests: AssignedTestSummary[] }>({
    path: '/listAssignedTests',
    method: 'GET',
    token: await token(),
  });
  return result.tests || [];
}

export async function fetchTestAccessState(testId: string): Promise<{ status: 'locked' | 'unlocked'; lock: TestAccessLock | null }> {
  return requestTestAccess({
    path: `/getTestAccess?testId=${encodeURIComponent(testId)}`,
    method: 'GET',
    token: await token(),
  });
}

export async function hardLockAttempt(input: PendingHardLock): Promise<{ locked: boolean; attemptId: string }> {
  return requestTestAccess({
    path: '/lockTestAccess',
    method: 'POST',
    token: await token(),
    body: input,
  });
}

export async function listLockedTestAccess(testId?: string): Promise<TestAccessLock[]> {
  const query = testId ? `?testId=${encodeURIComponent(testId)}` : '';
  const result = await requestTestAccess<{ locks: TestAccessLock[] }>({
    path: `/listTestAccessLocks${query}`,
    method: 'GET',
    token: await token(),
  });
  return result.locks || [];
}

export async function unlockTestAccess(lock: Pick<TestAccessLock, 'testId' | 'studentUid' | 'lockedAttemptId'>): Promise<void> {
  await requestTestAccess({
    path: '/unlockTestAccess',
    method: 'POST',
    token: await token(),
    body: lock,
  });
}
