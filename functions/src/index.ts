import * as functions from 'firebase-functions/v1';
import { getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import type { Request, Response } from 'express';
import {
  canTransitionAttemptToLocked,
  getAccessLockDocumentId,
  isAssignedToTest,
} from './test-access-policy';

if (getApps().length === 0) initializeApp();

const db = getFirestore();
const region = functions.region('us-central1');

type AuthContext = {
  decoded: DecodedIdToken;
  email: string;
  role: string;
  userData: Record<string, unknown>;
};

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeRequestId(value: unknown): string | null {
  const normalized = text(value);
  return /^[A-Za-z0-9_-]{12,160}$/.test(normalized) ? normalized : null;
}

function setCors(req: Request, res: Response): boolean {
  res.set('Access-Control-Allow-Origin', req.get('origin') || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

async function authenticate(req: Request): Promise<AuthContext> {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'Unauthorized.');

  const decoded = await getAuth().verifyIdToken(authorization.slice(7), true);
  const email = lower(decoded.email);
  if (!email) throw new HttpError(401, 'Unauthorized.');

  const userSnap = await db.collection('users').doc(email).get();
  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const role = lower(decoded.role || decoded.userRole || userData.role);
  return { decoded, email, role, userData };
}

function requireStudent(auth: AuthContext): void {
  if (auth.role !== 'student') throw new HttpError(403, 'Student access required.');
}

function requireTeacher(auth: AuthContext): void {
  if (!['teacher', 'testcreator', 'admin'].includes(auth.role)) {
    throw new HttpError(403, 'Teacher or administrator access required.');
  }
}

async function resolveStudentProfile(auth: AuthContext) {
  let classId = text(auth.userData.classId);
  let classCode = text(auth.userData.classCode);
  let className = '';

  const candidates = [classId, classCode].filter(Boolean);
  for (const candidate of candidates) {
    const classSnap = await db.collection('classes').doc(candidate).get();
    if (classSnap.exists) {
      classId = classSnap.id;
      classCode = text(classSnap.data()?.code) || classCode || classSnap.id;
      className = text(classSnap.data()?.name) || classCode;
      break;
    }
  }

  if (!className && classCode) {
    const classQuery = await db.collection('classes').where('code', '==', classCode).limit(1).get();
    if (!classQuery.empty) {
      const classSnap = classQuery.docs[0];
      classId = classSnap.id;
      classCode = text(classSnap.data().code) || classCode;
      className = text(classSnap.data().name) || classCode;
    }
  }

  return {
    classId: classId || null,
    classCode: classCode || null,
    className: className || 'Chưa xếp lớp',
    studentName: text(auth.userData.displayName || auth.userData.name || auth.decoded.name)
      || auth.email.split('@')[0]
      || 'Student',
  };
}

async function requireAssignedTest(auth: AuthContext, testId: string) {
  requireStudent(auth);
  if (!testId) throw new HttpError(400, 'Missing test ID.');

  const [testSnap, profile] = await Promise.all([
    db.collection('tests').doc(testId).get(),
    resolveStudentProfile(auth),
  ]);
  if (!testSnap.exists) throw new HttpError(404, 'Test not found.');

  const testData = testSnap.data() || {};
  const assignment = asRecord(testData.classAssignment);
  if (!isAssignedToTest(assignment, profile)) {
    throw new HttpError(403, 'This test is not assigned to your class.');
  }

  return { testSnap, testData, profile };
}

function lockRef(testId: string, studentUid: string) {
  return db.collection('testAccessLocks').doc(getAccessLockDocumentId(testId, studentUid));
}

async function assertUnlocked(testId: string, studentUid: string): Promise<void> {
  const snap = await lockRef(testId, studentUid).get();
  if (snap.exists && lower(snap.data()?.status) === 'locked') {
    throw new HttpError(423, 'Test Locked');
  }
}

function serializeTimestamp(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  const record = asRecord(value);
  const seconds = Number(record.seconds ?? record._seconds);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function publicLock(docId: string, data: Record<string, unknown>) {
  return {
    id: docId,
    testId: text(data.testId),
    testName: text(data.testName),
    studentUid: text(data.studentUid),
    studentName: text(data.studentName),
    studentEmail: text(data.studentEmail) || undefined,
    classId: text(data.classId) || undefined,
    className: text(data.className) || undefined,
    status: lower(data.status),
    reason: lower(data.reason),
    lockedAttemptId: text(data.lockedAttemptId),
    lockedResultId: text(data.lockedResultId) || undefined,
    lockedAt: serializeTimestamp(data.lockedAt),
    unlockedAt: serializeTimestamp(data.unlockedAt),
    unlockedBy: text(data.unlockedBy) || undefined,
  };
}

function onHttp(handler: (req: Request, res: Response, auth: AuthContext) => Promise<void>) {
  return region.https.onRequest(async (req, res) => {
    if (setCors(req, res)) return;
    try {
      const auth = await authenticate(req);
      await handler(req, res, auth);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ ok: false, error: error.message });
        return;
      }
      const code = text((error as { code?: unknown })?.code);
      if (code.startsWith('auth/')) {
        res.status(401).json({ ok: false, error: 'Unauthorized.' });
        return;
      }
      console.error('[test-access]', error);
      res.status(500).json({ ok: false, error: 'Internal server error.' });
    }
  });
}

