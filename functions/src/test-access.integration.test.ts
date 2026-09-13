// @vitest-environment node

import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, Timestamp } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const projectId = 'hanh94esl-functions-test';
const functionsBase = `http://127.0.0.1:5101/${projectId}/us-central1`;
const authBase = 'http://127.0.0.1:9098';
let testEnv: RulesTestEnvironment;

async function createUser(email: string, role: 'student' | 'teacher') {
  const response = await fetch(`${authBase}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password-123', returnSecureToken: true }),
  });
  const account = await response.json() as { idToken: string; localId: string };
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', email), {
      email,
      role,
      name: role === 'teacher' ? 'Teacher One' : 'Student One',
      classId: role === 'student' ? 'class-a' : null,
      classCode: role === 'student' ? 'A' : null,
    });
  });
  return { token: account.idToken, uid: account.localId };
}

async function callFunction<T>(name: string, token: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${functionsBase}/${name}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as T };
}

async function callUnauthenticated(name: string): Promise<number> {
  const response = await fetch(`${functionsBase}/${name}`);
  return response.status;
}

const describeWithEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

describeWithEmulator('test access Functions', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({ projectId });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await Promise.all([
        setDoc(doc(db, 'classes', 'class-a'), { code: 'A', name: 'IELTS Class A' }),
        setDoc(doc(db, 'tests', 'test-a'), {
          name: 'Reading Test',
          skill: 'reading',
          answerKey: { 1: 'A' },
          metadata: { duration: 60 },
          classAssignment: { distribution: 'specific', selectedClasses: ['class-a'] },
        }),
        setDoc(doc(db, 'tests', 'test-b'), {
          name: 'Listening Test',
          skill: 'listening',
          answerKey: { 1: 'private-answer' },
          classAssignment: { distribution: 'specific', selectedClasses: ['class-a'] },
        }),
      ]);
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('locks one active attempt idempotently, rejects further writes, and starts clean after teacher unlock', async () => {
    const student = await createUser('student@example.com', 'student');
    const otherStudent = await createUser('other@example.com', 'student');
    const teacher = await createUser('teacher@example.com', 'teacher');

    const firstStart = await callFunction<{ attemptId: string; resultId: string }>('startAttempt', student.token, {
      testId: 'test-a', requestId: 'request-first-attempt',
    });
    expect(firstStart.status).toBe(200);

    const duplicateStart = await callFunction<{ attemptId: string }>('startAttempt', student.token, {
      testId: 'test-a', requestId: 'request-first-attempt',
    });
    expect(duplicateStart.data.attemptId).toBe(firstStart.data.attemptId);
    expect((await callFunction('startAttempt', student.token, {
      testId: 'test-a', requestId: 'request-second-browser',
    })).status).toBe(409);
    expect((await callFunction('monitorAttempt', student.token, {
      testId: 'test-a', attemptId: firstStart.data.attemptId,
    })).status).toBe(200);

    const lockBody = {
      testId: 'test-a',
      attemptId: firstStart.data.attemptId,
      studentUid: student.uid,
      reason: 'screen_sharing_stopped',
    };
    expect((await callFunction<{ locked: boolean }>('lockTestAccess', student.token, lockBody)).data.locked).toBe(true);
    expect((await callFunction<{ locked: boolean }>('lockTestAccess', student.token, lockBody)).data.locked).toBe(true);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'testMaterialSessions', 'locked-material-session'), {
        testId: 'test-a', actorUid: student.uid, enforceStudentLock: true, paths: ['tests/reading.pdf'],
        expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
      });
    });
    expect(await callUnauthenticated('getTestMaterial?session=locked-material-session&path=tests%2Freading.pdf')).toBe(401);
    expect((await callFunction('getTestMaterial?session=locked-material-session&path=tests%2Freading.pdf', otherStudent.token)).status).toBe(403);
    expect((await callFunction('getTestMaterial?session=locked-material-session&path=tests%2Freading.pdf', student.token)).status).toBe(423);

    expect((await callFunction('saveAnswers', student.token, {
      testId: 'test-a', attemptId: firstStart.data.attemptId, answers: { 1: 'A' },
    })).status).toBe(423);
    expect((await callFunction('submitAttempt', student.token, {
      testId: 'test-a', attemptId: firstStart.data.attemptId, answers: { 1: 'A' },
    })).status).toBe(423);
    expect((await callFunction('startAttempt', student.token, {
      testId: 'test-a', requestId: 'request-blocked-attempt',
    })).status).toBe(423);
    expect((await callFunction('getTest?id=test-a', student.token)).status).toBe(423);
    expect((await callFunction('getTest?id=test-b', student.token)).status).toBe(200);
    expect((await callFunction('unlockTestAccess', student.token, {
      testId: 'test-a', studentUid: student.uid, lockedAttemptId: firstStart.data.attemptId,
    })).status).toBe(403);

    const teacherLocks = await callFunction<{ locks: Array<{ lockedAttemptId: string }> }>(
      'listTestAccessLocks?testId=test-a', teacher.token,
    );
    expect(teacherLocks.status).toBe(200);
    expect(teacherLocks.data.locks).toEqual([
      expect.objectContaining({ lockedAttemptId: firstStart.data.attemptId }),
    ]);

    const studentList = await callFunction<{ tests: Array<Record<string, unknown>> }>('listTests', student.token);
    expect(studentList.status).toBe(200);
    expect(studentList.data.tests.find((test) => test.id === 'test-a')).not.toHaveProperty('answerKey');

    const lockId = `test-a--${student.uid}`;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const lockSnap = await getDoc(doc(db, 'testAccessLocks', lockId));
      expect(lockSnap.data()?.status).toBe('locked');
      expect(lockSnap.data()?.lockedAttemptId).toBe(firstStart.data.attemptId);
      expect((await getDoc(doc(db, 'attempts', firstStart.data.attemptId))).data()?.status).toBe('locked');
      expect((await getDocs(collection(db, 'testAccessLocks', lockId, 'events'))).size).toBe(1);
    });

    const unlockBody = { testId: 'test-a', studentUid: student.uid, lockedAttemptId: firstStart.data.attemptId };
    expect((await callFunction<{ changed: boolean }>('unlockTestAccess', teacher.token, unlockBody)).data.changed).toBe(true);
    expect((await callFunction<{ changed: boolean }>('unlockTestAccess', teacher.token, unlockBody)).data.changed).toBe(false);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      expect((await getDocs(collection(context.firestore(), 'testAccessLocks', lockId, 'events'))).size).toBe(2);
    });

    const secondStart = await callFunction<{ attemptId: string; resultId: string }>('startAttempt', student.token, {
      testId: 'test-a', requestId: 'request-second-attempt',
    });
    expect(secondStart.status).toBe(200);
    expect(secondStart.data.attemptId).not.toBe(firstStart.data.attemptId);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      expect((await getDoc(doc(db, 'testResults', secondStart.data.resultId))).data()?.answers).toEqual({});
      expect((await getDoc(doc(db, 'attempts', firstStart.data.attemptId))).data()?.status).toBe('locked');
    });
  }, 20_000);

  it('does not lock an attempt after normal submission wins the race', async () => {
    const student = await createUser('normal@example.com', 'student');
    const start = await callFunction<{ attemptId: string }>('startAttempt', student.token, {
      testId: 'test-a', requestId: 'request-normal-attempt',
    });
    expect((await callFunction('submitAttempt', student.token, {
      testId: 'test-a', attemptId: start.data.attemptId, answers: { 1: 'A' },
    })).status).toBe(200);
    const lock = await callFunction<{ locked: boolean }>('lockTestAccess', student.token, {
      testId: 'test-a', attemptId: start.data.attemptId, reason: 'screen_sharing_stopped',
    });
    expect(lock.status).toBe(200);
    expect(lock.data.locked).toBe(false);
    await testEnv.withSecurityRulesDisabled(async (context) => {
      expect((await getDoc(doc(context.firestore(), 'testAccessLocks', `test-a--${student.uid}`))).exists()).toBe(false);
    });
  }, 20_000);
});
