/**
 * Tests for student-objective-tests.ts
 *
 * Covers:
 * - Skill inference from testType field
 * - Skill inference from testName when testType is absent
 * - Deduplication (latest attempt per testId wins)
 * - Band score extraction (ieltsBand vs score fallback)
 * - Writing results are excluded (skill === null → skipped)
 * - Returns [] on Firestore error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeDoc,
  makeQuerySnap,
  makeTimestamp,
} from '../fixtures/firebase-mock';
import {
  fixtureListeningResult,
  fixtureReadingResult,
  STUDENT_EMAIL,
  TODAY,
  YESTERDAY,
} from '../fixtures/student-fixtures';

// ── Firebase module mock ───────────────────────────────────────────────────────

const mockGetDocs = vi.fn();

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: (...args: any[]) => mockGetDocs(...args),
}));

vi.mock('@/services/firebase', () => ({ firebaseApp: {} }));

// ── Import after mocks ─────────────────────────────────────────────────────────

import { fetchStudentObjectiveTests } from '@/services/student-objective-tests';

// ─────────────────────────────────────────────────────────────────────────────

describe('fetchStudentObjectiveTests', () => {
  beforeEach(() => {
    mockGetDocs.mockReset();
  });

  it('returns listening result with correct skill and band', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('doc-1', fixtureListeningResult)]),
    );

    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      skill: 'listening',
      band: 6.5,
      testId: 'test-listening-001',
      testName: 'IELTS Listening Practice 1',
      status: 'completed',
    });
  });

  it('returns reading result with correct skill', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('doc-2', fixtureReadingResult)]),
    );

    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);

    expect(results[0].skill).toBe('reading');
    expect(results[0].band).toBe(7.0);
  });

  it('infers skill from testName when testType is missing', async () => {
    const doc = makeDoc('doc-3', {
      ...fixtureListeningResult,
      testType: '',
      testName: 'listening section 3',
    });

    mockGetDocs.mockResolvedValue(makeQuerySnap([doc]));

    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);
    expect(results[0].skill).toBe('listening');
  });

  it('skips documents where skill cannot be inferred (e.g. writing data in wrong collection)', async () => {
    const writingDoc = makeDoc('doc-w', {
      studentEmail: STUDENT_EMAIL,
      testType: 'writing',
      status: 'completed',
      ieltsBand: 6,
      completedAt: makeTimestamp(TODAY),
    });

    mockGetDocs.mockResolvedValue(makeQuerySnap([writingDoc]));

    // Writing should be filtered out (inferSkill returns null)
    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);
    expect(results).toHaveLength(0);
  });

  it('deduplicates by testId keeping the latest attempt', async () => {
    const attempt1 = makeDoc('doc-old', {
      ...fixtureListeningResult,
      ieltsBand: 5.5,
      completedAt: makeTimestamp(YESTERDAY),
    });
    const attempt2 = makeDoc('doc-new', {
      ...fixtureListeningResult,
      ieltsBand: 6.5,
      completedAt: makeTimestamp(TODAY),
    });

    mockGetDocs.mockResolvedValue(makeQuerySnap([attempt1, attempt2]));

    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);

    expect(results).toHaveLength(1);
    expect(results[0].band).toBe(6.5); // latest wins
  });

  it('sorts results by completedAt descending', async () => {
    const olderDoc = makeDoc('doc-old', {
      ...fixtureReadingResult,
      testId: 'test-reading-older',
      completedAt: makeTimestamp(YESTERDAY),
    });
    const newerDoc = makeDoc('doc-new', {
      ...fixtureListeningResult,
      testId: 'test-listening-newer',
      completedAt: makeTimestamp(TODAY),
    });

    mockGetDocs.mockResolvedValue(makeQuerySnap([olderDoc, newerDoc]));

    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);

    expect(results[0].completedAt.getTime()).toBeGreaterThan(
      results[1].completedAt.getTime(),
    );
  });

  it('uses score field as fallback when ieltsBand is absent', async () => {
    const doc = makeDoc('doc-fallback', {
      ...fixtureListeningResult,
      ieltsBand: undefined,
      score: 7.5,
    });

    mockGetDocs.mockResolvedValue(makeQuerySnap([doc]));

    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);
    expect(results[0].band).toBe(7.5);
  });

  it('returns [] and does not throw on Firestore error', async () => {
    mockGetDocs.mockRejectedValue(new Error('network error'));

    const results = await fetchStudentObjectiveTests(STUDENT_EMAIL);
    expect(results).toEqual([]);
  });
});
