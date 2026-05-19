import {
  collection,
  doc,
  documentId,
  getDocs,
  getFirestore,
  query,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';

export type ManualGradingSubmission = {
  id: string;
  testId: string;
  testName: string;
  studentEmail: string;
  studentName: string;
  classCode: string;
  submittedAt: Date | null;
  status: 'pending' | 'graded' | string;
  writingScore: number | null;
  task1Score: number | null;
  task2Score: number | null;
  answers: Record<string, unknown>;
  attemptId: string | null;
  task1Content: string;
  task2Content: string;
  feedbackFileUrl: string | null;
  feedbackFileName: string | null;
  source: 'writing' | 'testResult' | 'attempt';
};

const CACHE_TTL_MS = 90 * 1000;
const inFlightRequests = new Map<string, Promise<ManualGradingSubmission[]>>();

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const record = asRecord(value);
  if (typeof record.toDate === 'function') {
    const converted = (record.toDate as () => Date)();
    return Number.isNaN(converted.getTime()) ? null : converted;
  }

  if (typeof record.seconds === 'number') {
    const date = new Date(Number(record.seconds) * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toMillis(value: unknown): number {
  const parsed = toDate(value);
  return parsed?.getTime() ?? 0;
}

function pickText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value;
  }
  return '';
}

function normalizeStatus(value: unknown, writingScore: unknown): 'pending' | 'graded' {
  const status = asText(value).toLowerCase();
  if (status === 'graded') {
    return 'graded';
  }
  if (status === 'pending') {
    return 'pending';
  }

  if (status === 'completed') {
    const score = asNumber(writingScore);
    return score != null && score > 0 ? 'graded' : 'pending';
  }

  const score = asNumber(writingScore);
  return score != null && score > 0 ? 'graded' : 'pending';
}

function cacheKey(teacherEmail: string): string {
  return `manual_grading_${teacherEmail}`;
}

function cacheTimeKey(teacherEmail: string): string {
  return `${cacheKey(teacherEmail)}_time`;
}

function readCache(teacherEmail: string): ManualGradingSubmission[] | null {
  if (typeof window === 'undefined') return null;

  const raw = localStorage.getItem(cacheKey(teacherEmail));
  const rawTime = localStorage.getItem(cacheTimeKey(teacherEmail));
  if (!raw || !rawTime) return null;

  const age = Date.now() - Number(rawTime);
  if (!Number.isFinite(age) || age > CACHE_TTL_MS) return null;

  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed.map((item) => ({
      id: asText(item.id),
      testId: asText(item.testId),
      testName: asText(item.testName),
      studentEmail: asText(item.studentEmail),
      studentName: asText(item.studentName),
      classCode: asText(item.classCode),
      submittedAt: toDate(item.submittedAt),
      status: asText(item.status, 'pending'),
      writingScore: asNumber(item.writingScore),
      task1Score: asNumber(item.task1Score),
      task2Score: asNumber(item.task2Score),
      answers: asRecord(item.answers),
      attemptId: asText(item.attemptId) || null,
      feedbackFileUrl: asText(item.feedbackFileUrl) || null,
      feedbackFileName: asText(item.feedbackFileName) || null,
      task1Content: asText(item.task1Content),
      task2Content: asText(item.task2Content),
      source: (asText(item.source) as 'writing' | 'testResult' | 'attempt') || 'writing',
    }));
  } catch {
    return null;
  }
}

function writeCache(teacherEmail: string, payload: ManualGradingSubmission[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(cacheKey(teacherEmail), JSON.stringify(payload));
  localStorage.setItem(cacheTimeKey(teacherEmail), String(Date.now()));
}

export function invalidateManualGradingCache(teacherEmail: string): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(cacheKey(teacherEmail));
  localStorage.removeItem(cacheTimeKey(teacherEmail));
  inFlightRequests.delete(teacherEmail);
}