export const getTest = onHttp(async (req, res, auth) => {
  const testId = text(req.query.id || req.query.testId);
  if (auth.role === 'student') {
    const { testSnap, testData } = await requireAssignedTest(auth, testId);
    await assertUnlocked(testId, auth.decoded.uid);
    res.status(200).json({ id: testSnap.id, ...testData });
    return;
  }

  requireTeacher(auth);
  const testSnap = await db.collection('tests').doc(testId).get();
  if (!testSnap.exists) throw new HttpError(404, 'Test not found.');
  res.status(200).json({ id: testSnap.id, ...testSnap.data() });
});

export const getTestAccess = onHttp(async (req, res, auth) => {
  requireStudent(auth);
  const testId = text(req.query.testId);
  const snap = await lockRef(testId, auth.decoded.uid).get();
  const data = snap.data() || {};
  res.status(200).json({
    ok: true,
    status: snap.exists ? lower(data.status) : 'unlocked',
    lock: snap.exists ? publicLock(snap.id, data) : null,
  });
});

async function getAssignedTestSummaries(auth: AuthContext) {
  const profile = await resolveStudentProfile(auth);
  requireStudent(auth);
  const [testsSnap, locksSnap] = await Promise.all([
    db.collection('tests').get(),
    db.collection('testAccessLocks').where('studentUid', '==', auth.decoded.uid).get(),
  ]);
  const locks = new Map(
    locksSnap.docs.map((item) => [text(item.data().testId), publicLock(item.id, item.data())]),
  );

  return testsSnap.docs
    .filter((item) => isAssignedToTest(asRecord(item.data().classAssignment), profile))
    .map((item) => {
      const data = item.data();
      const accessLock = locks.get(item.id);
      return {
        id: item.id,
        name: text(data.name || data.testName) || 'Untitled Test',
        skill: lower(data.skill) || 'unknown',
        createdAt: serializeTimestamp(data.createdAt || data.updatedAt || data.uploadedAt),
        classAssignment: data.classAssignment || null,
        accessLock: accessLock?.status === 'locked' ? accessLock : null,
      };
    });
}

export const listAssignedTests = onHttp(async (_req, res, auth) => {
  res.status(200).json({ ok: true, tests: await getAssignedTestSummaries(auth) });
});

// Preserve the legacy endpoint name without exposing full Test documents to
// Students. Privileged callers retain the prior full-list behavior.
export const listTests = onHttp(async (_req, res, auth) => {
  if (auth.role === 'student') {
    res.status(200).json({ ok: true, tests: await getAssignedTestSummaries(auth) });
    return;
  }
  requireTeacher(auth);
  const testsSnap = await db.collection('tests').get();
  res.status(200).json({ ok: true, tests: testsSnap.docs.map((item) => ({ id: item.id, ...item.data() })) });
});

