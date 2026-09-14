import * as functions from 'firebase-functions/v1';
import { getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  canUseMaterialCapability,
  canTransitionAttemptToLocked,
  getAccessLockDocumentId,
  isAssignedToTest,
  resolveByteRange,
} from './test-access-policy';

if (getApps().length === 0) initializeApp();

const db = getFirestore();
const storage = getStorage();
const region = functions.region('us-central1');
const PUBLIC_FUNCTIONS_BASE = `https://us-central1-${process.env.GCLOUD_PROJECT || 'hanh94esl-71776'}.cloudfunctions.net`;
const MONITORING_LEASE_MS = 20_000;

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
  res.set('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
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

// A server-owned session marker prevents a second browser/device from starting
// another Attempt while the original client is retrying a hard-lock report.
function activeAttemptRef(testId: string, studentUid: string) {
  return db.collection('activeTestAttempts').doc(getAccessLockDocumentId(testId, studentUid));
}

function monitoringLeaseExpired(value: unknown): boolean {
  const timestamp = value instanceof Timestamp ? value.toMillis() : 0;
  return timestamp < Date.now() - MONITORING_LEASE_MS;
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

function storagePathFromUrl(value: unknown): string | null {
  const url = text(value);
  const marker = '/o/';
  const markerIndex = url.indexOf(marker);
  if (!url || markerIndex < 0) return null;
  const encodedPath = url.slice(markerIndex + marker.length).split('?')[0];
  try {
    const path = decodeURIComponent(encodedPath);
    return path.startsWith('tests/') ? path : null;
  } catch {
    return null;
  }
}

function materialPaths(value: unknown, paths = new Set<string>(), depth = 0): string[] {
  if (depth > 12 || value == null) return [...paths];
  if (typeof value === 'string') {
    const path = storagePathFromUrl(value);
    if (path) paths.add(path);
    return [...paths];
  }
  if (Array.isArray(value)) {
    value.forEach((item) => materialPaths(item, paths, depth + 1));
    return [...paths];
  }
  if (typeof value === 'object') {
    Object.values(asRecord(value)).forEach((item) => materialPaths(item, paths, depth + 1));
  }
  return [...paths];
}

function replaceMaterialUrls(value: unknown, sessionId: string, mediaTicket: string, materialBase: string, depth = 0): unknown {
  if (depth > 12 || value == null) return value;
  if (typeof value === 'string') {
    const path = storagePathFromUrl(value);
    return path ? materialProxyUrl(materialBase, sessionId, mediaTicket, path) : value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceMaterialUrls(item, sessionId, mediaTicket, materialBase, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(asRecord(value)).map(([key, item]) => [
      key,
      replaceMaterialUrls(item, sessionId, mediaTicket, materialBase, depth + 1),
    ]));
  }
  return value;
}

/*
 * Tests have historically stored upload URLs at several levels (files,
 * question image refs, and writing prompts), so this deliberately walks the
 * whole Test payload rather than relying on one schema branch.
 */
function testMaterialPaths(testData: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  materialPaths(testData, paths);
  return [...paths];
}

function materialProxyUrl(materialBase: string, sessionId: string, mediaTicket: string, path: string): string {
  return `${materialBase}/getTestMaterial?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(mediaTicket)}&path=${encodeURIComponent(path)}`;
}

function materialBaseForRequest(req: Request): string {
  const host = req.get('host') || '';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `http://${host}/${process.env.GCLOUD_PROJECT || 'hanh94esl-functions-test'}/us-central1`;
  }
  return PUBLIC_FUNCTIONS_BASE;
}

async function protectStudentTestMaterial(
  testId: string,
  actorUid: string,
  testData: Record<string, unknown>,
  materialBase: string,
  enforceStudentLock: boolean,
) {
  const paths = testMaterialPaths(testData);
  if (paths.length === 0) return testData;
  const sessionId = randomUUID();
  const mediaTicket = randomUUID();
  await db.collection('testMaterialSessions').doc(sessionId).create({
    testId,
    actorUid,
    enforceStudentLock,
    mediaTicket,
    paths,
    expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60_000),
    createdAt: FieldValue.serverTimestamp(),
  });
  return replaceMaterialUrls(testData, sessionId, mediaTicket, materialBase) as Record<string, unknown>;
}

async function revokeTestMaterialTokens(testId: string): Promise<boolean> {
  const testSnap = await db.collection('tests').doc(testId).get();
  if (!testSnap.exists) return true;
  const paths = testMaterialPaths(testSnap.data() || {});
  const outcomes = await Promise.all(paths.map(async (path) => {
    try {
      // Existing uploader-generated Firebase download URLs are bearer URLs.
      // Clearing their token prevents a cached raw URL from outliving a lock.
      await storage.bucket().file(path).setMetadata({ metadata: { firebaseStorageDownloadTokens: '' } });
      return true;
    } catch (error) {
      console.warn('[test-access] failed to revoke material token', { testId, path, error });
      return false;
    }
  }));
  return outcomes.every(Boolean);
}

