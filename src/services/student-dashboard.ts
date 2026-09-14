'use client';

import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';
import { fetchAssignedTestSummaries } from './test-access';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillStat {
  average: number;
  count: number;
  total: number;
  history: number[];
}

export interface StudentDashboardStats {
  testsCompleted: number;
  availableTests: number;
  overallBand: number | null;
  skillStats: {
    listening: SkillStat;
    reading: SkillStat;
    writing: SkillStat;
  };
  weeklyActivity: WeeklyPoint[];
  className: string | null;
}

export interface WeeklyPoint {
  day: string;
  score: number | null;
  count: number;
}

export interface StudentActivity {
  id: string;
  testId: string;
  testName: string;
  testSkill: 'listening' | 'reading' | 'writing' | 'default';
  score: number | null;
  status: string;
  date: Date;
  timeSpentMinutes: number | null;
}

// ─── Cache helpers ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 'v2';
const requestMap = new Map<string, Promise<any>>();

function statsCacheKey(email: string): string {
  return `student_dashboard_${CACHE_VERSION}_stats_${email}`;
}

function activitiesCacheKey(email: string): string {
  return `student_dashboard_${CACHE_VERSION}_activities_${email}`;
}

function cacheGet<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(key);
  const ts = localStorage.getItem(`${key}_time`);
  if (!raw || !ts) return null;
  if (Date.now() - parseInt(ts) > CACHE_TTL_MS) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function cacheSet(key: string, data: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
    localStorage.setItem(`${key}_time`, Date.now().toString());
  } catch { /* quota exceeded */ }
}

export function invalidateStudentCache(email: string): void {
  if (typeof window === 'undefined') return;
  [
    statsCacheKey(email),
    activitiesCacheKey(email),
    // Clear the preceding cache format too, so an explicit Refresh fully resets it.
    `student_stats_${email}`,
    `student_activities_${email}`,
  ].forEach((k) => {
    localStorage.removeItem(k);
    localStorage.removeItem(`${k}_time`);
  });
  requestMap.delete(`student_stats_${email}`);
  requestMap.delete(`student_activities_${email}`);
}

// ─── Skill resolution (database-driven) ───────────────────────────────────────

function asSkill(value: unknown): 'listening' | 'reading' | 'writing' | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'listening' || normalized === 'reading' || normalized === 'writing') {
    return normalized;
  }
  return null;
}

function resolveSkillFromDb(
  result: Record<string, unknown>,
  testSkillMap: Map<string, 'listening' | 'reading' | 'writing'>,
): 'listening' | 'reading' | 'writing' | null {
  const testId = String(result.testId ?? '').trim();
  if (testId && testSkillMap.has(testId)) {
    return testSkillMap.get(testId) ?? null;
  }

  return asSkill(result.testType) ?? asSkill(result.skill);
}

function asBand(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const band = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(band) && band >= 0 && band <= 9 ? band : null;
}

/** `score` is a raw correct-answer count, never an IELTS band. */
function extractBand(result: Record<string, unknown>): number | null {
  const scores = result.scores && typeof result.scores === 'object'
    ? result.scores as Record<string, unknown>
    : {};
  return asBand(result.ieltsBand) ?? asBand(result.band) ?? asBand(scores.ieltsBand) ?? asBand(scores.auto);
}

function extractDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in (value as Record<string, unknown>) && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  if (value && typeof value === 'object' && 'seconds' in (value as Record<string, unknown>) && typeof (value as { seconds?: unknown }).seconds === 'number') {
    return new Date((value as { seconds: number }).seconds * 1000);
  }
  const parsed = new Date(value as string | number);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStatus(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isSubmittedWriting(status: string): boolean {
  return status === 'submitted' || status === 'pending' || status === 'graded' || status === 'completed';
}

function isGradedWriting(status: string, result: Record<string, unknown>): boolean {
  return status === 'graded' || asBand(result.writingScore) !== null;
}

// ─── Weekly chart builder ─────────────────────────────────────────────────────

function buildWeeklyActivity(
  items: Array<{ completedAt: Date; score: number | null }>,
): WeeklyPoint[] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (6 - i));
    return { day: dayNames[d.getDay()], score: null as number | null, count: 0, _date: d.toDateString() };
  });

  for (const item of items) {
    const slot = days.find((d) => d._date === item.completedAt.toDateString());
    if (!slot) continue;
    slot.count += 1;
    // Include 0 as a valid band score in the weekly chart
    if (item.score !== null) {
      slot.score = (slot.score ?? 0) + item.score;
    }
  }

  return days.map(({ _date, ...rest }) => {
    if (rest.count > 0 && rest.score !== null) {
      rest.score = Math.round((rest.score / rest.count) * 2) / 2;
    }
    return rest as WeeklyPoint;
  });
}

