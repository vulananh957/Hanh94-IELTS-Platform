import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { firebaseApp } from './firebase';
import { buildClassAssignmentWithOpenedTimes } from '@/lib/class-assignment-timing';

export type TestSkill = 'all' | 'listening' | 'reading' | 'writing' | 'speaking' | 'unknown';

export interface TestHubClass {
  id: string;
  code: string;
  name: string;
}

export interface TestHubStudent {
  id: string;
  email: string;
  name: string;
  displayName?: string;
  photoURL?: string;
  classCode?: string;
  classId?: string;
}

export interface TestHubTest {
  id: string;
  name: string;
  skill: TestSkill;
  createdAt: Date | null;
  filesCount: number;
  distribution: 'all' | 'specific';
  selectedClasses: string[];
}

export interface TestHubPayload {
  tests: TestHubTest[];
  classes: TestHubClass[];
  students: TestHubStudent[];
}

const CACHE_DURATION = 90 * 1000;
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'hanh94esl-71776';
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_FUNCTIONS_EMULATOR === 'true';
const FUNCTIONS_BASE_URL = USE_EMULATOR
  ? `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
  : `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;

const requestMap = new Map<string, Promise<TestHubPayload>>();

function getTokenFromStorageBag(bag: Storage): string | null {
  const key = Object.keys(bag).find((item) => item.startsWith('firebase:authUser'));
  if (!key) return null;

  try {
    const raw = bag.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { stsTokenManager?: { accessToken?: string } };
    return parsed?.stsTokenManager?.accessToken || null;
  } catch {
    return null;
  }
}

async function getIdToken(): Promise<string> {
  const auth = getAuth(firebaseApp);

  if (auth.currentUser) {
    return auth.currentUser.getIdToken();
  }

  if (typeof window !== 'undefined') {
    const localToken = getTokenFromStorageBag(localStorage);
    if (localToken) return localToken;

    const sessionToken = getTokenFromStorageBag(sessionStorage);
    if (sessionToken) return sessionToken;
  }

  throw new Error('Unable to find Firebase ID token. Please sign in again.');
}

