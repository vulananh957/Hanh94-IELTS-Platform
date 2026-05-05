/**
 * Tests for student-assignments.ts
 *
 * Covers:
 * - 'all' distribution tests are visible to any student
 * - 'specific' distribution with matching class is visible
 * - 'specific' distribution with non-matching class is hidden
 * - Completed test-result marks assignment COMPLETED with band score
 * - Graded writing marks assignment COMPLETED
 * - Sorting: NOT_DONE before COMPLETED, then by lastActivityAt desc
 * - Returns [] when tests collection is empty
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeDoc,
  makeDocSnap,
  makeQuerySnap,
  makeTimestamp,
} from '../fixtures/firebase-mock';
import {
  fixtureUser,
  fixtureClass,
  fixtureTestListening,
  fixtureTestReading,
  fixtureTestWriting,
  fixtureTestPrivate,
  fixtureListeningResult,
  fixtureWritingGraded,
  STUDENT_EMAIL,
  STUDENT_UID,
  CLASS_ID,
  TODAY,
  YESTERDAY,
  LAST_WEEK,
} from '../fixtures/student-fixtures';

// ── Firebase module mock ───────────────────────────────────────────────────────

const mockGetDocs = vi.fn();
const mockGetDoc = vi.fn();

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn((db: any, col: string) => ({ _col: col })),
  query: vi.fn((...args: any[]) => args),
  where: vi.fn(),
  doc: vi.fn((db: any, col: string, id: string) => ({ _col: col, _id: id })),
  getDocs: (...args: any[]) => mockGetDocs(...args),
  getDoc: (...args: any[]) => mockGetDoc(...args),
  Timestamp: class {
    constructor(public seconds: number, public nanoseconds: number) {}
    toDate() { return new Date(this.seconds * 1000); }
  },
}));

vi.mock('@/services/firebase', () => ({ firebaseApp: {} }));

import { fetchStudentAssignments } from '@/services/student-assignments';

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupMocks({
  userExists = true,
  tests = [
    makeDoc('test-listening-001', fixtureTestListening),
    makeDoc('test-reading-001', fixtureTestReading),
  ],
  results = [makeDoc('res-1', fixtureListeningResult)],
  writing: writingDocs = [] as ReturnType<typeof makeDoc>[],
  classResults = [] as ReturnType<typeof makeDoc>[],
} = {}) {
  // getDoc is called for: users/email (user profile)
  mockGetDoc.mockImplementation(() => {
    if (userExists) {
      return Promise.resolve(makeDocSnap(STUDENT_EMAIL, fixtureUser));
    }
    return Promise.resolve(makeDocSnap(STUDENT_EMAIL, null));
  });

  // fetchStudentAssignments calls Promise.all([ getDoc(user), getDocs(tests), getDocs(results), getDocs(writing) ])
  // Then a second getDocs for the class code lookup (inside try/catch if userClassId is set)
  mockGetDocs
    .mockResolvedValueOnce(makeQuerySnap(tests))        // 1st: all tests
    .mockResolvedValueOnce(makeQuerySnap(results))      // 2nd: testResults
    .mockResolvedValueOnce(makeQuerySnap(writingDocs))  // 3rd: writing
    .mockResolvedValueOnce(makeQuerySnap(classResults)) // 4th: classes code lookup
    .mockResolvedValue(makeQuerySnap(classResults));    // fallback for any extra calls
}

// ─────────────────────────────────────────────────────────────────────────────

describe('fetchStudentAssignments', () => {
  beforeEach(() => {
    mockGetDocs.mockReset();
    mockGetDoc.mockReset();
  });

  it('includes tests with distribution=all for any student', async () => {
    setupMocks({
      tests: [makeDoc('test-listening-001', fixtureTestListening)],
      results: [],
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);

    expect(assignments.some((a) => a.id === 'test-listening-001')).toBe(true);
  });

  it('includes tests with distribution=specific when class matches', async () => {
    setupMocks({
      tests: [makeDoc('test-writing-001', fixtureTestWriting)],
      results: [],
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);
    expect(assignments.some((a) => a.id === 'test-writing-001')).toBe(true);
  });

  it('excludes tests with distribution=specific when class does not match', async () => {
    setupMocks({
      tests: [makeDoc('test-private', fixtureTestPrivate)],
      results: [],
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);
    expect(assignments.some((a) => a.id === 'test-private')).toBe(false);
  });

  it('marks assignment COMPLETED when testResult is present', async () => {
    setupMocks({
      tests: [makeDoc('test-listening-001', fixtureTestListening)],
      results: [makeDoc('res-1', fixtureListeningResult)],
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);

    expect(assignments[0].status).toBe('COMPLETED');
    expect(assignments[0].band).toBe(6.5);
  });

  it('marks assignment NOT_DONE when no matching result exists', async () => {
    setupMocks({
      tests: [makeDoc('test-reading-001', fixtureTestReading)],
      results: [], // no results for reading
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);

    expect(assignments[0].status).toBe('NOT_DONE');
  });

  it('marks assignment COMPLETED from graded writing submission', async () => {
    setupMocks({
      tests: [makeDoc('test-writing-001', fixtureTestWriting)],
      results: [],
      writing: [makeDoc('wr-1', fixtureWritingGraded)],
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);

    const writingAssignment = assignments.find((a) => a.id === 'test-writing-001');
    expect(writingAssignment?.status).toBe('COMPLETED');
  });

  it('infers skill from test name when skill field is absent', async () => {
    const testNoSkill = {
      ...fixtureTestListening,
      skill: '',
      name: 'Listening Section 4',
    };

    setupMocks({
      tests: [makeDoc('test-x', testNoSkill)],
      results: [],
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);
    expect(assignments[0].skill).toBe('listening');
  });

  it('places NOT_DONE assignments before COMPLETED in the sorted result', async () => {
    setupMocks({
      tests: [
        makeDoc('test-listening-001', fixtureTestListening),   // will be COMPLETED
        makeDoc('test-reading-001', fixtureTestReading),        // will be NOT_DONE
      ],
      results: [makeDoc('res-1', fixtureListeningResult)],
    });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);
    const statuses = assignments.map((a) => a.status);

    const firstDoneIdx = statuses.indexOf('COMPLETED');
    const lastNotDoneIdx = statuses.lastIndexOf('NOT_DONE');

    // All NOT_DONE must come before any COMPLETED
    expect(lastNotDoneIdx).toBeLessThan(firstDoneIdx);
  });

  it('returns empty array when there are no accessible tests', async () => {
    setupMocks({ tests: [] });

    const assignments = await fetchStudentAssignments(STUDENT_EMAIL, STUDENT_UID);
    expect(assignments).toEqual([]);
  });
});
