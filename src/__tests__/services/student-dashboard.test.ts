/**
 * Tests for student-dashboard.ts — fetchStudentDashboard
 *
 * Covers:
 * - Overall band calculation (average of per-skill averages, rounded to 0.5)
 * - Skill stats aggregation (listening, reading, writing separately)
 * - testsCompleted = deduplicated results + graded writings
 * - Writing results only count when status='graded' with writingScore > 0
 * - Deduplication keeps latest attempt per testId
 * - Cache: returns cached result on second call without hitting Firestore
 * - invalidateStudentCache clears localStorage entries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeDoc,
  makeDocSnap,
  makeQuerySnap,
  makeTimestamp,
} from '../fixtures/firebase-mock';
import {
  fixtureUser,
  fixtureClass,
  fixtureListeningResult,
  fixtureReadingResult,
  fixtureWritingGraded,
  fixtureWritingPending,
  STUDENT_EMAIL,
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
  getDocs: (...args: any[]) => mockGetDocs(...args),
  getDoc: (...args: any[]) => mockGetDoc(...args),
  orderBy: vi.fn(),
  limit: vi.fn(),
  doc: vi.fn((db: any, col: string, id: string) => `${col}/${id}`),
}));

vi.mock('@/services/firebase', () => ({ firebaseApp: {} }));

import {
  fetchStudentDashboard,
  invalidateStudentCache,
} from '@/services/student-dashboard';

// ── Local storage mock ────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

// ─────────────────────────────────────────────────────────────────────────────

function setupFullMocks({
  results = [
    makeDoc('res-listening', fixtureListeningResult),
    makeDoc('res-reading', fixtureReadingResult),
  ],
  writing: writingDocs = [makeDoc('wr-graded', fixtureWritingGraded)],
  tests = [] as ReturnType<typeof makeDoc>[],
} = {}) {
  // Call order in fetchStudentDashboard:
  // 1. getDoc(users/email) — user profile
  // 2. getDocs(testResults) — results
  // 3. getDocs(writing) — writing
  // 4. getDocs(tests) — all tests
  // 5. getDocs(classes) — for availableTests lookup (can be empty)
  // 6. getDoc(classes/classId) — className (within try block)

  mockGetDoc.mockImplementation((ref: string) => {
    if (typeof ref === 'string' && ref.startsWith('users/')) {
      return Promise.resolve(makeDocSnap(STUDENT_EMAIL, fixtureUser));
    }
    if (typeof ref === 'string' && ref.startsWith('classes/')) {
      return Promise.resolve(makeDocSnap(CLASS_ID, fixtureClass));
    }
    return Promise.resolve(makeDocSnap('', null));
  });

  mockGetDocs
    .mockResolvedValueOnce(makeQuerySnap(results))        // testResults
    .mockResolvedValueOnce(makeQuerySnap(writingDocs))    // writing
    .mockResolvedValueOnce(makeQuerySnap(tests))          // tests
    .mockResolvedValueOnce(makeQuerySnap([]));            // classes (availableTests)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('fetchStudentDashboard', () => {
  beforeEach(() => {
    mockGetDocs.mockReset();
    mockGetDoc.mockReset();
    localStorageMock.clear();
    // Clear the in-memory requestMap between tests by invalidating the cache
    invalidateStudentCache(STUDENT_EMAIL);
  });

  it('returns skill averages rounded to nearest 0.5', async () => {
    setupFullMocks();

    const stats = await fetchStudentDashboard(STUDENT_EMAIL);

    // Listening: 6.5 → average = 6.5
    expect(stats.skillStats.listening.average).toBe(6.5);
    // Reading: 7.0 → average = 7
    expect(stats.skillStats.reading.average).toBe(7);
    // Writing: 6.5 → average = 6.5
    expect(stats.skillStats.writing.average).toBe(6.5);
  });

  it('calculates overall band as average of skill averages', async () => {
    setupFullMocks();

    const stats = await fetchStudentDashboard(STUDENT_EMAIL);

    // (6.5 + 7.0 + 6.5) / 3 = 6.666… → rounded to nearest 0.5 = 6.5
    expect(stats.overallBand).toBe(6.5);
  });

  it('counts testsCompleted correctly (deduped results + graded writing)', async () => {
    setupFullMocks({
      results: [
        makeDoc('res-listening', fixtureListeningResult),
        makeDoc('res-reading', fixtureReadingResult),
      ],
      writing: [makeDoc('wr-graded', fixtureWritingGraded)],
    });

    const stats = await fetchStudentDashboard(STUDENT_EMAIL);

    // 2 objective tests + 1 graded writing = 3
    expect(stats.testsCompleted).toBe(3);
  });

  it('does not count pending writing in testsCompleted', async () => {
    setupFullMocks({
      results: [makeDoc('res-listening', fixtureListeningResult)],
      writing: [makeDoc('wr-pending', fixtureWritingPending)],
    });

    const stats = await fetchStudentDashboard(STUDENT_EMAIL);

    // 1 objective + 0 graded writing = 1
    expect(stats.testsCompleted).toBe(1);
  });

  it('deduplicates results: keeps latest attempt per testId', async () => {
    const olderAttempt = makeDoc('res-old', {
      ...fixtureListeningResult,
      ieltsBand: 5.0,
      completedAt: makeTimestamp(LAST_WEEK),
    });
    const newerAttempt = makeDoc('res-new', {
      ...fixtureListeningResult,
      ieltsBand: 6.5,
      completedAt: makeTimestamp(TODAY),
    });

    setupFullMocks({
      results: [olderAttempt, newerAttempt],
      writing: [],
    });

    const stats = await fetchStudentDashboard(STUDENT_EMAIL);

    // Only 1 unique testId → count = 1, average = 6.5 (latest)
    expect(stats.testsCompleted).toBe(1);
    expect(stats.skillStats.listening.average).toBe(6.5);
  });

  it('returns null overallBand when no results exist', async () => {
    setupFullMocks({ results: [], writing: [] });

    const stats = await fetchStudentDashboard(STUDENT_EMAIL);

    expect(stats.overallBand).toBeNull();
  });

  it('returns weeklyActivity array with 7 entries', async () => {
    setupFullMocks();

    const stats = await fetchStudentDashboard(STUDENT_EMAIL);

    expect(stats.weeklyActivity).toHaveLength(7);
  });

  it('caches result and does not call Firestore on second call', async () => {
    setupFullMocks();
    await fetchStudentDashboard(STUDENT_EMAIL);

    const callCountAfterFirst = mockGetDocs.mock.calls.length;

    // Simulate second call (should use localStorage cache)
    localStorageMock.setItem(
      `student_stats_${STUDENT_EMAIL}`,
      JSON.stringify(await fetchStudentDashboard(STUDENT_EMAIL)),
    );
    localStorageMock.setItem(
      `student_stats_${STUDENT_EMAIL}_time`,
      Date.now().toString(),
    );

    // The internal cache (requestMap) was cleared by invalidateStudentCache in beforeEach,
    // so the second call must re-use the localStorage entry
    const callCountAfterSecond = mockGetDocs.mock.calls.length;
    expect(callCountAfterSecond).toBe(callCountAfterFirst);
  });

  it('invalidateStudentCache removes localStorage keys', () => {
    localStorageMock.setItem(`student_stats_${STUDENT_EMAIL}`, '{}');
    localStorageMock.setItem(`student_stats_${STUDENT_EMAIL}_time`, '1234');

    invalidateStudentCache(STUDENT_EMAIL);

    expect(localStorageMock.getItem(`student_stats_${STUDENT_EMAIL}`)).toBeNull();
    expect(localStorageMock.getItem(`student_stats_${STUDENT_EMAIL}_time`)).toBeNull();
  });
});