async function deleteTestViaCloudFunction(testId: string): Promise<boolean> {
  const token = await getIdToken();
  const candidates = ['/deleteTest', '/deleteTestById'];

  for (const path of candidates) {
    const response = await fetch(`${FUNCTIONS_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ testId }),
    });

    if (response.ok) {
      return true;
    }

    if (response.status === 404) {
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Delete test is not permitted for this account. Please check your permissions.');
    }

    const errorText = await response.text().catch(() => '');
    throw new Error(`Cloud Function ${path} failed (${response.status}): ${errorText}`);
  }

  return false;
}

function toStringSafe(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function toDateSafe(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'object' && value !== null && 'toDate' in value && typeof (value as any).toDate === 'function') {
    const d = (value as any).toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  const parsed = new Date(value as any);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSkill(value: unknown): TestSkill {
  const key = toStringSafe(value, '').trim().toLowerCase();
  if (key === 'listening' || key === 'reading' || key === 'writing' || key === 'speaking') return key;
  return 'unknown';
}

function extractFilesCount(data: Record<string, unknown>): number {
  const files = data.files;
  if (Array.isArray(files)) return files.length;
  if (files && typeof files === 'object') return Object.keys(files as Record<string, unknown>).length;

  const candidates = [
    data.readingSections,
    data.listeningSections,
    data.writingTasks,
    data.questions,
  ];

  let total = 0;
  candidates.forEach((value) => {
    if (Array.isArray(value)) total += value.length;
  });

  return total || 1;
}

function getCacheKeys(teacherEmail: string) {
  const key = `test_hub_${teacherEmail}`;
  return { key, timeKey: `${key}_time` };
}

function normalizePayload(payload: TestHubPayload): TestHubPayload {
  return {
    tests: payload.tests.map((test) => ({
      ...test,
      createdAt: toDateSafe(test.createdAt),
      selectedClasses: Array.isArray(test.selectedClasses)
        ? test.selectedClasses.map((value) => toStringSafe(value, '').trim()).filter(Boolean)
        : [],
    })),
    classes: payload.classes.map((cls) => ({
      ...cls,
      code: toStringSafe(cls.code, '').trim(),
      name: toStringSafe(cls.name, '').trim(),
    })),
    students: payload.students.map((student) => ({
      ...student,
      email: toStringSafe(student.email, '').trim(),
      name: toStringSafe(student.name, '').trim(),
      displayName: student.displayName ? toStringSafe(student.displayName, '').trim() || undefined : undefined,
      photoURL: student.photoURL ? toStringSafe(student.photoURL, '').trim() || undefined : undefined,
      classCode: student.classCode ? toStringSafe(student.classCode, '').trim() || undefined : undefined,
      classId: student.classId ? toStringSafe(student.classId, '').trim() || undefined : undefined,
    })),
  };
}

export function invalidateTestHubCache(teacherEmail: string): void {
  const { key, timeKey } = getCacheKeys(teacherEmail);
  if (typeof window !== 'undefined') {
    localStorage.removeItem(key);
    localStorage.removeItem(timeKey);
  }
  requestMap.delete(teacherEmail);
}

export async function getTestHubData(teacherEmail: string, forceFresh = false): Promise<TestHubPayload> {
  if (!forceFresh && requestMap.has(teacherEmail)) {
    return requestMap.get(teacherEmail)!;
  }

  const db = getFirestore(firebaseApp);
  const { key, timeKey } = getCacheKeys(teacherEmail);

  if (!forceFresh && typeof window !== 'undefined') {
    const cached = localStorage.getItem(key);
    const cachedTime = localStorage.getItem(timeKey);
    if (cached && cachedTime && Date.now() - Number(cachedTime) < CACHE_DURATION) {
      return normalizePayload(JSON.parse(cached) as TestHubPayload);
    }
  }

  const promise = (async () => {
    const [testsSnapshot, classesSnapshot, usersSnapshot] = await Promise.all([
      getDocs(collection(db, 'tests')),
      getDocs(collection(db, 'classes')),
      getDocs(collection(db, 'users')),
    ]);

    const classes: TestHubClass[] = classesSnapshot.docs.map((classDoc) => {
      const data = classDoc.data() as Record<string, unknown>;
      const code = toStringSafe(data.code, classDoc.id).trim() || classDoc.id;
      const name = toStringSafe(data.name, `Class ${code}`).trim() || `Class ${code}`;
      return {
        id: classDoc.id,
        code,
        name,
      };
    });

    const tests: TestHubTest[] = testsSnapshot.docs.map((testDoc) => {
      const data = testDoc.data() as Record<string, unknown>;
      const assignment = (data.classAssignment ?? {}) as Record<string, unknown>;
      const selectedClassesRaw = assignment.selectedClasses;
      const selectedClasses = Array.isArray(selectedClassesRaw)
        ? selectedClassesRaw.map((item) => toStringSafe(item, '').trim()).filter(Boolean)
        : [];

      const distributionKey = toStringSafe(assignment.distribution, '').trim().toLowerCase();
      const distribution: 'all' | 'specific' =
        distributionKey === 'specific' || selectedClasses.length > 0 ? 'specific' : 'all';

      return {
        id: testDoc.id,
        name: toStringSafe(data.name, toStringSafe(data.testName, 'Untitled Test')),
        skill: normalizeSkill(data.skill),
        createdAt:
          toDateSafe(data.createdAt) ||
          toDateSafe(data.updatedAt) ||
          toDateSafe(data.uploadedAt) ||
          null,
        filesCount: extractFilesCount(data),
        distribution,
        selectedClasses,
      };
    });

    const studentRecords: Array<TestHubStudent | null> = usersSnapshot.docs
      .map((userDoc) => {
        const data = userDoc.data() as Record<string, unknown>;
        const role = toStringSafe(data.role, '').toLowerCase();
        if (role !== 'student') return null;

        const email = toStringSafe(data.email, '').trim();
        const name = toStringSafe(data.name, toStringSafe(data.displayName, email.split('@')[0] || 'Student')).trim();

        return {
          id: userDoc.id,
          email,
          name,
          displayName: toStringSafe(data.displayName, '').trim() || undefined,
          photoURL: toStringSafe(data.photoURL, '').trim() || undefined,
          classCode: toStringSafe(data.classCode, '').trim() || undefined,
          classId: toStringSafe(data.classId, '').trim() || undefined,
        };
      });

    const students: TestHubStudent[] = studentRecords.filter((item): item is TestHubStudent => item !== null);

    const payload: TestHubPayload = { tests, classes, students };
    const normalizedPayload = normalizePayload(payload);

    if (typeof window !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(normalizedPayload));
      localStorage.setItem(timeKey, Date.now().toString());
    }

    return normalizedPayload;
  })();

  requestMap.set(teacherEmail, promise);
  try {
    return await promise;
  } finally {
    requestMap.delete(teacherEmail);
  }
}

export function subscribeTestHubRealtime(teacherEmail: string, onChange: () => void): Unsubscribe {
  const db = getFirestore(firebaseApp);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let testsInitial = true;
  let classesInitial = true;
  let usersInitial = true;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      invalidateTestHubCache(teacherEmail);
      onChange();
    }, 200);
  };

  const unsubTests = onSnapshot(collection(db, 'tests'), () => {
    if (testsInitial) {
      testsInitial = false;
      return;
    }
    schedule();
  });

  const unsubClasses = onSnapshot(collection(db, 'classes'), () => {
    if (classesInitial) {
      classesInitial = false;
      return;
    }
    schedule();
  });

  const unsubUsers = onSnapshot(collection(db, 'users'), () => {
    if (usersInitial) {
      usersInitial = false;
      return;
    }
    schedule();
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubTests();
    unsubClasses();
    unsubUsers();
  };
}

/**
 * Delete all related documents (testResults, attempts, writing) for a given testId.
 * Runs as a best-effort operation — errors are logged but do not prevent the caller from completing.
 */
export async function cascadeDeleteRelatedResults(testId: string): Promise<{ deleted: number }> {
  const db = getFirestore(firebaseApp);
  const collections = ['testResults', 'attempts', 'writing'];
  let totalDeleted = 0;

  for (const col of collections) {
    try {
      const q = query(collection(db, col), where('testId', '==', testId));
      const snapshot = await getDocs(q);
      if (snapshot.empty) continue;

      // Firestore batches max 500 operations
      const docs = snapshot.docs;
      for (let i = 0; i < docs.length; i += 400) {
        const chunk = docs.slice(i, i + 400);
        const batch = writeBatch(db);
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        totalDeleted += chunk.length;
      }
    } catch (err) {
      console.warn(`[cascade-delete] Failed to clean ${col} for testId=${testId}:`, err);
    }
  }

  return { deleted: totalDeleted };
}

export async function deleteTestById(testId: string): Promise<void> {
  const db = getFirestore(firebaseApp);
  let directDeleteMessage = '';

  // Local-first delete: if client has permission, this succeeds immediately.
  try {
    await deleteDoc(doc(db, 'tests', testId));
    // Cascade: delete related results so they don't appear as orphan data
    await cascadeDeleteRelatedResults(testId);
    return;
  } catch (error) {
    directDeleteMessage = error instanceof Error ? error.message : 'Failed to delete test.';
    const lower = directDeleteMessage.toLowerCase();
    const permissionDenied =
      lower.includes('permission-denied')
      || lower.includes('missing or insufficient permissions')
      || lower.includes('insufficient permissions');

    if (!permissionDenied) {
      throw error;
    }
  }

  // Fallback to privileged backend delete when local permissions are restricted.
  try {
    const deletedByFunction = await deleteTestViaCloudFunction(testId);
    if (deletedByFunction) {
      // Still cascade-delete related results client-side
      await cascadeDeleteRelatedResults(testId);
      return;
    }

    throw new Error('Delete endpoint is unavailable.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete test.';
    const lower = message.toLowerCase();

    if (
      lower.includes('failed to fetch')
      || lower.includes('networkerror')
      || lower.includes('load failed')
      || lower.includes('delete endpoint is unavailable')
      || lower.includes('failed (404)')
    ) {
      throw new Error(
        `Cannot delete test from local client because Firestore permissions denied delete (${directDeleteMessage}). `
        + `Backend delete fallback is unreachable (${message}).`,
      );
    }

    throw new Error(
      `Cannot delete test from local client because Firestore permissions denied delete (${directDeleteMessage}). `
      + `Backend delete fallback failed (${message}).`,
    );
  }
}

export async function updateTestDistribution(params: {
  testId: string;
  distribution: 'all' | 'specific';
  selectedClasses: string[];
}): Promise<void> {
  const db = getFirestore(firebaseApp);
  const selectedClasses = Array.from(new Set(params.selectedClasses.map((value) => String(value || '').trim()).filter(Boolean)));
  const testRef = doc(db, 'tests', params.testId);
  const currentTest = await getDoc(testRef);

  await updateDoc(testRef, {
    classAssignment: buildClassAssignmentWithOpenedTimes(currentTest.data()?.classAssignment, {
      distribution: params.distribution,
      selectedClasses,
    }, new Date()),
  });
}
