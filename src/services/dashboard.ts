import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  orderBy,
  limit,
  documentId,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';

export interface SkillStat {
  average: number;
  count: number;
  total: number;
}

export interface DashboardStats {
  totalTests: number;
  activeStudents: number;
  averageScore: number;
  pendingGrading: number;
  completedTests: number;
  skillStats: {
    listening: SkillStat;
    reading: SkillStat;
    writing: SkillStat;
  };
}

export interface ActivityRecord {
  id: string;
  testId: string;
  studentName: string;
  studentEmail: string;
  className: string;
  testName: string;
  testSkill: string;
  score: number | null;
  status: string;
  date: string | Date;
  timeSpentMinutes: number | null;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Track in-flight requests to prevent duplicate queries
const requestMap = new Map<string, Promise<any>>();

export function invalidateDashboardDataCache(teacherEmail: string): void {
  const statsKey = `dashboard_stats_${teacherEmail}`;
  const activitiesKey = `recent_activities_${teacherEmail}`;

  if (typeof window !== 'undefined') {
    localStorage.removeItem(statsKey);
    localStorage.removeItem(`${statsKey}_time`);
    localStorage.removeItem(activitiesKey);
    localStorage.removeItem(`${activitiesKey}_time`);
  }

  requestMap.delete(`stats_${teacherEmail}`);
  requestMap.delete(`activities_${teacherEmail}`);
}

/**
 * Batch fetch documents by IDs with 10-ID limit handling
 */
async function batchGetDocumentsById(
  db: ReturnType<typeof getFirestore>,
  collectionName: string,
  ids: Set<string>
): Promise<Map<string, any>> {
  if (ids.size === 0) return new Map();

  const cache = new Map();
  const idsArray = Array.from(ids);
  const chunks: string[][] = [];

  // Firestore 'in' query limit is 10, so batch in chunks
  for (let i = 0; i < idsArray.length; i += 10) {
    chunks.push(idsArray.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    try {
      const q = query(collection(db, collectionName), where(documentId(), 'in', chunk));
      const snapshot = await getDocs(q);
      snapshot.docs.forEach((doc) => {
        cache.set(doc.id, doc.data());
      });
    } catch (error) {
      console.log(`Error batch querying ${collectionName}:`, error);
    }
  }

  return cache;
}

/**
 * Batch fetch user documents by email field.
 * Falls back to document-ID lookup if the email-field query fails.
 */
async function batchGetUserDocuments(
  db: ReturnType<typeof getFirestore>,
  emails: Set<string>
): Promise<Map<string, any>> {
  if (emails.size === 0) return new Map();

  const cache = new Map();
  const emailsArray = Array.from(emails);
  const chunks: string[][] = [];

  for (let i = 0; i < emailsArray.length; i += 10) {
    chunks.push(emailsArray.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    // Primary: query by email field
    try {
      const q = query(collection(db, 'users'), where('email', 'in', chunk));
      const snapshot = await getDocs(q);
      if (snapshot.docs.length > 0) {
        snapshot.docs.forEach((doc) => {
          const data = doc.data();
          if (data.email) cache.set(data.email, data);
        });
        continue;
      }
    } catch (error) {
      console.log(`email-field query failed, falling back to doc ID:`, error);
    }

    // Fallback: treat each email as a document ID and fetch directly
    for (const email of chunk) {
      try {
        const snap = await getDoc(doc(db, 'users', email));
        if (snap.exists()) {
          const data = snap.data();
          cache.set(email, data);
          if (data.email) cache.set(data.email, data);
        }
      } catch { /* ignore individual failures */ }
    }
  }

  return cache;
}

/**
 * Batch fetch documents by classCode
 */
async function batchGetDocumentsByCode(
  db: ReturnType<typeof getFirestore>,
  collectionName: string,
  codes: Set<string>
): Promise<Map<string, any>> {
  if (codes.size === 0) return new Map();

  const cache = new Map();
  const codesArray = Array.from(codes);
  const chunks: string[][] = [];

  for (let i = 0; i < codesArray.length; i += 10) {
    chunks.push(codesArray.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    try {
      const q = query(collection(db, collectionName), where('code', 'in', chunk));
      const snapshot = await getDocs(q);
      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        if (data.code) cache.set(data.code, data);
      });
    } catch (error) {
      console.log(`Error batch querying ${collectionName} by code:`, error);
    }
  }

  return cache;
}

/**
 * Calculate dashboard statistics from Firestore with optimized parallel queries
 * Eliminates N+1 query problems with batch loading
 */
export async function calculateDashboardStats(teacherEmail: string): Promise<DashboardStats> {
  const requestKey = `stats_${teacherEmail}`;

  // Deduplicate in-flight requests
  if (requestMap.has(requestKey)) {
    console.log('🔄 Request already in-flight, waiting for existing...');
    return requestMap.get(requestKey)!;
  }

  const perfStart = performance.now();
  const db = getFirestore(firebaseApp);

  try {
    // Check cache first
    const cacheKey = `dashboard_stats_${teacherEmail}`;
    const cachedData = localStorage.getItem(cacheKey);
    const cacheTime = localStorage.getItem(`${cacheKey}_time`);

    if (cachedData && cacheTime && Date.now() - parseInt(cacheTime) < CACHE_DURATION) {
      console.log('📦 Using cached dashboard stats');
      return JSON.parse(cachedData);
    }

    // Wrap in promise to track in-flight requests
    const promise = (async () => {

    console.log('⚡ Starting parallel queries for dashboard stats...');

    // Launch ALL queries in parallel
    const [testsSnapshot, attemptsSnapshot, testResultsSnapshot, writingResultsSnapshot, writingLegacySnapshot, usersSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'tests'))),
      getDocs(query(collection(db, 'attempts'), where('status', '==', 'completed'))),
      getDocs(collection(db, 'testResults')),
      getDocs(query(collection(db, 'testResults'), where('testType', '==', 'writing'))),
      getDocs(collection(db, 'writing')),
      getDocs(collection(db, 'users')),
    ]);

    console.log('✅ All queries completed in', (performance.now() - perfStart).toFixed(0), 'ms');

    // ── 2. Build test skill map from tests collection ───────────────────────────
    const testsCache = new Map<string, any>();
    testsSnapshot.docs.forEach((doc) => {
      testsCache.set(doc.id, doc.data());
    });

    const totalTests = testsSnapshot.size;

    // ── 3. Deduplicate testResults by student+test (keep latest). ──────────────
    // For objective results: keep latest by timestamp.
    // For writing results: prefer the entry that has an actual score (teacher may have graded
    // a submission while the system still records it as 'in_progress').
    const latestResultsByKey = new Map<string, any>();
    for (const resultDoc of testResultsSnapshot.docs) {
      const data = resultDoc.data();
      const skill = String(data.testType || data.skill || '').toLowerCase();
      const key = `${data.studentEmail}_${data.testId}`;
      const completedAt = data.completedAt?.toDate?.()
        || data.submittedAt?.toDate?.()
        || data.gradedAt?.toDate?.()
        || new Date();

      const existing = latestResultsByKey.get(key);
      if (!existing) {
        latestResultsByKey.set(key, { ...data, _skill: skill, _completedAt: completedAt });
        continue;
      }

      const existingScore = existing.writingScore ?? existing.ieltsBand ?? null;
      const newScore = data.writingScore ?? data.ieltsBand ?? null;

      if (existingScore !== newScore) {
        // Different scores — prefer the one with an actual score over a null/zero entry.
        // This handles the case where the graded doc has score=8.5 but gets overwritten by
        // an in_progress doc with score=null.
        if (newScore !== null && newScore > 0 && (existingScore === null || existingScore === 0)) {
          latestResultsByKey.set(key, { ...data, _skill: skill, _completedAt: completedAt });
        }
        // Otherwise keep existing.
      } else {
        // Same score (or both null) — keep latest by timestamp
        if (completedAt > (existing._completedAt ?? new Date(0))) {
          latestResultsByKey.set(key, { ...data, _skill: skill, _completedAt: completedAt });
        }
      }
    }

    console.log('[dashboard] testResults docs fetched:', testResultsSnapshot.docs.length);
    console.log('[dashboard] latestResultsByKey total:', latestResultsByKey.size);
    const writingEntries = [...latestResultsByKey.entries()].filter(([, d]) => d._skill === 'writing' || d._skill === 'default');
    console.log('[dashboard] writing/default entries from testResults:', writingEntries.length);
    for (const [key, data] of writingEntries) {
      const score = data.writingScore ?? data.ieltsBand ?? null;
      console.log(`  key=${key} skill=${data._skill} status=${data.status} score=${score} testType=${data.testType}`);
    }

    // Also check 'writing' collection
    console.log('[dashboard] writing collection docs:', writingLegacySnapshot.docs.length);
    for (const docSnap of writingLegacySnapshot.docs) {
      const d = docSnap.data();
      const score = d.writingScore ?? d.ieltsBand ?? null;
      const status = String(d.status || '').toLowerCase();
      console.log(`  writing_col: testId=${d.testId} student=${d.studentEmail} status=${status} score=${score}`);
    }

    // ── 4. Separate objective (listening/reading) from writing results ───────────
    // For objective: testType is NOT writing. Use the deduped testResults as source.
    const latestObjectiveResults = new Map<string, any>();
    for (const [key, data] of latestResultsByKey) {
      if (data._skill !== 'writing') {
        latestObjectiveResults.set(key, data);
      }
    }

    // For writing: prefer testResults entries that are writing, but also pull from
    // the legacy 'writing' collection and merge. This ensures old submissions are preserved.
    // We track writing entries separately with their raw status for the grader to process.
    const latestWritingResults = new Map<string, any>();
    for (const [key, data] of latestResultsByKey) {
      if (data._skill === 'writing') {
        const existing = latestWritingResults.get(key);
        const existingRawStatus = existing ? String(existing.status || '').toLowerCase() : '';
        const rawStatus = String(data.status || '').toLowerCase();
        const existingScore = existing?.writingScore ?? existing?.ieltsBand ?? null;
        const newScore = data.writingScore ?? data.ieltsBand ?? null;

        if (!existing) {
          latestWritingResults.set(key, data);
        } else if (rawStatus === 'graded' && existingRawStatus !== 'graded') {
          // Graded always beats non-graded
          latestWritingResults.set(key, data);
        } else if (rawStatus === 'graded' && existingRawStatus === 'graded' && existingScore !== newScore) {
          // Same key, both graded — keep the one with the actual score (8.5 beats null/0)
          latestWritingResults.set(key, data);
        } else if (rawStatus === existingRawStatus && existingScore === null && newScore !== null) {
          // Same status, but new entry has a score while existing doesn't
          latestWritingResults.set(key, data);
        }
      }
    }

    // Merge writing submissions from the legacy 'writing' collection
    writingLegacySnapshot.forEach((doc) => {
      const data = doc.data();
      const key = `${data.studentEmail}_${data.testId}`;
      const submittedAt = data.submittedAt?.toDate?.()
        || data.completedAt?.toDate?.()
        || data.gradedAt?.toDate?.()
        || new Date();

      const existing = latestWritingResults.get(key);
      const existingRawStatus = existing ? String(existing.status || '').toLowerCase() : '';
      const rawStatus = String(data.status || '').toLowerCase();
      const existingScore = existing?.writingScore ?? existing?.ieltsBand ?? null;
      const newScore = data.writingScore ?? data.ieltsBand ?? null;

      if (!existing) {
        latestWritingResults.set(key, { ...data, _completedAt: submittedAt });
      } else if (rawStatus === 'graded' && existingRawStatus !== 'graded') {
        latestWritingResults.set(key, { ...data, _completedAt: submittedAt });
      } else if (rawStatus === 'graded' && existingRawStatus === 'graded' && existingScore !== newScore) {
        latestWritingResults.set(key, { ...data, _completedAt: submittedAt });
      } else if (rawStatus === existingRawStatus && existingScore === null && newScore !== null) {
        latestWritingResults.set(key, { ...data, _completedAt: submittedAt });
      }
    });

    console.log('[dashboard] latestWritingResults:', latestWritingResults.size);
    for (const [key, data] of latestWritingResults) {
      const score = data.writingScore ?? data.ieltsBand ?? null;
      const isG = isWritingGraded(data);
      console.log(`  key=${key} status=${data.status} score=${score} isGraded=${isG}`);
    }

    // ── 5. Get unique students ─────────────────────────────────────────────────
    const allStudents = new Set<string>();
    usersSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.role === 'student' && data.email) {
        allStudents.add(data.email);
      }
    });
    const activeStudents = allStudents.size;

    // ── 6. Calculate skill stats from deduplicated objective results ────────────
    const skillStats = {
      listening: { total: 0, count: 0, average: 0 },
      reading:   { total: 0, count: 0, average: 0 },
      writing:   { total: 0, count: 0, average: 0 },
    };

    // Score lookup: prefer ieltsBand (set by auto-grader), then scores.ieltsBand, then scores.auto
    function getBandScore(data: any): number | null {
      const band = data.ieltsBand ?? data.scores?.ieltsBand ?? data.scores?.auto ?? null;
      return typeof band === 'number' && band > 0 ? band : null;
    }

    for (const [, resultData] of latestObjectiveResults) {
      const score = getBandScore(resultData);
      if (score === null) continue;

      // Resolve skill: from testType in result first, then from tests collection
      let skill: keyof typeof skillStats = 'reading';
      const resultSkill = String(resultData.testType || resultData.skill || '').toLowerCase();
      if (resultSkill === 'listening' || resultSkill === 'reading') {
        skill = resultSkill;
      } else if (resultData.testId && testsCache.has(resultData.testId)) {
        const testSkill = String(testsCache.get(resultData.testId).skill || '').toLowerCase();
        if (testSkill === 'listening' || testSkill === 'reading' || testSkill === 'writing') {
          skill = testSkill;
        }
      }

      skillStats[skill].total += score;
      skillStats[skill].count += 1;
    }

    // ── 7. Add writing stats from graded submissions ────────────────────────────
    // "Graded" means: status is 'graded', OR status is 'completed' with a positive writingScore,
    // OR any status with a positive writingScore (mirrors normalizeStatus in manual-grading.ts).
    function isWritingGraded(data: any): boolean {
      const status = String(data.status || '').toLowerCase();
      const score = data.writingScore ?? data.ieltsBand ?? null;
      if (status === 'graded') return true;
      if (status === 'completed' && typeof score === 'number' && score > 0) return true;
      if (typeof score === 'number' && score > 0) return true;
      return false;
    }

    console.log('[dashboard] latestWritingResults before stats:', latestWritingResults.size);
    for (const [key, data] of latestWritingResults) {
      const score = data.writingScore ?? data.ieltsBand ?? null;
      const isG = isWritingGraded(data);
      console.log(`  writing: key=${key} status=${data.status} score=${score} isGraded=${isG}`);
    }

    for (const [, writingData] of latestWritingResults) {
      if (!isWritingGraded(writingData)) continue;
      const score = writingData.writingScore ?? writingData.ieltsBand ?? null;
      if (typeof score !== 'number' || score <= 0) continue;

      skillStats.writing.total += score;
      skillStats.writing.count += 1;
    }

    console.log('[dashboard] final skillStats:', JSON.stringify(skillStats));

    // ── 8. Calculate pending grading ───────────────────────────────────────────
    const gradedWritingKeys = new Set<string>();
    for (const [key, data] of latestWritingResults) {
      if (isWritingGraded(data)) {
        gradedWritingKeys.add(key);
      }
    }

    // Ungraded writing submissions
    const pendingWritingSubmissions = [...latestWritingResults.values()].filter(
      (entry) => !isWritingGraded(entry),
    ).length;

    // Ungraded writing attempts in 'attempts' collection that have no writing submission
    let pendingWritingAttempts = 0;
    // Re-deduplicate attempts for the pending-grading check
    const latestAttempts = new Map<string, any>();
    for (const attemptDoc of attemptsSnapshot.docs) {
      const data = attemptDoc.data();
      const key = `${data.studentEmail}_${data.testId}`;
      const completedAt = data.completedAt?.toDate?.() || new Date(data.completedAt);
      if (!latestAttempts.has(key) || completedAt > (latestAttempts.get(key)._completedAt ?? new Date(0))) {
        latestAttempts.set(key, { ...data, _completedAt: completedAt });
      }
    }
    for (const [key, attemptData] of latestAttempts) {
      if (attemptData.testId && testsCache.has(attemptData.testId)) {
        const test = testsCache.get(attemptData.testId);
        if (String(test.skill || '').toLowerCase() === 'writing' && !gradedWritingKeys.has(key)) {
          pendingWritingAttempts += 1;
        }
      }
    }

    const totalPendingGrading = pendingWritingSubmissions + pendingWritingAttempts;

    // ── 9. Calculate skill averages ────────────────────────────────────────────
    Object.keys(skillStats).forEach((skill) => {
      const stat = skillStats[skill as keyof typeof skillStats];
      if (stat.count > 0) {
        stat.average = stat.total / stat.count;
      }
    });

    // averageScore = mean of per-skill averages (same logic as Overall Performance in UI)
    const skillAvgValues = [
      skillStats.listening.average,
      skillStats.reading.average,
      skillStats.writing.average,
    ].filter((avg) => avg > 0);
    const averageScore = skillAvgValues.length > 0
      ? skillAvgValues.reduce((sum, avg) => sum + avg, 0) / skillAvgValues.length
      : 0;

    // ── 10. Completed tests = unique objective results + graded writing submissions ─
    const completedTests = latestObjectiveResults.size + gradedWritingKeys.size;

    const stats: DashboardStats = {
      totalTests,
      activeStudents,
      averageScore,
      pendingGrading: totalPendingGrading,
      completedTests,
      skillStats,
    };

    // Cache results
    localStorage.setItem(cacheKey, JSON.stringify(stats));
    localStorage.setItem(`${cacheKey}_time`, Date.now().toString());

    console.log('⚡ Performance: Dashboard stats loaded in', (performance.now() - perfStart).toFixed(0), 'ms');
    console.log('📊 Stats:', stats);

    return stats;
    })();

    // Track in-flight request
    requestMap.set(requestKey, promise);
    try {
      return await promise;
    } finally {
      requestMap.delete(requestKey);
    }
  } catch (error) {
    console.error('❌ Error calculating dashboard stats:', error);
    requestMap.delete(requestKey);
    throw error;
  }
}

