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

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssignmentStatus = 'NOT_DONE' | 'COMPLETED';

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
  const [userSnap, testsSnap, resultsSnap, writingSnap] = await Promise.all([
    getDoc(doc(db, 'users', studentEmail)).catch(() => null),
    getDocs(collection(db, 'tests')).catch(() => null),
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

  let userClassDocId = userClassId;
  if (userClassId) {
    // If userClassId is a code, we might need to find the doc ID
    // But usually in this system, classId/classCode are used interchangeably
    // Let's check classes for mapping if needed
    try {
      const classQ = await getDocs(query(collection(db, 'classes'), where('code', '==', userClassId)));
      if (!classQ.empty) {
        userClassDocId = classQ.docs[0].id;
      }
    } catch { /* ignore */ }
  }

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

  // 4. Filter and build assignments list
  const assignments: Assignment[] = [];

  testsSnap?.docs.forEach(d => {
    const test = d.data();
    const testId = d.id;
    
    // Check access
    const dist = test.classAssignment?.distribution;
    let hasAccess = false;
    if (!dist || dist === 'all') {
      hasAccess = true;
    } else if (dist === 'specific') {
      const selected: string[] = test.classAssignment.selectedClasses ?? [];
      if (userClassId && (selected.includes(userClassId) || (userClassDocId && selected.includes(userClassDocId)))) {
        hasAccess = true;
      }
    }

    if (!hasAccess) return;

    // Determine status
    let status: AssignmentStatus = 'NOT_DONE';
    let band: number | undefined;
    let lastActivityAt: Date | undefined = undefined;

    if (completions.has(testId)) {
      status = 'COMPLETED';
      band = completions.get(testId)!.band;
      lastActivityAt = completions.get(testId)!.date;
    }

    assignments.push({
      id: testId,
      name: test.name || 'Untitled Test',
      skill: inferSkill(test),
      createdAt: extractDate(test.createdAt),
      status,
      band,
      lastActivityAt,
    });
  });

  // Sort: Not done first (newest first), then completed.
  return assignments.sort((a, b) => {
    const statusOrder: Record<AssignmentStatus, number> = {
      'NOT_DONE': 0,
      'COMPLETED': 1,
    };

    if (statusOrder[a.status] !== statusOrder[b.status]) {
      return statusOrder[a.status] - statusOrder[b.status];
    }

    const aTime = a.lastActivityAt?.getTime() ?? 0;
    const bTime = b.lastActivityAt?.getTime() ?? 0;
    return bTime - aTime;
  });
}
