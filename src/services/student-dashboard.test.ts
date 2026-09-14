import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  getFirestore: vi.fn(() => ({})),
  assignedTests: vi.fn(),
}));

vi.mock('./firebase', () => ({ firebaseApp: {} }));
vi.mock('./test-access', () => ({ fetchAssignedTestSummaries: mocks.assignedTests }));
vi.mock('firebase/firestore', () => ({
  getFirestore: mocks.getFirestore,
  collection: (_db: unknown, name: string) => ({ name }),
  query: (source: { name: string }) => source,
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  doc: (_db: unknown, name: string, id: string) => ({ name, id }),
  getDocs: mocks.getDocs,
  getDoc: mocks.getDoc,
}));

import {
  fetchStudentDashboard,
  fetchStudentRecentActivity,
  invalidateStudentCache,
} from './student-dashboard';

const email = 'student@example.com';
const date = (iso: string) => ({ toDate: () => new Date(iso) });
const snapshot = (rows: Array<[string, Record<string, unknown>]>) => ({
  docs: rows.map(([id, data]) => ({ id, data: () => data })),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T10:00:00+07:00'));
  mocks.getDoc.mockImplementation(async ({ name, id }: { name: string; id: string }) => {
    if (name === 'users') return { exists: () => true, data: () => ({ classId: 'class-2k8' }) };
    if (name === 'classes' && id === 'class-2k8') return { exists: () => true, data: () => ({ name: '2k8' }) };
    return { exists: () => false, data: () => ({}) };
  });
});

afterEach(() => vi.useRealTimers());

describe('student dashboard data', () => {
  it('shows only unfinished, unlocked assigned tests as pending and excludes unsubmitted writing', async () => {
    mocks.assignedTests.mockResolvedValue([
      { id: 'objective-done', name: 'Reading 1', skill: 'reading' },
      { id: 'objective-pending', name: 'Reading 2', skill: 'reading' },
      { id: 'screen-locked', name: 'Listening 1', skill: 'listening', accessLock: { status: 'locked' } },
    ]);
    mocks.getDocs.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'testResults') return snapshot([
        ['objective-result', {
          testId: 'objective-done', testType: 'reading', status: 'completed', ieltsBand: 7,
          completedAt: date('2026-09-13T10:00:00+07:00'),
        }],
        ['writing-draft-result', {
          testId: 'writing-draft', testType: 'writing', status: 'in_progress',
          startedAt: date('2026-09-14T09:00:00+07:00'),
        }],
      ]);
      if (name === 'writing') return snapshot([
        ['writing-draft', {
          testId: 'writing-draft', status: 'in_progress',
          startedAt: date('2026-09-14T09:00:00+07:00'),
        }],
      ]);
      return snapshot([]);
    });

    const stats = await fetchStudentDashboard(email);

    expect(stats.testsCompleted).toBe(1);
    expect(stats.availableTests).toBe(1);
    expect(stats.className).toBe('2k8');
  });

  it('never presents a raw correct-answer count as an IELTS band', async () => {
    mocks.assignedTests.mockResolvedValue([
      { id: 'legacy-objective', name: 'Reading legacy', skill: 'reading' },
    ]);
    mocks.getDocs.mockImplementation(async ({ name }: { name: string }) => (
      name === 'testResults'
        ? snapshot([['legacy-result', {
          testId: 'legacy-objective', testType: 'reading', status: 'completed', score: 32,
          completedAt: date('2026-09-14T09:00:00+07:00'),
        }]])
        : snapshot([])
    ));

    const [stats, activity] = await Promise.all([
      fetchStudentDashboard(email),
      fetchStudentRecentActivity(email),
    ]);

    expect(stats.testsCompleted).toBe(1);
    expect(stats.overallBand).toBeNull();
    expect(stats.skillStats.reading.count).toBe(0);
    expect(activity).toEqual([expect.objectContaining({ score: null })]);
  });

  it('keeps the full completion history for calendar activity while the UI can choose its own recent-item limit', async () => {
    mocks.assignedTests.mockResolvedValue([]);
    mocks.getDocs.mockImplementation(async ({ name }: { name: string }) => (
      name === 'testResults'
        ? snapshot([
          ['one', { testId: 'one', testType: 'reading', status: 'completed', ieltsBand: 6, completedAt: date('2026-09-14T09:00:00+07:00') }],
          ['two', { testId: 'two', testType: 'reading', status: 'completed', ieltsBand: 6, completedAt: date('2026-09-13T09:00:00+07:00') }],
          ['three', { testId: 'three', testType: 'reading', status: 'completed', ieltsBand: 6, completedAt: date('2026-09-12T09:00:00+07:00') }],
          ['four', { testId: 'four', testType: 'reading', status: 'completed', ieltsBand: 6, completedAt: date('2026-09-11T09:00:00+07:00') }],
        ])
        : snapshot([])
    ));

    const activities = await fetchStudentRecentActivity(email);

    expect(activities.map((activity) => activity.id)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('does not turn an incomplete or undated record into a completion today', async () => {
    mocks.assignedTests.mockResolvedValue([
      { id: 'not-submitted', name: 'Listening 1', skill: 'listening' },
    ]);
    mocks.getDocs.mockImplementation(async ({ name }: { name: string }) => (
      name === 'testResults'
        ? snapshot([['incomplete', {
          testId: 'not-submitted', testType: 'listening', status: 'completed', ieltsBand: 6,
        }]])
        : snapshot([])
    ));

    const [stats, activities] = await Promise.all([
      fetchStudentDashboard(email),
      fetchStudentRecentActivity(email),
    ]);

    expect(stats.testsCompleted).toBe(0);
    expect(stats.availableTests).toBe(1);
    expect(activities).toEqual([]);
  });
});