async function batchByDocumentId(
  db: Firestore,
  collectionName: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const cleaned = Array.from(new Set(ids.filter(Boolean)));
  const map = new Map<string, Record<string, unknown>>();
  if (cleaned.length === 0) return map;

  for (let i = 0; i < cleaned.length; i += 10) {
    const chunk = cleaned.slice(i, i + 10);
    const snapshot = await getDocs(query(collection(db, collectionName), where(documentId(), 'in', chunk)));
    snapshot.forEach((item) => {
      map.set(item.id, item.data() as Record<string, unknown>);
    });
  }

  return map;
}

async function batchByField(
  db: Firestore,
  collectionName: string,
  field: string,
  values: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const cleaned = Array.from(new Set(values.filter(Boolean)));
  const map = new Map<string, Record<string, unknown>>();
  if (cleaned.length === 0) return map;

  for (let i = 0; i < cleaned.length; i += 10) {
    const chunk = cleaned.slice(i, i + 10);
    const snapshot = await getDocs(query(collection(db, collectionName), where(field, 'in', chunk)));
    snapshot.forEach((item) => {
      const data = item.data() as Record<string, unknown>;
      const key = asText(data[field]);
      if (key) map.set(key, data);
    });
  }

  return map;
}

type AttemptLite = {
  id: string;
  studentEmail: string;
  testId: string;
  submittedAt: Date | null;
  answers: Record<string, unknown>;
};

function attemptFromDoc(id: string, data: Record<string, unknown>): AttemptLite | null {
  const studentEmail = asText(data.studentEmail).toLowerCase();
  const testId = asText(data.testId);
  if (!studentEmail || !testId) return null;

  return {
    id,
    studentEmail,
    testId,
    submittedAt: toDate(data.completedAt || data.submittedAt || data.updatedAt || data.createdAt),
    answers: asRecord(data.answers),
  };
}