/**
 * Get all classes in the system for filter dropdown
 */
export async function getAllClasses(): Promise<string[]> {
  const db = getFirestore(firebaseApp);
  try {
    const snapshot = await getDocs(collection(db, 'classes'));
    const classes: string[] = [];
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.code) classes.push(data.code);
      else if (data.name) classes.push(data.name);
    });
    return classes.sort();
  } catch (error) {
    console.error('Error fetching classes:', error);
    return [];
  }
}

/**
 * Get recent activity with deduplication and caching
 * Uses batch queries to avoid N+1 problems
 */
export async function getRecentActivity(teacherEmail: string): Promise<ActivityRecord[]> {
  const requestKey = `activities_${teacherEmail}`;

  // Deduplicate in-flight requests
  if (requestMap.has(requestKey)) {
    console.log('🔄 Activities request already in-flight, waiting for existing...');
    return requestMap.get(requestKey)!;
  }

  const perfStart = performance.now();
  const db = getFirestore(firebaseApp);

  try {
    // Check cache first
    const cacheKey = `recent_activities_${teacherEmail}`;
    const cachedData = localStorage.getItem(cacheKey);
    const cacheTime = localStorage.getItem(`${cacheKey}_time`);

    if (cachedData && cacheTime && Date.now() - parseInt(cacheTime) < CACHE_DURATION) {
      console.log('📦 Using cached recent activities');
      return JSON.parse(cachedData);
    }

    console.log('⚡ Loading recent activities...');

    // Wrap in promise to track in-flight requests
    const promise = (async () => {

    // Get recent attempts, testResults and writing submissions in parallel
    const [attemptsSnapshot, testResultsSnapshot, writingSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'attempts'), orderBy('completedAt', 'desc'), limit(30))),
      getDocs(query(collection(db, 'testResults'), orderBy('completedAt', 'desc'), limit(30))),
      getDocs(query(collection(db, 'writing'), orderBy('submittedAt', 'desc'), limit(15))),
    ]);

    // Collect unique IDs for batch loading
    const studentEmails = new Set<string>();
    const testIds = new Set<string>();
    const classCodes = new Set<string>();
    const rawActivities: any[] = [];

    // Process testResults (objective + writing)
    testResultsSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      const status = String(data.status || '').toLowerCase();
      const isWriting = String(data.testType || '').toLowerCase() === 'writing';
      const completedAt = data.completedAt;

      // Writing submissions appear regardless of status (pending = just submitted,
      // graded = teacher graded, undefined = submitted without status field set).
      // Objective tests only when status === 'completed' AND completedAt exists (truly submitted).
      // NOTE: completedAt must exist as proof of real submission — a student's in-progress
      // test may have status='completed' but no completedAt until they explicitly submit.
      const isWritingWithStatus = isWriting && (status === 'pending' || status === 'graded' || !status);
      const isObjectiveWithSubmission = !isWriting && status === 'completed' && completedAt;
      if (isWritingWithStatus || isObjectiveWithSubmission) {
        const date = completedAt?.toDate?.()
          || data.submittedAt?.toDate?.()
          || data.gradedAt?.toDate?.()
          || new Date(completedAt || data.submittedAt || data.gradedAt || Date.now());

        rawActivities.push({
          source: 'testResult',
          id: doc.id,
          data,
          date,
        });
        if (data.studentEmail) studentEmails.add(data.studentEmail);
        if (data.testId) testIds.add(data.testId);
      }
    });

    // Process attempts — only include if completedAt exists (student explicitly submitted)
    attemptsSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.status === 'completed' && data.completedAt) {
        rawActivities.push({
          source: 'attempt',
          id: doc.id,
          data,
          date: data.completedAt?.toDate?.() || new Date(data.completedAt),
        });
        if (data.studentEmail) studentEmails.add(data.studentEmail);
        if (data.testId) testIds.add(data.testId);
      }
    });

    // Process writing (all statuses — submitted/pending/graded all go to recent activity)
    writingSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      const status = String(data.status || '').toLowerCase();
      if (status === 'submitted' || status === 'pending' || status === 'graded' || status === 'completed') {
        rawActivities.push({
          source: 'writing',
          id: doc.id,
          data,
          date: data.submittedAt?.toDate?.() || new Date(data.submittedAt),
        });
        if (data.studentEmail) studentEmails.add(data.studentEmail);
        if (data.testId) testIds.add(data.testId);
      }
    });
    const [studentCache, testCache] = await Promise.all([
      batchGetUserDocuments(db, studentEmails),
      batchGetDocumentsById(db, 'tests', testIds),
    ]);

    // Collect class codes
    studentCache.forEach((student) => {
      if (student.classCode) classCodes.add(student.classCode);
    });

    // Batch load classes
    const classCache = await batchGetDocumentsByCode(db, 'classes', classCodes);

    // Map to activity records
    const activities: ActivityRecord[] = rawActivities.map((raw) => {
      const { data } = raw;
      const student = studentCache.get(data.studentEmail);
      const test = testCache.get(data.testId);

      const studentName = student?.displayName || student?.name || data.studentEmail?.split('@')[0] || 'Unknown';
      const className = student?.classCode ? classCache.get(student.classCode)?.name || '' : '';
      const testName = test?.name || data.testName || 'Test';
      const testSkill = test?.skill || data.testType || '';

      // Calculate time spent in minutes
      let timeSpentMinutes: number | null = null;
      if (data.startedAt && data.completedAt) {
        const startTime = data.startedAt?.toDate?.() || new Date(data.startedAt);
        const endTime = data.completedAt?.toDate?.() || new Date(data.completedAt);
        timeSpentMinutes = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60));
      } else if (data.startedAt && data.submittedAt) {
        const startTime = data.startedAt?.toDate?.() || new Date(data.startedAt);
        const endTime = data.submittedAt?.toDate?.() || new Date(data.submittedAt);
        timeSpentMinutes = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60));
      }

      // Score priority: testResults (ieltsBand) > attempts (ieltsBand) > writingScore > scores.ieltsBand > scores.auto
      // NOTE: data.score in testResults is raw correct-answer count, NOT a band — never use it as fallback
      const score =
        (raw.source === 'testResult' ? (data.ieltsBand ?? null) : null)
        ?? (data.ieltsBand ?? data.scores?.ieltsBand ?? data.scores?.auto ?? data.writingScore ?? null);

      return {
        id: raw.id,
        testId: data.testId || '',
        studentName,
        studentEmail: data.studentEmail || '',
        className,
        testName,
        testSkill,
        score: typeof score === 'number' ? score : null,
        status: data.status || 'processing',
        date: raw.date,
        timeSpentMinutes,
      };
    });

    // Separate objective tests (reading/listening) from writing
    const objectiveActivities: ActivityRecord[] = [];
    const writingActivities: ActivityRecord[] = [];

    for (const a of activities) {
      const isWriting = a.testSkill === 'writing';
      if (isWriting) {
        writingActivities.push(a);
      } else {
        objectiveActivities.push(a);
      }
    }

    // For objective tests: deduplicate by student+test, keeping the submission with
    // the highest score (most complete = final submission). Autosaves have lower
    // scores, so the final submission always wins.
    const objectiveMap = new Map<string, ActivityRecord>();
    for (const a of objectiveActivities) {
      const key = `${a.studentEmail}_${a.testId}`;
      const existing = objectiveMap.get(key);
      if (!existing || (a.score !== null && a.score > (existing.score ?? -1))) {
        objectiveMap.set(key, a);
      }
    }

    const deduplicatedObjectives = Array.from(objectiveMap.values());
    const allDeduplicated = [...deduplicatedObjectives, ...writingActivities];

    const finalActivities = allDeduplicated
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 20);

    console.log('⚡ Performance: Recent activity loaded in', (performance.now() - perfStart).toFixed(0), 'ms');
    console.log('📊 Accuracy: Processed', rawActivities.length, '→ Objective dedup:', deduplicatedObjectives.length, '→ Showing', finalActivities.length);

    // Cache results before returning
    localStorage.setItem(cacheKey, JSON.stringify(finalActivities));
    localStorage.setItem(`${cacheKey}_time`, Date.now().toString());

    return finalActivities;
    })();

    // Track in-flight request and await completion
    requestMap.set(requestKey, promise);
    try {
      return await promise;
    } finally {
      requestMap.delete(requestKey);
    }
  } catch (error) {
    console.error('❌ Error loading recent activity:', error);
    requestMap.delete(requestKey);
    throw error;
  }
}
