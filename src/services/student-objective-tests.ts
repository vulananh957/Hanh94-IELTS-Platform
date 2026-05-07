'use client';

import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';

export interface ObjectiveTestResult {
  id: string;
  testId: string;
  testName: string;
  skill: 'listening' | 'reading';
  band: number | null;
  status: string;
  completedAt: Date;
  correctAnswers?: number;
  totalQuestions?: number;
}

function normalizeKeyPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildResultGroupKey(data: Record<string, unknown>, skill: 'listening' | 'reading'): string {
  const explicitTestId = normalizeKeyPart(data.testId);
  if (explicitTestId) return `test:${explicitTestId}`;

  const testName = normalizeKeyPart(data.testName ?? data.name);
  if (testName) return `name:${skill}:${testName}`;

  const legacyId = normalizeKeyPart(data.examId ?? data.assignmentId);
  if (legacyId) return `legacy:${legacyId}`;

  return `fallback:${skill}:unknown`;
}

function inferSkill(result: any): 'listening' | 'reading' | null {
  let testType = (result.testType ?? '').toLowerCase();
  if (!testType || testType === 'unknown') {
    const name = (result.testName ?? result.name ?? '').toLowerCase();
    if (name.includes('reading') || name.startsWith('r')) testType = 'reading';
    else if (name.includes('listening') || name.startsWith('l')) testType = 'listening';
  }
  if (testType === 'listening') return 'listening';
  if (testType === 'reading') return 'reading';
  return null;
}

export async function fetchStudentObjectiveTests(
  studentEmail: string,
): Promise<ObjectiveTestResult[]> {
  const db = getFirestore(firebaseApp);

  try {
    const snap = await getDocs(
      query(
        collection(db, 'testResults'),
        where('studentEmail', '==', studentEmail),
        where('status', '==', 'completed'),
      ),
    );

    const results: ObjectiveTestResult[] = [];
    const groupKeyByDocId = new Map<string, string>();

    snap.docs.forEach((d) => {
      const data = d.data();
      const skill = inferSkill(data);
      if (!skill) return; // skip writing or unknown

      const completedAt: Date =
        data.completedAt?.toDate?.() ?? new Date(data.completedAt);
      const band = Number(data.ieltsBand ?? data.score ?? 0) || null;
      const groupKey = buildResultGroupKey(data as Record<string, unknown>, skill);

      results.push({
        id: d.id,
        testId: String(data.testId ?? groupKey),
        testName: data.testName ?? data.name ?? 'Test',
        skill,
        band: band && band > 0 ? band : null,
        status: 'completed',
        completedAt,
        correctAnswers: data.correctAnswers ?? data.correct ?? undefined,
        totalQuestions: data.totalQuestions ?? data.total ?? undefined,
      });
      groupKeyByDocId.set(d.id, groupKey);
    });

    // Deduplicate: keep latest attempt per testId
    const latestMap = new Map<string, ObjectiveTestResult>();
    results.forEach((r) => {
      const groupKey = groupKeyByDocId.get(r.id) ?? normalizeKeyPart(r.testId) ?? r.id;
      const existing = latestMap.get(groupKey);
      if (!existing || r.completedAt > existing.completedAt) {
        latestMap.set(groupKey, r);
      }
    });

    return Array.from(latestMap.values()).sort(
      (a, b) => b.completedAt.getTime() - a.completedAt.getTime(),
    );
  } catch (err) {
    console.error('[fetchStudentObjectiveTests]', err);
    return [];
  }
}