export async function getManualGradingSubmissions(
  teacherEmail: string,
  forceRefresh = false,
): Promise<ManualGradingSubmission[]> {
  if (!forceRefresh) {
    const cached = readCache(teacherEmail);
    if (cached) return cached;
  }

  if (inFlightRequests.has(teacherEmail)) {
    return inFlightRequests.get(teacherEmail)!;
  }

  const request = (async () => {
    const db = getFirestore(firebaseApp);
    const [testsSnapshot, writingSnapshot, testResultsSnapshot, attemptsSnapshot, classesSnapshot] = await Promise.all([
      getDocs(collection(db, 'tests')),
      getDocs(collection(db, 'writing')),
      getDocs(query(collection(db, 'testResults'), where('testType', '==', 'writing'))),
      getDocs(query(collection(db, 'attempts'), where('status', '==', 'completed'))),
      getDocs(collection(db, 'classes')),
    ]);

    const writingLatestByKey = new Map<string, { id: string; data: Record<string, unknown>; submittedAtMs: number }>();
    const testResultLatestByKey = new Map<string, { id: string; data: Record<string, unknown>; submittedAtMs: number }>();

    for (const docSnap of writingSnapshot.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      const studentEmail = asText(data.studentEmail).toLowerCase();
      const testId = asText(data.testId);
      if (!studentEmail || !testId) continue;

      const key = `${studentEmail}_${testId}`;
      const submittedAtMs = toMillis(data.submittedAt || data.createdAt || data.updatedAt);
      const existing = writingLatestByKey.get(key);
      if (!existing || submittedAtMs > existing.submittedAtMs) {
        writingLatestByKey.set(key, { id: docSnap.id, data, submittedAtMs });
      }
    }

    for (const docSnap of testResultsSnapshot.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      const studentEmail = asText(data.studentEmail).toLowerCase();
      const testId = asText(data.testId);
      const status = asText(data.status).toLowerCase();
      if (!studentEmail || !testId) continue;
      if (status !== 'pending' && status !== 'graded' && status !== 'completed') continue;

      const key = `${studentEmail}_${testId}`;
      const submittedAtMs = toMillis(data.submittedAt || data.completedAt || data.createdAt || data.updatedAt || data.startedAt);
      const existing = testResultLatestByKey.get(key);
      if (!existing || submittedAtMs > existing.submittedAtMs) {
        testResultLatestByKey.set(key, { id: docSnap.id, data, submittedAtMs });
      }
    }

    const writingTestIds = new Set<string>();
    testsSnapshot.forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      if (asText(data.skill).toLowerCase() === 'writing') {
        writingTestIds.add(docSnap.id);
      }
    });

    const latestAttemptsByKey = new Map<string, AttemptLite>();
    for (const docSnap of attemptsSnapshot.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      const attempt = attemptFromDoc(docSnap.id, data);
      if (!attempt || !writingTestIds.has(attempt.testId)) continue;

      const key = `${attempt.studentEmail}_${attempt.testId}`;
      const existing = latestAttemptsByKey.get(key);
      const incomingMs = attempt.submittedAt?.getTime() ?? 0;
      const existingMs = existing?.submittedAt?.getTime() ?? 0;
      if (!existing || incomingMs > existingMs) {
        latestAttemptsByKey.set(key, attempt);
      }
    }

    const allKeys = new Set<string>([
      ...writingLatestByKey.keys(),
      ...testResultLatestByKey.keys(),
      ...latestAttemptsByKey.keys(),
    ]);

    const testIds = Array.from(allKeys).map((key) => key.split('_')[1] || '').filter(Boolean);
    const studentEmails = Array.from(allKeys).map((key) => key.split('_')[0] || '').filter(Boolean);

    const [testMap, userMap] = await Promise.all([
      batchByDocumentId(db, 'tests', testIds),
      batchByField(db, 'users', 'email', studentEmails),
    ]);

    const classMapById = new Map<string, Record<string, unknown>>();
    const classMapByCode = new Map<string, Record<string, unknown>>();
    classesSnapshot.forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      classMapById.set(docSnap.id, data);
      const code = asText(data.code);
      if (code) classMapByCode.set(code, data);
    });

    const submissions: ManualGradingSubmission[] = [];

    for (const key of allKeys) {
      const writing = writingLatestByKey.get(key);
      const testResult = testResultLatestByKey.get(key);
      const fallbackAttempt = latestAttemptsByKey.get(key);
      const [studentEmailFromKey, testIdFromKey] = key.split('_');

      const primary = (() => {
        if (writing && testResult) {
          if (testResult.submittedAtMs > writing.submittedAtMs) {
            return { source: 'testResult' as const, id: testResult.id, data: testResult.data };
          }
          return { source: 'writing' as const, id: writing.id, data: writing.data };
        }
        if (writing) return { source: 'writing' as const, id: writing.id, data: writing.data };
        if (testResult) return { source: 'testResult' as const, id: testResult.id, data: testResult.data };
        return null;
      })();

      const rowData = primary?.data || {};
      const studentEmail = asText(rowData.studentEmail || studentEmailFromKey).toLowerCase();
      const testId = asText(rowData.testId || testIdFromKey);
      const student = userMap.get(studentEmail);
      const test = testMap.get(testId);

        const classRefRaw = asText(
          rowData.classId
          || rowData.classCode
          || student?.classId
          || student?.classCode,
        );
        const classRecord = classMapById.get(classRefRaw) || classMapByCode.get(classRefRaw);
        const classLabel = asText(classRecord?.name || classRecord?.code || classRefRaw);

      const answers = primary
        ? asRecord(rowData.answers)
        : asRecord(fallbackAttempt?.answers);

      const task1Content = primary
        ? (pickText(answers, ['writingTask1', 'task1', 'task1Content', 'writing1'])
          || pickText(rowData, ['writingTask1', 'task1', 'task1Content', 'writing1']))
        : (pickText(answers, ['writingTask1', 'task1', 'task1Content', 'writing1'])
          || 'No writing content found.');

      const task2Content = primary
        ? (pickText(answers, ['writingTask2', 'task2', 'task2Content', 'writing2'])
          || pickText(rowData, ['writingTask2', 'task2', 'task2Content', 'writing2']))
        : pickText(answers, ['writingTask2', 'task2', 'task2Content', 'writing2']);

      const writingScore = asNumber(rowData.writingScore);
      const normalizedStatus = primary
        ? normalizeStatus(rowData.status, rowData.writingScore)
        : 'pending';

      submissions.push({
        id: primary
          ? `${primary.source}:${primary.id}`
          : `attempt:${fallbackAttempt?.id || key}`,
        testId,
        testName: asText(test?.name || rowData.testName || 'Writing Test'),
        studentEmail,
        studentName: asText(
          student?.displayName
            || student?.name
            || rowData.studentName
            || studentEmail.split('@')[0]
            || 'Student',
        ),
        classCode: classLabel,
        submittedAt: primary
          ? toDate(rowData.submittedAt || rowData.completedAt || rowData.createdAt || rowData.updatedAt || rowData.startedAt)
          : (fallbackAttempt?.submittedAt ?? null),
        status: normalizedStatus,
        writingScore,
        task1Score: asNumber(rowData.task1Score),
        task2Score: asNumber(rowData.task2Score),
        answers,
        attemptId: asText(rowData.attemptId) || fallbackAttempt?.id || null,
        task1Content,
        task2Content,
        feedbackFileUrl: asText(rowData.feedbackFileUrl || rowData.feedbackUrl) || null,
        feedbackFileName: asText(rowData.feedbackFileName) || null,
        source: primary?.source || 'attempt',
      });
    }

    submissions.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'pending' ? -1 : 1;
      }
      const aTime = a.submittedAt?.getTime() || 0;
      const bTime = b.submittedAt?.getTime() || 0;
      return bTime - aTime;
    });

    writeCache(teacherEmail, submissions);
    return submissions;
  })();

  inFlightRequests.set(teacherEmail, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(teacherEmail);
  }
}

