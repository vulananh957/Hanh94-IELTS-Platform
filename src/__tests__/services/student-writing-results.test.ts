/**
 * Tests for student-writing-results.ts
 *
 * Covers:
 * - Returns graded results with score
 * - Returns pending results with 'Pending' score
 * - Skips non graded/pending documents
 * - Task submission extraction (nested answers obj + top-level fields)
 * - Feedback field extraction (comments / feedback / writingFeedback)
 * - completedAt falls back to submittedAt when gradedAt is absent
 * - Returns [] on Firestore error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeDoc,
  makeDocSnap,
  makeQuerySnap,
  makeTimestamp,
} from '../fixtures/firebase-mock';
import {
  fixtureWritingGraded,
  fixtureWritingPending,
  STUDENT_EMAIL,
  TODAY,
  YESTERDAY,
  LAST_WEEK,
} from '../fixtures/student-fixtures';

// ── Firebase module mock ───────────────────────────────────────────────────────

const mockGetDocs = vi.fn();
const mockGetDoc = vi.fn();

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  doc: vi.fn(),
  getDocs: (...args: any[]) => mockGetDocs(...args),
  getDoc: (...args: any[]) => mockGetDoc(...args),
  Timestamp: class {
    constructor(public seconds: number, public nanoseconds: number) {}
    toDate() { return new Date(this.seconds * 1000); }
  },
}));

vi.mock('@/services/firebase', () => ({ firebaseApp: {} }));

import {
  fetchStudentWritingResults,
  fetchWritingResultById,
} from '@/services/student-writing-results';

// ─────────────────────────────────────────────────────────────────────────────

describe('fetchStudentWritingResults', () => {
  beforeEach(() => {
    mockGetDocs.mockReset();
  });

  it('returns graded writing result with numeric score', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('wr-graded', fixtureWritingGraded)]),
    );

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'wr-graded',
      testName: 'IELTS Writing Task 1 & 2',
      writingScore: 6.5,
      task1Score: 6.0,
      task2Score: 7.0,
      status: 'graded',
    });
  });

  it('returns pending writing result with "Pending" as writingScore', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('wr-pending', fixtureWritingPending)]),
    );

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);

    expect(results[0].writingScore).toBe('Pending');
    expect(results[0].status).toBe('pending');
  });

  it('skips documents with status other than graded/pending', async () => {
    const draftDoc = makeDoc('wr-draft', {
      ...fixtureWritingGraded,
      status: 'draft',
    });

    mockGetDocs.mockResolvedValue(makeQuerySnap([draftDoc]));

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);
    expect(results).toHaveLength(0);
  });

  it('extracts task submissions from nested answers object', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('wr-1', fixtureWritingGraded)]),
    );

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);

    expect(results[0].task1Submission).toBe('The chart shows...');
    expect(results[0].task2Submission).toBe('In my opinion...');
  });

  it('extracts feedback from comments field', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('wr-1', fixtureWritingGraded)]),
    );

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);

    expect(results[0].feedback).toBe('Good coherence. Improve vocabulary range.');
  });

  it('sets completedAt to gradedAt when present', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('wr-1', fixtureWritingGraded)]),
    );

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);
    // gradedAt = YESTERDAY
    expect(results[0].completedAt.toISOString()).toBe(YESTERDAY.toISOString());
  });

  it('falls back completedAt to submittedAt when gradedAt is absent', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([makeDoc('wr-pending', fixtureWritingPending)]),
    );

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);
    // submittedAt = TODAY; gradedAt absent
    expect(results[0].completedAt.toISOString()).toBe(TODAY.toISOString());
  });

  it('sorts results by completedAt descending', async () => {
    mockGetDocs.mockResolvedValue(
      makeQuerySnap([
        makeDoc('wr-old', fixtureWritingGraded),   // completedAt = YESTERDAY
        makeDoc('wr-new', fixtureWritingPending),   // completedAt = TODAY
      ]),
    );

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);
    expect(results[0].completedAt.getTime()).toBeGreaterThan(
      results[1].completedAt.getTime(),
    );
  });

  it('returns [] and does not throw on Firestore error', async () => {
    mockGetDocs.mockRejectedValue(new Error('quota exceeded'));

    const results = await fetchStudentWritingResults(STUDENT_EMAIL);
    expect(results).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('fetchWritingResultById', () => {
  beforeEach(() => {
    mockGetDoc.mockReset();
  });

  it('returns the result when document exists and belongs to the student', async () => {
    mockGetDoc.mockResolvedValue(makeDocSnap('wr-graded', fixtureWritingGraded));

    const result = await fetchWritingResultById(STUDENT_EMAIL, 'wr-graded');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('wr-graded');
    expect(result?.writingScore).toBe(6.5);
  });

  it('returns null when document does not exist', async () => {
    mockGetDoc.mockResolvedValue(makeDocSnap('missing', null));

    const result = await fetchWritingResultById(STUDENT_EMAIL, 'missing');
    expect(result).toBeNull();
  });

  it('returns null when document belongs to a different student', async () => {
    mockGetDoc.mockResolvedValue(
      makeDocSnap('wr-other', {
        ...fixtureWritingGraded,
        studentEmail: 'other@student.com',
      }),
    );

    const result = await fetchWritingResultById(STUDENT_EMAIL, 'wr-other');
    expect(result).toBeNull();
  });

  it('returns null on Firestore error', async () => {
    mockGetDoc.mockRejectedValue(new Error('permission denied'));

    const result = await fetchWritingResultById(STUDENT_EMAIL, 'wr-1');
    expect(result).toBeNull();
  });
});
