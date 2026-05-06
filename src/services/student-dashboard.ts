'use client';

import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  doc,
  getDoc,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';

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
const requestMap = new Map<string, Promise<any>>();

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
  [`student_stats_${email}`, `student_activities_${email}`].forEach((k) => {
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

/** Extract band score from a testResults document (matches old dashboard field order). */
function extractBand(result: any): number {
  return Number(result.ieltsBand ?? result.score ?? 0);
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
    if (item.score !== null && item.score > 0) {
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
  const cacheKey = `student_stats_${studentEmail}`;
  const cached = cacheGet<StudentDashboardStats>(cacheKey);
  if (cached) return cached;

  if (requestMap.has(cacheKey)) return requestMap.get(cacheKey) as Promise<StudentDashboardStats>;

  const db = getFirestore(firebaseApp);
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

  const promise = (async (): Promise<StudentDashboardStats> => {

    // ── 1. Parallel fetch ─────────────────────────────────────────────────────
    const [userSnap, resultsSnap, writingSnap, testsSnap] = await Promise.all([
      // User profile
      getDoc(doc(db, 'users', studentEmail)).catch(() => null),

      // ✅ CORRECT collection: testResults (not "attempts")
      // Filter: studentEmail + status=completed  (mirrors old dashboard exactly)
      getDocs(
        query(
          collection(db, 'testResults'),
          where('studentEmail', '==', studentEmail),
          where('status', '==', 'completed'),
        ),
      ).catch(() => null),

      // Writing submissions
      getDocs(
        query(
          collection(db, 'writing'),
          where('studentEmail', '==', studentEmail),
        ),
      ).catch(() => null),

      // All tests (for available-count logic)
      getDocs(collection(db, 'tests')).catch(() => null),
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
    testsSnap?.docs.forEach((d) => {
      const skill = asSkill(d.data().skill);
      if (skill) testSkillMap.set(d.id, skill);
    });

    // ── 4. Deduplicate testResults by testId (keep latest per test) ───────────
    // Same logic as old dashboard: group by testId, keep latest completedAt
    const latestResults = new Map<string, any>();
    resultsSnap?.docs.forEach((d) => {
      const result = d.data();
      const testId = result.testId as string;
      if (!testId) return;
      const completedAt: Date = result.completedAt?.toDate?.() ?? new Date(result.completedAt);
      if (!latestResults.has(testId) || completedAt > latestResults.get(testId)._completedAt) {
        latestResults.set(testId, { ...result, _completedAt: completedAt });
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

      weeklyRaw.push({ completedAt, score: band > 0 ? band : null });

      if (skill && skill !== 'writing' && band > 0) {
        skillStats[skill].total += band;
        skillStats[skill].count += 1;
        skillStats[skill].history.push(band);
      }
    }

    // ── 6. Writing: deduplicate by testId, count graded with score > 0 ────────
    // ✅ CORRECT filter: status === 'graded' && writingScore > 0 (mirrors old dashboard)
    const latestWriting = new Map<string, any>();
    writingSnap?.docs.forEach((d) => {
      const data = d.data();
      const key = (data.testId || d.id) as string;
      const submittedAt: Date = data.submittedAt?.toDate?.() ?? new Date(data.submittedAt);
      if (!latestWriting.has(key) || submittedAt > latestWriting.get(key)._submittedAt) {
        latestWriting.set(key, { ...data, _submittedAt: submittedAt, _docId: d.id });
      }
    });

    for (const [, writingData] of latestWriting) {
      const score: number = writingData.writingScore ?? 0;
      const submittedAt: Date = writingData._submittedAt;
      weeklyRaw.push({ completedAt: submittedAt, score: score > 0 ? score : null });

      if (writingData.status === 'graded' && score > 0) {
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

    // ── 9. Tests completed = unique deduplicated test results + graded writings ─
    // Same counting logic as old dashboard:
    //   completedTestsFromCollection.length + completedWritings.length
    const gradedWritingCount = [...latestWriting.values()].filter(
      (w) => w.writingScore > 0 && w.status === 'graded',
    ).length;
    const testsCompleted = latestResults.size + gradedWritingCount;

    // ── 10. Available tests (class-filtered, not yet completed by this student) ─
    let availableTests = 0;
    try {
      const classesSnap = await getDocs(collection(db, 'classes'));
      const classCodeToId = new Map<string, string>();
      classesSnap.docs.forEach((d) => {
        const data = d.data();
        if (data.code) classCodeToId.set(data.code, d.id);
      });

      testsSnap?.docs.forEach((d) => {
        const test = d.data();
        // ✅ Do NOT subtract completed tests — "Available Tests" = all class-accessible tests
        // (matches old dashboard: filter by class only, no completion check)
        const dist = test.classAssignment?.distribution;
        if (!dist || dist === 'all') { availableTests += 1; return; }
        if (dist === 'specific') {
          const selected: string[] = test.classAssignment.selectedClasses ?? [];
          if (!userClassId) return;
          const classDocId = classCodeToId.get(userClassId) ?? userClassId;
          const hasAccess =
            selected.includes(userClassId) ||
            selected.includes(classDocId) ||
            selected.some((s) => classCodeToId.get(s) === classDocId);
          if (hasAccess) availableTests += 1;
        }
      });
    } catch { /* non-critical */ }

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
        gradedWritingCount,
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
  const cacheKey = `student_activities_${studentEmail}`;
  const cached = cacheGet<StudentActivity[]>(cacheKey);
  if (cached) return cached.map((a) => ({ ...a, date: new Date(a.date) }));

  if (requestMap.has(cacheKey)) return requestMap.get(cacheKey) as Promise<StudentActivity[]>;

  const db = getFirestore(firebaseApp);

  const promise = (async (): Promise<StudentActivity[]> => {
    const [resultsSnap, writingSnap, testsSnap] = await Promise.all([
      // ✅ CORRECT collection: testResults
      getDocs(
        query(
          collection(db, 'testResults'),
          where('studentEmail', '==', studentEmail),
          where('status', '==', 'completed'),
          // no orderBy: avoids composite index requirement; we sort in-memory below
          limit(20),
        ),
      ).catch(() => null),
      getDocs(
        query(
          collection(db, 'writing'),
          where('studentEmail', '==', studentEmail),
          // no orderBy: avoids composite index requirement; we sort in-memory below
          limit(10),
        ),
      ).catch(() => null),
      getDocs(collection(db, 'tests')).catch(() => null),
    ]);

    const raw: StudentActivity[] = [];

    const testSkillMap = new Map<string, 'listening' | 'reading' | 'writing'>();
    testsSnap?.docs.forEach((d) => {
      const skill = asSkill(d.data().skill);
      if (skill) testSkillMap.set(d.id, skill);
    });

    resultsSnap?.docs.forEach((d) => {
      const data = d.data();
      const completedAt: Date = data.completedAt?.toDate?.() ?? new Date(data.completedAt);
      // ✅ CORRECT score: ieltsBand || score
      const band = extractBand(data);
      const skill = resolveSkillFromDb(data as Record<string, unknown>, testSkillMap) ?? 'default';
      raw.push({
        id: d.id,
        testId: data.testId ?? '',
        testName: data.testName ?? data.name ?? 'Test',
        testSkill: skill,
        score: band > 0 ? band : null,
        status: 'completed',
        date: completedAt,
        timeSpentMinutes: null,
      });
    });

    writingSnap?.docs.forEach((d) => {
      const data = d.data();
      const submittedAt: Date = data.submittedAt?.toDate?.() ?? new Date(data.submittedAt);
      raw.push({
        id: d.id,
        testId: data.testId ?? d.id,
        testName: data.testName ?? 'Writing Test',
        testSkill: 'writing',
        score: data.writingScore ?? null,
        status: data.status ?? 'pending',
        date: submittedAt,
        timeSpentMinutes: null,
      });
    });

    // Deduplicate per testId+skill, keep latest
    const uniqueMap = new Map<string, StudentActivity>();
    raw.forEach((a) => {
      const key = `${a.testId}_${a.testSkill}`;
      if (!uniqueMap.has(key) || a.date > uniqueMap.get(key)!.date) {
        uniqueMap.set(key, a);
      }
    });

    const result = Array.from(uniqueMap.values())
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 3);

    cacheSet(cacheKey, result);
    return result;
  })();

  requestMap.set(cacheKey, promise);
  return promise.finally(() => requestMap.delete(cacheKey));
}
