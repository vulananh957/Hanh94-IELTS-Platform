import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
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
async function batchGetDocuments(
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
 * Batch fetch documents by email field
 */
async function batchGetDocumentsByEmail(
  db: ReturnType<typeof getFirestore>,
  collectionName: string,
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
    try {
      const q = query(collection(db, collectionName), where('email', 'in', chunk));
      const snapshot = await getDocs(q);
      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        if (data.email) cache.set(data.email, data);
      });
    } catch (error) {
      console.log(`Error batch querying ${collectionName} by email:`, error);
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
    const [testsSnapshot, attemptsSnapshot, writingGradedSnapshot, writingPendingSnapshot, usersSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'tests'))),
      getDocs(query(collection(db, 'attempts'), where('status', '==', 'completed'))),
      getDocs(query(collection(db, 'writing'), where('status', '==', 'graded'))),
      getDocs(query(collection(db, 'writing'), where('status', '==', 'pending'))),
      getDocs(collection(db, 'users')),
    ]);

    console.log('✅ All queries completed in', (performance.now() - perfStart).toFixed(0), 'ms');

    // Build test cache for skill lookup
    const testsCache = new Map();
    testsSnapshot.docs.forEach((doc) => {
      testsCache.set(doc.id, doc.data());
    });

    const totalTests = testsSnapshot.size;

    // Deduplicate attempts - keep only latest per student-test
    const latestAttempts = new Map<string, any>();
    for (const attemptDoc of attemptsSnapshot.docs) {
      const data = attemptDoc.data();
      const key = `${data.studentEmail}_${data.testId}`;
      const completedAt = data.completedAt?.toDate?.() || new Date(data.completedAt);

      if (!latestAttempts.has(key) || completedAt > latestAttempts.get(key).completedAt) {
        latestAttempts.set(key, { ...data, completedAt });
      }
    }

    // Get unique students - from ALL users collection for accurate count
    const allStudents = new Set<string>();
    usersSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.role === 'student' && data.email) {
        allStudents.add(data.email);
      }
    });
    const activeStudents = allStudents.size;

    // Calculate skill scores from attempts
    let totalScore = 0;
    let attemptCount = 0;
    const skillStats = {
      listening: { total: 0, count: 0, average: 0 },
      reading: { total: 0, count: 0, average: 0 },
      writing: { total: 0, count: 0, average: 0 },
    };

    for (const [key, attemptData] of latestAttempts) {
      const score = attemptData.scores?.ieltsBand || attemptData.scores?.auto;
      if (!score || score <= 0) continue;

      totalScore += score;
      attemptCount++;

      // Determine skill from test
      let skill: keyof typeof skillStats = 'reading';
      if (attemptData.testId && testsCache.has(attemptData.testId)) {
        const test = testsCache.get(attemptData.testId);
        if (test.skill && ['listening', 'reading', 'writing'].includes(test.skill)) {
          skill = test.skill as keyof typeof skillStats;
        }
      }

      skillStats[skill].total += score;
      skillStats[skill].count += 1;
    }

    // Process writing submissions - deduplicate by student+test
    const latestWritingSubmissions = new Map<string, any>();
    writingGradedSnapshot.forEach((doc) => {
      const data = doc.data();
      const key = `${data.studentEmail}_${data.testId}`;
      const submittedAt = data.submittedAt?.toDate?.() || new Date(data.submittedAt);

      if (!latestWritingSubmissions.has(key) || submittedAt > latestWritingSubmissions.get(key).submittedAt) {
        latestWritingSubmissions.set(key, { ...data, submittedAt });
      }
    });

    // Add writing scores
    let writingScore = 0;
    let writingCount = 0;
    for (const [key, data] of latestWritingSubmissions) {
      if (data.writingScore && data.writingScore > 0) {
        writingScore += data.writingScore;
        writingCount += 1;
      }
    }

    if (writingCount > 0) {
      skillStats.writing.total += writingScore;
      skillStats.writing.count += writingCount;
    }

    // Calculate pending grading
    const writingSubmissionKeys = new Set<string>();
    writingGradedSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.studentEmail && data.testId) {
        writingSubmissionKeys.add(`${data.studentEmail}_${data.testId}`);
      }
    });
    writingPendingSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.studentEmail && data.testId) {
        writingSubmissionKeys.add(`${data.studentEmail}_${data.testId}`);
      }
    });

    let pendingWritingAttempts = 0;
    for (const [key, attemptData] of latestAttempts) {
      if (attemptData.testId && testsCache.has(attemptData.testId)) {
        const test = testsCache.get(attemptData.testId);
        if (test.skill === 'writing' && !writingSubmissionKeys.has(key)) {
          pendingWritingAttempts += 1;
        }
      }
    }

    const totalPendingGrading = writingPendingSnapshot.size + pendingWritingAttempts;

    // Calculate averages
    Object.keys(skillStats).forEach((skill) => {
      const stat = skillStats[skill as keyof typeof skillStats];
      if (stat.count > 0) {
        stat.average = stat.total / stat.count;
      }
    });

    const totalScoreWithWriting = totalScore + writingScore;
    const totalAttemptsWithWriting = attemptCount + writingCount;
    const averageScore = totalAttemptsWithWriting > 0 ? totalScoreWithWriting / totalAttemptsWithWriting : 0;

    const stats: DashboardStats = {
      totalTests,
      activeStudents,
      averageScore,
      pendingGrading: totalPendingGrading,
      completedTests: attemptCount,
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

    // Get recent attempts and writing submissions in parallel
    const [attemptsSnapshot, writingSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'attempts'), orderBy('completedAt', 'desc'), limit(30))),
      getDocs(query(collection(db, 'writing'), orderBy('submittedAt', 'desc'), limit(15))),
    ]);

    // Collect unique IDs for batch loading
    const studentEmails = new Set<string>();
    const testIds = new Set<string>();
    const classCodes = new Set<string>();
    const rawActivities: any[] = [];

    // Process attempts
    attemptsSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.status === 'completed') {
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

    // Process writing
    writingSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      rawActivities.push({
        source: 'writing',
        id: doc.id,
        data,
        date: data.submittedAt?.toDate?.() || new Date(data.submittedAt),
      });
      if (data.studentEmail) studentEmails.add(data.studentEmail);
      if (data.testId) testIds.add(data.testId);
    });

    // Batch load all related data in parallel
    const [studentCache, testCache] = await Promise.all([
      batchGetDocumentsByEmail(db, 'users', studentEmails),
      batchGetDocuments(db, 'tests', testIds),
    ]);

    // Collect class codes
    studentCache.forEach((student) => {
      if (student.classCode) classCodes.add(student.classCode);
    });

    // Batch load classes
    const classCache = await batchGetDocumentsByCode(db, 'classes', classCodes);

    // Process activities with cached data
    const activities = rawActivities.map((raw) => {
      const { data } = raw;
      const student = studentCache.get(data.studentEmail);
      const test = testCache.get(data.testId);

      const studentName = student?.displayName || student?.name || data.studentEmail?.split('@')[0] || 'Unknown';
      const className = student?.classCode ? classCache.get(student.classCode)?.name || '' : '';
      const testName = test?.name || 'Test';
      const testSkill = test?.skill || '';

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

      return {
        id: raw.id,
        testId: data.testId || '',
        studentName,
        studentEmail: data.studentEmail || '',
        className,
        testName,
        testSkill,
        score: data.scores?.ieltsBand || data.writingScore || null,
        status: data.status === 'completed' ? 'completed' : data.status || 'processing',
        date: raw.date,
        timeSpentMinutes,
      };
    });

    // Deduplicate by student+test, keep latest
    const uniqueActivities = new Map<string, ActivityRecord>();
    activities.forEach((activity) => {
      const key = `${activity.studentEmail}_${activity.testId || activity.testName}_${activity.testSkill}`;
      if (!uniqueActivities.has(key) || new Date(activity.date) > new Date(uniqueActivities.get(key)!.date)) {
        uniqueActivities.set(key, activity);
      }
    });

    const finalActivities = Array.from(uniqueActivities.values())
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 5);

    console.log('⚡ Performance: Recent activity loaded in', (performance.now() - perfStart).toFixed(0), 'ms');
    console.log('📊 Accuracy: Processed', rawActivities.length, '→ Deduplicated to', uniqueActivities.size, '→ Showing', finalActivities.length);

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
