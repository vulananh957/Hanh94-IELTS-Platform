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

function mapDocToWritingResult(id: string, data: any): WritingResult {
  const answers = asRecord(data.answers);
  
  const task1Submission = 
    pickText(answers, ['writingTask1', 'task1', 'task1Content', 'writing1']) || 
    pickText(data, ['writingTask1', 'task1', 'task1Content', 'writing1']);

  const task2Submission = 
    pickText(answers, ['writingTask2', 'task2', 'task2Content', 'writing2']) || 
    pickText(data, ['writingTask2', 'task2', 'task2Content', 'writing2']);

  return {
    id,
    testId: data.testId || id,
    testName: data.testName || 'Writing Test',
    writingScore: data.status === 'graded' ? data.writingScore : 'Pending',
    task1Score: data.task1Score,
    task2Score: data.task2Score,
    feedback: pickText(data, ['comments', 'feedback', 'writingFeedback']),
    feedbackFileUrl: data.feedbackFileUrl,
    promptFileUrl: data.promptFileUrl || data.testPromptUrl || data.promptUrl,
    submittedAt: data.submittedAt?.toDate ? data.submittedAt.toDate() : new Date(data.submittedAt),
    gradedAt: data.gradedAt?.toDate ? data.gradedAt.toDate() : (data.gradedAt ? new Date(data.gradedAt) : undefined),
    completedAt: data.gradedAt?.toDate
      ? data.gradedAt.toDate()
      : (data.gradedAt
          ? new Date(data.gradedAt)
          : (data.submittedAt?.toDate ? data.submittedAt.toDate() : new Date(data.submittedAt))),
    gradedBy: data.gradedBy,
    answers: data.answers,
    task1Submission: task1Submission || undefined,
    task2Submission: task2Submission || undefined,
    status: data.status,
  };
}

export async function fetchStudentWritingResults(studentEmail: string): Promise<WritingResult[]> {
  const db = getFirestore(firebaseApp);
  
  try {
    const writingQuery = query(
      collection(db, 'writing'),
      where('studentEmail', '==', studentEmail)
    );
    
    const snapshot = await getDocs(writingQuery);
    
    const results: WritingResult[] = [];
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.status === 'graded' || data.status === 'pending') {
        results.push(mapDocToWritingResult(doc.id, data));
      }
    });
    
    // Sort by completedAt descending
    results.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
    
    return results;
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

