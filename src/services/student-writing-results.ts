import { getFirestore, collection, query, where, getDocs, doc, getDoc, Timestamp } from 'firebase/firestore';
import { firebaseApp } from './firebase';

export interface WritingResult {
  id: string;
  testId?: string;
  testName: string;
  writingScore: number | 'Pending';
  task1Score?: number;
  task2Score?: number;
  feedback?: string;
  feedbackFileUrl?: string;
  promptFileUrl?: string;      // teacher-uploaded original prompt file
  submittedAt: Date;
  gradedAt?: Date;
  completedAt: Date;
  gradedBy?: string;
  answers?: {
    writingTask1?: string;
    writingTask2?: string;
  };
  task1Submission?: string;
  task2Submission?: string;
  status: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function pickText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value;
  }
  return '';
}

function asDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (value instanceof Timestamp) return value.toDate();
  if (value && typeof value === 'object' && 'toDate' in (value as Record<string, unknown>) && typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      return ((value as { toDate: () => Date }).toDate());
    } catch {
      return fallback;
    }
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return fallback;
}

function normalizeStatus(data: Record<string, unknown>): 'pending' | 'graded' {
  const status = asText(data.status).toLowerCase();
  if (status === 'graded') return 'graded';

  const scoreRaw = data.writingScore;
  if (typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)) return 'graded';

  return 'pending';
}

function dedupeKey(result: WritingResult): string {
  const testId = (result.testId || '').trim().toLowerCase();
  const task1 = (result.task1Submission || '').trim().toLowerCase();
  const task2 = (result.task2Submission || '').trim().toLowerCase();

  if (task1 || task2) return `${testId}|${task1}|${task2}`;
  return `${testId}|${result.submittedAt.getTime()}`;
}

function mergeWritingResults(results: WritingResult[]): WritingResult[] {
  const merged = new Map<string, WritingResult>();

  for (const item of results) {
    const key = dedupeKey(item);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, item);
      continue;
    }

    const existingPending = existing.writingScore === 'Pending';
    const currentPending = item.writingScore === 'Pending';

    // Prefer graded over pending for the same submission.
    if (existingPending && !currentPending) {
      merged.set(key, item);
      continue;
    }
    if (!existingPending && currentPending) {
      continue;
    }

    // If same status, keep the newer record.
    if (item.completedAt.getTime() > existing.completedAt.getTime()) {
      merged.set(key, item);
    }
  }

  return Array.from(merged.values());
}

function mapDocToWritingResult(id: string, data: any): WritingResult {
  const record = asRecord(data);
  const answers = asRecord(record.answers);
  const status = normalizeStatus(record);
  const submittedAt = asDate(record.submittedAt ?? record.completedAt ?? record.startedAt, new Date(0));
  const gradedAt = status === 'graded' ? asDate(record.gradedAt, submittedAt) : undefined;
  const completedAt = gradedAt ?? asDate(record.completedAt ?? record.submittedAt ?? record.startedAt, submittedAt);
  
  const task1Submission = 
    pickText(answers, ['writingTask1', 'task1', 'task1Content', 'writing1']) || 
    pickText(record, ['writingTask1', 'task1', 'task1Content', 'writing1']);

  const task2Submission = 
    pickText(answers, ['writingTask2', 'task2', 'task2Content', 'writing2']) || 
    pickText(record, ['writingTask2', 'task2', 'task2Content', 'writing2']);

  const writingScore = status === 'graded' && typeof record.writingScore === 'number' && Number.isFinite(record.writingScore)
    ? record.writingScore
    : 'Pending';

  return {
    id,
    testId: asText(record.testId) || id,
    testName: asText(record.testName) || 'Writing Test',
    writingScore,
    task1Score: typeof record.task1Score === 'number' ? record.task1Score : undefined,
    task2Score: typeof record.task2Score === 'number' ? record.task2Score : undefined,
    feedback: pickText(record, ['comments', 'feedback', 'writingFeedback']),
    feedbackFileUrl: asText(record.feedbackFileUrl) || undefined,
    promptFileUrl: asText(record.promptFileUrl || record.testPromptUrl || record.promptUrl) || undefined,
    submittedAt,
    gradedAt,
    completedAt,
    gradedBy: asText(record.gradedBy) || undefined,
    answers,
    task1Submission: task1Submission || undefined,
    task2Submission: task2Submission || undefined,
    status,
  };
}

export async function fetchStudentWritingResults(studentEmail: string): Promise<WritingResult[]> {
  const db = getFirestore(firebaseApp);
  
  try {
    const writingQuery = query(
      collection(db, 'writing'),
      where('studentEmail', '==', studentEmail)
    );

    const takeTestWritingQuery = query(
      collection(db, 'testResults'),
      where('studentEmail', '==', studentEmail),
      where('testType', '==', 'writing')
    );
    
    const [snapshot, takeTestSnapshot] = await Promise.all([
      getDocs(writingQuery),
      getDocs(takeTestWritingQuery),
    ]);
    
    const results: WritingResult[] = [];
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.status === 'graded' || data.status === 'pending') {
        results.push(mapDocToWritingResult(doc.id, data));
      }
    });

    takeTestSnapshot.forEach((doc) => {
      const data = doc.data();
      const status = asText(data.status).toLowerCase();
      // Include submitted writing attempts in Teacher Feedback, even when pending.
      if (status === 'pending' || status === 'graded' || status === 'completed') {
        results.push(mapDocToWritingResult(doc.id, data));
      }
    });

    const mergedResults = mergeWritingResults(results);
    
    // Sort by completedAt descending
    mergedResults.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
    
    return mergedResults;
  } catch (error) {
    console.error('Error fetching writing results:', error);
    return [];
  }
}

// ── Fetch single result by Firestore document ID ───────────────────────────────

export async function fetchWritingResultById(
  studentEmail: string,
  id: string,
): Promise<WritingResult | null> {
  const db = getFirestore(firebaseApp);
  try {
    const snap = await getDoc(doc(db, 'writing', id));
    if (!snap.exists()) return null;
    const data = snap.data();
    // Security: ensure this result belongs to the authenticated student
    if (data.studentEmail !== studentEmail) return null;
    return mapDocToWritingResult(snap.id, data);
  } catch (error) {
    console.error('Error fetching writing result by id:', error);
    return null;
  }
}