// ─── Main data-fetching function ──────────────────────────────────────────────

export async function fetchStudentDashboard(
  studentEmail: string,
): Promise<StudentDashboardStats> {
  const cacheKey = statsCacheKey(studentEmail);
  const cached = cacheGet<StudentDashboardStats>(cacheKey);
  if (cached) return cached;

  if (requestMap.has(cacheKey)) return requestMap.get(cacheKey) as Promise<StudentDashboardStats>;

  const db = getFirestore(firebaseApp);
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

  const promise = (async (): Promise<StudentDashboardStats> => {

    // ── 1. Parallel fetch ─────────────────────────────────────────────────────
    const [userSnap, resultsSnap, writingSnap, assignedTests] = await Promise.all([
      // User profile
      getDoc(doc(db, 'users', studentEmail)).catch(() => null),

      // ✅ CORRECT collection: testResults (not "attempts")
      // Filter: studentEmail + status=completed  (mirrors old dashboard exactly)
      getDocs(
        query(collection(db, 'testResults'), where('studentEmail', '==', studentEmail)),
      ).catch(() => null),

      // Writing submissions
      getDocs(
        query(
          collection(db, 'writing'),
          where('studentEmail', '==', studentEmail),
        ),
      ).catch(() => null),

      fetchAssignedTestSummaries().catch(() => []),
    ]);

    // ── 2. User class ─────────────────────────────────────────────────────────
    const userClassId: string | null =
      (userSnap?.exists() && (userSnap.data().classId || userSnap.data().classCode)) || null;

    let className: string | null = null;
    if (userClassId) {
      try {
        const classSnap = await getDoc(doc(db, 'classes', userClassId));
        if (classSnap.exists()) {
          className = classSnap.data().name || classSnap.data().code || null;
        } else {
          const cq = await getDocs(query(collection(db, 'classes'), where('code', '==', userClassId)));
          if (!cq.empty) className = cq.docs[0].data().name || userClassId;
        }
      } catch { /* non-critical */ }
    }

    // ── 3. Build test skill map from tests collection (source of truth) ───────
    const testSkillMap = new Map<string, 'listening' | 'reading' | 'writing'>();
    assignedTests.forEach((test) => {
      const skill = asSkill(test.skill);
      if (skill) testSkillMap.set(test.id, skill);
    });

    // ── 4. Deduplicate testResults by testId (keep latest per test) ───────────
    // Same logic as old dashboard: group by testId, keep latest completedAt
    const latestResults = new Map<string, any>();
    const latestWritingResults = new Map<string, any>();
    resultsSnap?.docs.forEach((d) => {
      const result = d.data();
      const testId = result.testId as string;
      if (!testId) return;
      const skill = resolveSkillFromDb(result, testSkillMap);
      const completedAt = extractDate(result.completedAt || result.submittedAt || result.gradedAt);
      const status = normalizeStatus(result.status);
      if (!completedAt) return;

      if (skill === 'writing') {
        if (!isSubmittedWriting(status)) return;
        // Prefer graded over pending; tie-break by timestamp.
        const existing = latestWritingResults.get(testId);
        const existingStatus = existing ? normalizeStatus(existing.status) : '';
        if (
          !existing ||
          (isGradedWriting(status, result) && !isGradedWriting(existingStatus, existing)) ||
          (isGradedWriting(status, result) === isGradedWriting(existingStatus, existing) && completedAt > (extractDate(existing.completedAt || existing.submittedAt || existing.gradedAt) ?? new Date(0)))
        ) {
          latestWritingResults.set(testId, { ...result, _completedAt: completedAt });
        }
        return;
      }

      if (normalizeStatus(result.status) === 'completed') {
        if (!latestResults.has(testId) || completedAt > latestResults.get(testId)._completedAt) {
          latestResults.set(testId, { ...result, _completedAt: completedAt });
        }
      }
    });

    // ── 5. Aggregate skill stats from deduplicated results ────────────────────
    const skillStats: StudentDashboardStats['skillStats'] = {
      listening: { average: 0, count: 0, total: 0, history: [] },
      reading:   { average: 0, count: 0, total: 0, history: [] },
      writing:   { average: 0, count: 0, total: 0, history: [] },
    };

    const weeklyRaw: Array<{ completedAt: Date; score: number | null }> = [];

    for (const [, result] of latestResults) {
      const skill = resolveSkillFromDb(result, testSkillMap);
      const completedAt: Date = result._completedAt;
      // ✅ CORRECT score fields: ieltsBand || score (not scores.ieltsBand)
      const band = extractBand(result);

      // Include 0-band (0 is a valid IELTS score) in weekly chart and skill stats
      weeklyRaw.push({ completedAt, score: band });

      if (skill && skill !== 'writing' && band !== null) {
        skillStats[skill].total += band;
        skillStats[skill].count += 1;
        skillStats[skill].history.push(band);
      }
    }

    // ── 6. Writing: merge testResults (writing) + writing collection, deduplicate by testId ─
    // Use Map keyed by testId to merge both sources, preferring a graded entry and then the newest one.
    const writingMap = new Map<string, any>();
    for (const [testId, resultData] of latestWritingResults) {
      const score = asBand(resultData.writingScore);
      const submittedAt = extractDate(resultData.submittedAt || resultData.completedAt || resultData.gradedAt);
      if (!submittedAt) continue;
      if (!writingMap.has(testId) || (isGradedWriting(normalizeStatus(resultData.status), resultData) && !isGradedWriting(normalizeStatus(writingMap.get(testId).status), writingMap.get(testId))) || submittedAt > writingMap.get(testId)._submittedAt) {
        writingMap.set(testId, { ...resultData, _submittedAt: submittedAt, _score: score });
      }
    }

    writingSnap?.docs.forEach((d) => {
      const data = d.data();
      const testId = (data.testId || d.id) as string;
      const status = normalizeStatus(data.status);
      const submittedAt = extractDate(data.submittedAt || data.completedAt || data.gradedAt);
      const score = asBand(data.writingScore);
      if (!isSubmittedWriting(status) || !submittedAt) return;
      if (!writingMap.has(testId) || (isGradedWriting(status, data) && !isGradedWriting(normalizeStatus(writingMap.get(testId).status), writingMap.get(testId))) || submittedAt > writingMap.get(testId)._submittedAt) {
        writingMap.set(testId, { ...data, _submittedAt: submittedAt, _score: score });
      }
    });

    for (const [, writingData] of writingMap) {
      const score: number | null = writingData._score;
      const submittedAt: Date = writingData._submittedAt;
      const isGraded = isGradedWriting(normalizeStatus(writingData.status), writingData);
      weeklyRaw.push({ completedAt: submittedAt, score: isGraded ? score : null });

      if (isGraded && score !== null) {
        skillStats.writing.total += score;
        skillStats.writing.count += 1;
        skillStats.writing.history.push(score);
      }
    }

    // ── 7. Calculate skill averages (nearest 0.5) ─────────────────────────────
    for (const skill of Object.keys(skillStats) as Array<keyof typeof skillStats>) {
      const stat = skillStats[skill];
      if (stat.count > 0) {
        stat.average = Math.round((stat.total / stat.count) * 2) / 2;
      }
    }

    // ── 8. Overall band = average of per-skill averages ───────────────────────
    const validAverages = [
      skillStats.listening.count > 0 ? skillStats.listening.average : null,
      skillStats.reading.count > 0   ? skillStats.reading.average   : null,
      skillStats.writing.count > 0   ? skillStats.writing.average   : null,
    ].filter((v): v is number => v !== null);

    const overallBand: number | null =
      validAverages.length > 0
        ? Math.round((validAverages.reduce((a, b) => a + b, 0) / validAverages.length) * 2) / 2
        : null;

    // ── 9. Tests completed = unique deduplicated objective results + writing submissions ─
    const writingCompletedCount = writingMap.size;
    const testsCompleted = latestResults.size + writingCompletedCount;

    // ── 10. Available tests (class-filtered, not yet completed by this student) ─
    const completedTestIds = new Set([...latestResults.keys(), ...writingMap.keys()]);
    const availableTests = assignedTests.filter((test) => (
      !completedTestIds.has(test.id) && test.accessLock?.status !== 'locked'
    )).length;

    // ── 11. Weekly activity chart ─────────────────────────────────────────────
    const weeklyActivity = buildWeeklyActivity(weeklyRaw);

    const stats: StudentDashboardStats = {
      testsCompleted,
      availableTests,
      overallBand,
      skillStats,
      weeklyActivity,
      className,
    };

    if (typeof performance !== 'undefined') {
      console.log(`[student-dashboard] ${(performance.now() - t0).toFixed(0)}ms`, {
        testsCompleted,
        availableTests,
        overallBand,
        listeningAvg: skillStats.listening.average,
        readingAvg: skillStats.reading.average,
        writingAvg: skillStats.writing.average,
        latestResultsCount: latestResults.size,
      });
    }

    cacheSet(cacheKey, stats);
    return stats;
  })();

  requestMap.set(cacheKey, promise);
  return promise.finally(() => requestMap.delete(cacheKey));
}