export async function submitManualGrade(params: {
  submissionId: string;
  attemptId: string | null;
  teacherEmail: string;
  task1Score: number;
  task2Score: number;
  writingScore: number;
  comments: string;
  feedbackFileName?: string | null;
  feedbackFileUrl?: string | null;
}): Promise<void> {
  const db = getFirestore(firebaseApp);

  const separatorIndex = params.submissionId.indexOf(':');
  const hasPrefix = separatorIndex > 0;
  const source = hasPrefix ? params.submissionId.slice(0, separatorIndex) : 'writing';
  const rawId = hasPrefix ? params.submissionId.slice(separatorIndex + 1) : params.submissionId;

  if (source === 'writing') {
    await updateDoc(doc(db, 'writing', rawId), {
      task1Score: params.task1Score,
      task2Score: params.task2Score,
      writingScore: params.writingScore,
      comments: params.comments,
      status: 'graded',
      gradedAt: new Date(),
      gradedBy: params.teacherEmail,
      ...(params.feedbackFileName ? { feedbackFileName: params.feedbackFileName } : {}),
      ...(params.feedbackFileUrl ? { feedbackFileUrl: params.feedbackFileUrl } : {}),
    });
  } else if (source === 'testResult') {
    await updateDoc(doc(db, 'testResults', rawId), {
      task1Score: params.task1Score,
      task2Score: params.task2Score,
      writingScore: params.writingScore,
      comments: params.comments,
      status: 'graded',
      gradedAt: new Date(),
      gradedBy: params.teacherEmail,
      ...(params.feedbackFileName ? { feedbackFileName: params.feedbackFileName } : {}),
      ...(params.feedbackFileUrl ? { feedbackFileUrl: params.feedbackFileUrl } : {}),
    });
  }

  if (params.attemptId) {
    await updateDoc(doc(db, 'attempts', params.attemptId), {
      'scores.writing': params.writingScore,
      writingScore: params.writingScore,
      gradingStatus: 'graded',
      gradedAt: new Date(),
    });
  }

  invalidateManualGradingCache(params.teacherEmail);
}