// New uploads may still receive a Firebase download token from legacy upload
// clients. Remove it immediately so test material can only be fetched through
// the access-checked material endpoint.
export const removeNewTestMaterialDownloadToken = region.storage.object().onFinalize(async (object) => {
  const path = text(object.name);
  if (!path.startsWith('tests/') || !object.bucket) return;
  await storage.bucket(object.bucket).file(path).setMetadata({
    metadata: { firebaseStorageDownloadTokens: '' },
  });
});

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
    res.status(200).json({
      id: testSnap.id,
      ...(await protectStudentTestMaterial(testId, auth.decoded.uid, testData, materialBaseForRequest(req), true)),
    });
    return;
  }

  requireTeacher(auth);
  const testSnap = await db.collection('tests').doc(testId).get();
  if (!testSnap.exists) throw new HttpError(404, 'Test not found.');
  res.status(200).json({
    id: testSnap.id,
    ...(await protectStudentTestMaterial(
      testId,
      auth.decoded.uid,
      testSnap.data() || {},
      materialBaseForRequest(req),
      false,
    )),
  });
});

// Browser media elements cannot attach an Authorization header. The short-lived
// session plus per-session opaque ticket lets them stream without exposing an
// ID token, while every request still re-checks the student's current lock.
export const getTestMaterial = region.https.onRequest(async (req, res) => {
  if (setCors(req, res)) return;
  try {
    const sessionId = text(req.query.session);
    const ticket = text(req.query.ticket);
    const path = text(req.query.path);
    if (!sessionId || !ticket || !path) throw new HttpError(400, 'Missing material context.');
    const sessionSnap = await db.collection('testMaterialSessions').doc(sessionId).get();
    if (!sessionSnap.exists) throw new HttpError(404, 'Material session not found.');
    const session = sessionSnap.data() || {};
    const expiresAt = session.expiresAt instanceof Timestamp ? session.expiresAt.toMillis() : 0;
    const testId = text(session.testId);
    const actorUid = text(session.actorUid);
    const mediaTicket = text(session.mediaTicket);
    if (!testId || !actorUid || !canUseMaterialCapability({
      expectedTicket: mediaTicket,
      presentedTicket: ticket,
      expiresAtMs: expiresAt,
      nowMs: Date.now(),
      allowedPaths: session.paths,
      requestedPath: path,
    })) {
      throw new HttpError(403, 'Material access denied.');
    }
    if (session.enforceStudentLock === true) await assertUnlocked(testId, actorUid);
    const file = storage.bucket().file(path);
    const [metadata] = await file.getMetadata();
    const totalSize = Number(metadata.size);
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new HttpError(404, 'Material not found.');
    const requestedRange = text(req.get('range'));
    const resolvedRange = resolveByteRange(totalSize, requestedRange);
    if (!resolvedRange) {
      res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
      return;
    }
    const { start, end, partial } = resolvedRange;
    const contentLength = totalSize === 0 ? 0 : end - start + 1;
    res.set('Content-Type', String(metadata.contentType || 'application/octet-stream'));
    res.set('Cache-Control', 'private, no-store');
    res.set('Accept-Ranges', 'bytes');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Length', String(contentLength));
    if (partial) res.status(206).set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    file.createReadStream({ start, end })
      .on('error', (error) => {
        console.error('[test-access] material stream failed', error);
        if (!res.headersSent) res.status(404).json({ ok: false, error: 'Material not found.' });
        else res.end();
      })
      .pipe(res);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ ok: false, error: error.message });
      return;
    }
    console.error('[test-access] material request failed', error);
    res.status(500).json({ ok: false, error: 'Unable to load material.' });
  }
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
  const activeRef = activeAttemptRef(testId, auth.decoded.uid);

  let existing = false;
  await db.runTransaction(async (transaction) => {
    const [accessSnap, attemptSnap, activeSnap] = await Promise.all([
      transaction.get(accessRef),
      transaction.get(attemptRef),
      transaction.get(activeRef),
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
    if (activeSnap.exists) {
      throw new HttpError(409, 'An active attempt already exists for this test.');
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
    transaction.set(activeRef, {
      testId,
      studentUid: auth.decoded.uid,
      attemptId: attemptRef.id,
      startedAt: FieldValue.serverTimestamp(),
      lastMonitoringAt: FieldValue.serverTimestamp(),
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
  const activeRef = activeAttemptRef(testId, auth.decoded.uid);

  await db.runTransaction(async (transaction) => {
    const [accessSnap, attemptSnap, resultSnap, activeSnap] = await Promise.all([
      transaction.get(accessRef),
      transaction.get(attemptRef),
      transaction.get(resultRef),
      transaction.get(activeRef),
    ]);
    if (!attemptSnap.exists || !resultSnap.exists) throw new HttpError(404, 'Attempt not found.');
    const attempt = attemptSnap.data() || {};
    if (text(attempt.studentUid) !== auth.decoded.uid || text(attempt.testId) !== testId) {
      throw new HttpError(403, 'Forbidden.');
    }
    if (accessSnap.exists && lower(accessSnap.data()?.status) === 'locked') throw new HttpError(423, 'Test Locked');
    if (!activeSnap.exists || text(activeSnap.data()?.attemptId) !== attemptId || monitoringLeaseExpired(activeSnap.data()?.lastMonitoringAt)) {
      throw new HttpError(423, 'Monitoring connection expired.');
    }
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
  const activeRef = activeAttemptRef(testId, auth.decoded.uid);

  await db.runTransaction(async (transaction) => {
    const [accessSnap, attemptSnap, resultSnap, activeSnap] = await Promise.all([
      transaction.get(accessRef),
      transaction.get(attemptRef),
      transaction.get(resultRef),
      transaction.get(activeRef),
    ]);
    if (!attemptSnap.exists || !resultSnap.exists) throw new HttpError(404, 'Attempt not found.');
    const attempt = attemptSnap.data() || {};
    if (text(attempt.studentUid) !== auth.decoded.uid || text(attempt.testId) !== testId) {
      throw new HttpError(403, 'Forbidden.');
    }
    if (accessSnap.exists && lower(accessSnap.data()?.status) === 'locked') throw new HttpError(423, 'Test Locked');
    if (!activeSnap.exists || text(activeSnap.data()?.attemptId) !== attemptId || monitoringLeaseExpired(activeSnap.data()?.lastMonitoringAt)) {
      throw new HttpError(423, 'Monitoring connection expired.');
    }
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
    transaction.delete(activeRef);
  });

  res.status(200).json({ ok: true, resultId: resultRef.id });
});

export const monitorAttempt = onHttp(async (req, res, auth) => {
  requireStudent(auth);
  const testId = text(req.body?.testId);
  const attemptId = text(req.body?.attemptId);
  if (!testId || !attemptId) throw new HttpError(400, 'Missing monitoring context.');
  const accessRef = lockRef(testId, auth.decoded.uid);
  const activeRef = activeAttemptRef(testId, auth.decoded.uid);
  const attemptRef = db.collection('attempts').doc(attemptId);
  await db.runTransaction(async (transaction) => {
    const [accessSnap, activeSnap, attemptSnap] = await Promise.all([
      transaction.get(accessRef), transaction.get(activeRef), transaction.get(attemptRef),
    ]);
    if (accessSnap.exists && lower(accessSnap.data()?.status) === 'locked') throw new HttpError(423, 'Test Locked');
    if (!attemptSnap.exists || text(attemptSnap.data()?.studentUid) !== auth.decoded.uid || text(attemptSnap.data()?.testId) !== testId) {
      throw new HttpError(403, 'Forbidden.');
    }
    if (!activeSnap.exists || text(activeSnap.data()?.attemptId) !== attemptId || !canTransitionAttemptToLocked(attemptSnap.data()?.status)) {
      throw new HttpError(409, 'Attempt is no longer active.');
    }
    transaction.update(activeRef, { lastMonitoringAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  res.status(200).json({ ok: true });
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
  const activeRef = activeAttemptRef(testId, auth.decoded.uid);
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
      materialRevocationStatus: 'pending',
      materialRevocationUpdatedAt: FieldValue.serverTimestamp(),
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
        'antiCheat.violations': FieldValue.increment(1),
        violationCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    transaction.delete(activeRef);
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

  if (locked) {
    const materialsSecured = await revokeTestMaterialTokens(testId);
    await accessRef.update({
      materialRevocationStatus: materialsSecured ? 'complete' : 'pending',
      materialRevocationUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (!materialsSecured) {
      throw new HttpError(503, 'Test locked, but material revocation is still retrying.');
    }
  }

  res.status(200).json({ ok: true, locked, attemptId });
});

export const retryPendingMaterialRevocations = region.pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    const locks = await db.collection('testAccessLocks').where('status', '==', 'locked').get();
    await Promise.all(locks.docs
      .filter((lock) => text(lock.data().materialRevocationStatus) === 'pending')
      .map(async (lock) => {
        const secured = await revokeTestMaterialTokens(text(lock.data().testId));
        await lock.ref.update({
          materialRevocationStatus: secured ? 'complete' : 'pending',
          materialRevocationUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }));
    return null;
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