export const startAttempt = onHttp(async (req, res, auth) => {
  const testId = text(req.body?.testId);
  const { testData, profile } = await requireAssignedTest(auth, testId);
  const requestId = safeRequestId(req.body?.requestId);
  const attemptRef = requestId
    ? db.collection('attempts').doc(`${auth.decoded.uid}--${testId}--${requestId}`)
    : db.collection('attempts').doc();
  const resultRef = db.collection('testResults').doc(attemptRef.id);
  const accessRef = lockRef(testId, auth.decoded.uid);

  let existing = false;
  await db.runTransaction(async (transaction) => {
    const [accessSnap, attemptSnap] = await Promise.all([
      transaction.get(accessRef),
      transaction.get(attemptRef),
    ]);
    if (accessSnap.exists && lower(accessSnap.data()?.status) === 'locked') {
      throw new HttpError(423, 'Test Locked');
    }
    if (attemptSnap.exists) {
      if (text(attemptSnap.data()?.studentUid) !== auth.decoded.uid || text(attemptSnap.data()?.testId) !== testId) {
        throw new HttpError(409, 'Attempt request conflict.');
      }
      existing = true;
      return;
    }

    const identity = {
      testId,
      testName: text(testData.name || testData.testName) || 'Untitled Test',
      testType: lower(testData.skill) || 'reading',
      studentUid: auth.decoded.uid,
      studentEmail: auth.email,
      studentName: profile.studentName,
      classId: profile.classId,
      className: profile.className,
      testOwnerUid: text(testData.ownerUid) || null,
      attemptId: attemptRef.id,
    };
    transaction.create(attemptRef, {
      ...identity,
      status: 'in_progress',
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(resultRef, {
      ...identity,
      status: 'in_progress',
      answers: {},
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  res.status(200).json({
    ok: true,
    attemptId: attemptRef.id,
    resultId: resultRef.id,
    attemptStartedAt: new Date().toISOString(),
    className: profile.className,
    existing,
  });
});

export const saveAnswers = onHttp(async (req, res, auth) => {
  requireStudent(auth);
  const testId = text(req.body?.testId);
  const attemptId = text(req.body?.attemptId);
  const attemptRef = db.collection('attempts').doc(attemptId);
  const resultRef = db.collection('testResults').doc(attemptId);
  const accessRef = lockRef(testId, auth.decoded.uid);

  await db.runTransaction(async (transaction) => {
    const [accessSnap, attemptSnap, resultSnap] = await Promise.all([
      transaction.get(accessRef),
      transaction.get(attemptRef),
      transaction.get(resultRef),
    ]);
    if (!attemptSnap.exists || !resultSnap.exists) throw new HttpError(404, 'Attempt not found.');
    const attempt = attemptSnap.data() || {};
    if (text(attempt.studentUid) !== auth.decoded.uid || text(attempt.testId) !== testId) {
      throw new HttpError(403, 'Forbidden.');
    }
    if (accessSnap.exists && lower(accessSnap.data()?.status) === 'locked') throw new HttpError(423, 'Test Locked');
    if (!canTransitionAttemptToLocked(attempt.status)) throw new HttpError(409, 'Attempt is no longer active.');

    transaction.update(resultRef, {
      answers: asRecord(req.body?.answers),
      antiCheat: asRecord(req.body?.antiCheat),
      lastAutosaveAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  res.status(200).json({ ok: true });
});

export const submitAttempt = onHttp(async (req, res, auth) => {
  requireStudent(auth);
  const testId = text(req.body?.testId);
  const attemptId = text(req.body?.attemptId);
  const attemptRef = db.collection('attempts').doc(attemptId);
  const resultRef = db.collection('testResults').doc(attemptId);
  const accessRef = lockRef(testId, auth.decoded.uid);

  await db.runTransaction(async (transaction) => {
    const [accessSnap, attemptSnap, resultSnap] = await Promise.all([
      transaction.get(accessRef),
      transaction.get(attemptRef),
      transaction.get(resultRef),
    ]);
    if (!attemptSnap.exists || !resultSnap.exists) throw new HttpError(404, 'Attempt not found.');
    const attempt = attemptSnap.data() || {};
    if (text(attempt.studentUid) !== auth.decoded.uid || text(attempt.testId) !== testId) {
      throw new HttpError(403, 'Forbidden.');
    }
    if (accessSnap.exists && lower(accessSnap.data()?.status) === 'locked') throw new HttpError(423, 'Test Locked');
    if (!canTransitionAttemptToLocked(attempt.status)) throw new HttpError(409, 'Attempt is no longer active.');

    const testType = lower(attempt.testType);
    const status = testType === 'writing' ? 'pending' : 'completed';
    const submitted = {
      status,
      answers: asRecord(req.body?.answers),
      antiCheat: asRecord(req.body?.antiCheat),
      timeSpent: Math.max(0, Number(req.body?.timeSpent) || 0),
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(testType === 'writing'
        ? { wordCounts: asRecord(req.body?.wordCounts) }
        : {
            correctAnswers: Math.max(0, Number(req.body?.correctAnswers) || 0),
            totalQuestions: Math.max(0, Number(req.body?.totalQuestions) || 0),
            ieltsBand: Math.max(0, Number(req.body?.ieltsBand) || 0),
          }),
    };
    transaction.update(resultRef, submitted);
    transaction.update(attemptRef, {
      status: 'completed',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      antiCheat: submitted.antiCheat,
    });
  });

  res.status(200).json({ ok: true, resultId: resultRef.id });
});

export const lockTestAccess = onHttp(async (req, res, auth) => {
  requireStudent(auth);
  const testId = text(req.body?.testId);
  const attemptId = text(req.body?.attemptId);
  const reason = lower(req.body?.reason);
  if (reason !== 'screen_sharing_stopped') throw new HttpError(400, 'Unsupported lock reason.');
  if (!testId || !attemptId) throw new HttpError(400, 'Missing lock context.');

  const attemptRef = db.collection('attempts').doc(attemptId);
  const resultRef = db.collection('testResults').doc(attemptId);
  const accessRef = lockRef(testId, auth.decoded.uid);
  const eventRef = accessRef.collection('events').doc(`locked--${attemptId}`);
  const violationRef = attemptRef.collection('violations').doc('screen-sharing-stopped');
  let locked = false;

  await db.runTransaction(async (transaction) => {
    const [attemptSnap, resultSnap, accessSnap, eventSnap, violationSnap] = await Promise.all([
      transaction.get(attemptRef),
      transaction.get(resultRef),
      transaction.get(accessRef),
      transaction.get(eventRef),
      transaction.get(violationRef),
    ]);
    if (!attemptSnap.exists) throw new HttpError(404, 'Attempt not found.');
    const attempt = attemptSnap.data() || {};
    if (text(attempt.studentUid) !== auth.decoded.uid || text(attempt.testId) !== testId) {
      throw new HttpError(403, 'Forbidden.');
    }

    if (accessSnap.exists && lower(accessSnap.data()?.status) === 'locked') {
      if (text(accessSnap.data()?.lockedAttemptId) !== attemptId) {
        throw new HttpError(409, 'Another attempt is already locked.');
      }
      locked = true;
      return;
    }
    if (!canTransitionAttemptToLocked(attempt.status)) return;

    const lockData = {
      testId,
      testName: text(attempt.testName) || 'Untitled Test',
      studentUid: auth.decoded.uid,
      studentName: text(attempt.studentName) || auth.email.split('@')[0],
      studentEmail: auth.email,
      classId: text(attempt.classId) || null,
      className: text(attempt.className) || null,
      status: 'locked',
      reason: 'screen_sharing_stopped',
      lockedAttemptId: attemptId,
      lockedResultId: resultSnap.exists ? resultRef.id : null,
      lockedAt: FieldValue.serverTimestamp(),
      unlockedAt: null,
      unlockedBy: null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(accessRef, lockData, { merge: true });
    transaction.update(attemptRef, {
      status: 'locked',
      terminationReason: 'screen_sharing_stopped',
      terminatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (resultSnap.exists) {
      transaction.update(resultRef, {
        status: 'locked',
        lockReason: 'screen_sharing_stopped',
        lockedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (!eventSnap.exists) {
      transaction.create(eventRef, {
        event: 'locked',
        previousStatus: accessSnap.exists ? lower(accessSnap.data()?.status) || 'unlocked' : 'unlocked',
        status: 'locked',
        reason: 'screen_sharing_stopped',
        testId,
        studentUid: auth.decoded.uid,
        attemptId,
        resultId: resultSnap.exists ? resultRef.id : null,
        actorUid: auth.decoded.uid,
        actorRole: 'student',
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    if (!violationSnap.exists) {
      transaction.create(violationRef, {
        type: 'screen_sharing_stopped',
        description: 'Entire screen sharing stopped during the active attempt',
        attemptId,
        testId,
        studentUid: auth.decoded.uid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    locked = true;
  });

  res.status(200).json({ ok: true, locked, attemptId });
});

export const listTestAccessLocks = onHttp(async (req, res, auth) => {
  requireTeacher(auth);
  const testId = text(req.query.testId);
  const locksSnap = await db.collection('testAccessLocks').where('status', '==', 'locked').get();
  const locks = locksSnap.docs
    .map((item) => publicLock(item.id, item.data()))
    .filter((item) => !testId || item.testId === testId)
    .sort((a, b) => String(b.lockedAt).localeCompare(String(a.lockedAt)));
  res.status(200).json({ ok: true, locks });
});

export const unlockTestAccess = onHttp(async (req, res, auth) => {
  requireTeacher(auth);
  const testId = text(req.body?.testId);
  const studentUid = text(req.body?.studentUid);
  const expectedAttemptId = text(req.body?.lockedAttemptId);
  if (!testId || !studentUid) throw new HttpError(400, 'Missing unlock context.');

  const accessRef = lockRef(testId, studentUid);
  let changed = false;
  await db.runTransaction(async (transaction) => {
    const accessSnap = await transaction.get(accessRef);
    if (!accessSnap.exists) throw new HttpError(404, 'Lock not found.');
    const access = accessSnap.data() || {};
    if (text(access.testId) !== testId || text(access.studentUid) !== studentUid) {
      throw new HttpError(409, 'Lock identity mismatch.');
    }
    const lockedAttemptId = text(access.lockedAttemptId);
    if (expectedAttemptId && expectedAttemptId !== lockedAttemptId) {
      throw new HttpError(409, 'Locked attempt changed. Refresh and try again.');
    }
    if (lower(access.status) === 'unlocked') return;
    if (lower(access.status) !== 'locked') throw new HttpError(409, 'Lock is not active.');

    const eventRef = accessRef.collection('events').doc(`unlocked--${lockedAttemptId}`);
    const eventSnap = await transaction.get(eventRef);
    transaction.update(accessRef, {
      status: 'unlocked',
      unlockedAt: FieldValue.serverTimestamp(),
      unlockedBy: auth.decoded.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (!eventSnap.exists) {
      transaction.create(eventRef, {
        event: 'unlocked',
        previousStatus: 'locked',
        status: 'unlocked',
        reason: text(access.reason) || 'screen_sharing_stopped',
        testId,
        studentUid,
        attemptId: lockedAttemptId,
        resultId: text(access.lockedResultId) || null,
        actorUid: auth.decoded.uid,
        actorRole: auth.role,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    changed = true;
  });

  res.status(200).json({ ok: true, status: 'unlocked', changed });
});