// ─── Recent activity ──────────────────────────────────────────────────────────

export async function fetchStudentRecentActivity(
  studentEmail: string,
): Promise<StudentActivity[]> {
  const cacheKey = activitiesCacheKey(studentEmail);
  const cached = cacheGet<StudentActivity[]>(cacheKey);
  if (cached) return cached.map((a) => ({ ...a, date: new Date(a.date) }));

  if (requestMap.has(cacheKey)) return requestMap.get(cacheKey) as Promise<StudentActivity[]>;

  const db = getFirestore(firebaseApp);

  const promise = (async (): Promise<StudentActivity[]> => {
    const [resultsSnap, writingSnap, assignedTests] = await Promise.all([
      // ✅ CORRECT collection: testResults
      getDocs(
        query(
          collection(db, 'testResults'),
          where('studentEmail', '==', studentEmail),
        ),
      ).catch(() => null),
      getDocs(
        query(
          collection(db, 'writing'),
          where('studentEmail', '==', studentEmail),
        ),
      ).catch(() => null),
      fetchAssignedTestSummaries().catch(() => []),
    ]);

    const raw: StudentActivity[] = [];

    const testSkillMap = new Map<string, 'listening' | 'reading' | 'writing'>();
    assignedTests.forEach((test) => {
      const skill = asSkill(test.skill);
      if (skill) testSkillMap.set(test.id, skill);
    });

    resultsSnap?.docs.forEach((d) => {
      const data = d.data();
      const skill = resolveSkillFromDb(data as Record<string, unknown>, testSkillMap);
      const completedAt = extractDate(data.completedAt || data.submittedAt || data.gradedAt);
      const status = normalizeStatus(data.status);
      const isWriting = skill === 'writing';
      if (!completedAt) return;
      // Writing only appears in recent activity once graded; objective tests appear on submission.
      if ((isWriting && isGradedWriting(status, data)) || (!isWriting && status === 'completed')) {
        // Writing: use writingScore (set by teacher); objective: use ieltsBand/score.
        const score: number | null = isWriting
          ? asBand(data.writingScore)
          : extractBand(data);
        raw.push({
          id: d.id,
          testId: data.testId ?? '',
          testName: data.testName ?? data.name ?? 'Test',
          testSkill: skill ?? 'default',
          score,
          status: String(data.status ?? 'completed'),
          date: completedAt,
          timeSpentMinutes: null,
        });
      }
    });

    writingSnap?.docs.forEach((d) => {
      const data = d.data();
      const submittedAt = extractDate(data.submittedAt || data.completedAt || data.gradedAt);
      const status = normalizeStatus(data.status);
      // Only show writing in recent activity once graded.
      if (submittedAt && isGradedWriting(status, data)) {
        raw.push({
          id: d.id,
          testId: data.testId ?? d.id,
          testName: data.testName ?? 'Writing Test',
          testSkill: 'writing',
          score: asBand(data.writingScore),
          status: String(data.status ?? 'graded'),
          date: submittedAt,
          timeSpentMinutes: null,
        });
      }
    });

    // Deduplicate by Firestore document ID — each doc.id is globally unique,
    // so no two submissions can map to the same key, regardless of how testSkill resolves.
    const uniqueMap = new Map<string, StudentActivity>();
    raw.forEach((a) => {
      if (!uniqueMap.has(a.id)) {
        uniqueMap.set(a.id, a);
      }
    });

    const result = Array.from(uniqueMap.values())
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    cacheSet(cacheKey, result);
    return result;
  })();

  requestMap.set(cacheKey, promise);
  return promise.finally(() => requestMap.delete(cacheKey));
}
