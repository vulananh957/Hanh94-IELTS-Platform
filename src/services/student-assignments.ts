'use client';

import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  Timestamp,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';
import { getClassAssignmentOpenedAt } from '@/lib/class-assignment-timing';
import { fetchAssignedTestSummaries, type TestAccessLock } from './test-access';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssignmentStatus = 'NOT_DONE' | 'COMPLETED' | 'LOCKED';

export interface Assignment {
  id: string;
  name: string;
  skill: 'listening' | 'reading' | 'writing' | string;
  createdAt: Date;
  status: AssignmentStatus;
  score?: number;
  band?: number;
  lastActivityAt?: Date;
  deadline?: Date; // Optional: if added later
  accessLock?: TestAccessLock;
}

// ─── Helpers (mirrors student-dashboard.ts) ───────────────────────────────────

function inferSkill(test: any): string {
  const skill = (test.skill ?? '').toLowerCase();
  if (skill) return skill;

  const name = (test.name ?? '').toLowerCase();
  if (name.includes('reading') || name.startsWith('r')) return 'reading';
  if (name.includes('listening') || name.startsWith('l')) return 'listening';
  if (name.includes('writing') || name.startsWith('w')) return 'writing';
  
  return 'unknown';
}

function extractDate(val: any): Date {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (val instanceof Timestamp) return val.toDate();
  if (typeof val === 'object' && val.seconds) return new Date(val.seconds * 1000);
  return new Date(val);
}

// ─── Main Service ─────────────────────────────────────────────────────────────

export async function fetchStudentAssignments(
  studentEmail: string,
  _studentUid: string
): Promise<Assignment[]> {
  const db = getFirestore(firebaseApp);

  // 1. Parallel fetch all necessary data
  const [userSnap, assignedTests, resultsSnap, writingSnap] = await Promise.all([
    getDoc(doc(db, 'users', studentEmail)).catch(() => null),
    fetchAssignedTestSummaries(),
    getDocs(
      query(
        collection(db, 'testResults'),
        where('studentEmail', '==', studentEmail)
      )
    ).catch(() => null),
    getDocs(
      query(
        collection(db, 'writing'),
        where('studentEmail', '==', studentEmail)
      )
    ).catch(() => null),
  ]);

  // 2. Determine student's class
  const userData = userSnap?.exists() ? userSnap.data() : {};
  const userClassId: string | null = userData.classId || userData.classCode || null;

  // Build complete classCodeToId map (same logic as student-dashboard.ts)
  const classCodeToId = new Map<string, string>();
  const classIdToCode = new Map<string, string>();
  try {
    const classesSnap = await getDocs(collection(db, 'classes'));
    classesSnap.docs.forEach((d) => {
      const data = d.data();
      if (data.code) {
        classCodeToId.set(data.code, d.id);
        classIdToCode.set(d.id, data.code);
      }
    });
  } catch { /* ignore */ }

  let userClassDocId = userClassId;
  if (userClassId) {
    const mappedDocId = classCodeToId.get(userClassId);
    if (mappedDocId) {
      userClassDocId = mappedDocId;
    }
  }

  const userClassKeys = Array.from(new Set([
    userClassId,
    userClassDocId,
    userClassDocId ? classIdToCode.get(userClassDocId) : null,
  ].filter((value): value is string => Boolean(value))));

  // 3. Map completed tests
  // Group results by testId
  const completions = new Map<string, { band: number; date: Date }>();
  resultsSnap?.docs.forEach(d => {
    const data = d.data();
    const testId = data.testId;
    const status = String(data.status || '').toLowerCase();
    const skill = String(data.testType || data.skill || '').toLowerCase();
    const isWriting = skill === 'writing';

    if (isWriting) {
      if (status === 'pending' || status === 'graded' || status === 'completed') {
        const band = Number(data.writingScore ?? data.ieltsBand ?? null);
        const date = extractDate(data.submittedAt || data.completedAt || data.gradedAt);
        if (!completions.has(testId) || date > completions.get(testId)!.date) {
          completions.set(testId, { band, date });
        }
      }
      return;
    }

    if (status === 'completed') {
      // Only trust ieltsBand from testResults (band score, not raw correct-answer count).
      // For old submissions: if ieltsBand is missing but correctAnswers exists, we skip —
      // the drawer backfill will populate ieltsBand when student opens it.
      const band = Number(data.ieltsBand ?? null);
      const date = extractDate(data.completedAt || data.submittedAt);
      if (!completions.has(testId) || date > completions.get(testId)!.date) {
        completions.set(testId, { band, date });
      }
    }
  });

  // Group writing by testId
  writingSnap?.docs.forEach(d => {
    const data = d.data();
    const testId = data.testId || d.id; // Some legacy might use doc ID
    const status = data.status; // 'graded', 'pending', etc.
    const score = Number(data.writingScore || 0);
    const date = extractDate(data.submittedAt);
    
    if (status === 'graded' || status === 'pending' || status === 'completed') {
      if (!completions.has(testId) || date > completions.get(testId)!.date) {
        completions.set(testId, { band: score, date });
      }
    }
  });

  // 4. Build a map of each test's opening time for this Student's class.
  // A test can be opened to different classes at different times.
  const testAssignmentTimes = new Map<string, Date>();
  assignedTests.forEach((test) => {
    const testId = test.id;
    const assignmentTime = extractDate(getClassAssignmentOpenedAt(
      test.classAssignment,
      userClassKeys,
      test.createdAt,
    ));
    testAssignmentTimes.set(testId, assignmentTime);
  });

  // 5. Filter and build assignments list
  const assignments: Assignment[] = [];

  assignedTests.forEach((test) => {
    const testId = test.id;

    // Determine status
    let status: AssignmentStatus = 'NOT_DONE';
    let band: number | undefined;
    let lastActivityAt: Date | undefined = undefined;

    if (completions.has(testId)) {
      status = 'COMPLETED';
      band = completions.get(testId)!.band;
      lastActivityAt = completions.get(testId)!.date;
    }
    if (test.accessLock?.status === 'locked') status = 'LOCKED';

    assignments.push({
      id: testId,
      name: test.name || 'Untitled Test',
      skill: inferSkill(test),
      createdAt: extractDate(test.createdAt),
      status,
      band,
      lastActivityAt,
      accessLock: test.accessLock || undefined,
    });
  });

  // Sort: By class assignment date (classAssignment.updatedAt) - newest first
  // This ensures assignments most recently assigned to the class appear first
  return assignments.sort((a, b) => {
    const aAssignmentTime = testAssignmentTimes.get(a.id)?.getTime() ?? 0;
    const bAssignmentTime = testAssignmentTimes.get(b.id)?.getTime() ?? 0;
    
    // If both have assignment times, sort by that (newest first)
    if (aAssignmentTime && bAssignmentTime) {
      return bAssignmentTime - aAssignmentTime;
    }
    
    // Fall back to createdAt if assignment time is not available
    const aTime = a.createdAt?.getTime() ?? 0;
    const bTime = b.createdAt?.getTime() ?? 0;
    return bTime - aTime; // Newest first (descending)
  });
}
