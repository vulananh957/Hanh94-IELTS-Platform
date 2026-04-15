'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, getFirestore, query, where } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import {
  deleteTestById,
  getTestHubData,
  invalidateTestHubCache,
  subscribeTestHubRealtime,
  updateTestDistribution,
  type TestHubClass,
  type TestHubPayload,
  type TestHubStudent,
  type TestHubTest,
  type TestSkill,
} from '@/services/test-hub';
import '../teacher-dashboard.css';
import './test-hub.css';

const TESTS_PER_PAGE = 10;
const db = getFirestore(firebaseApp);

type SortKey = 'created' | 'name' | 'skill';

type PreviewData = Record<string, unknown> | null;
type PreviewQuestionType = {
  title: string;
  type: string;
  startNumber: number;
  questions: Record<string, unknown>[];
  instructions: string;
  wordBank: string;
  featuresList: string;
  headingsList: string;
  choiceCount: number;
  optionCount: number;
};

type PreviewSection = {
  title: string;
  questionTypes: PreviewQuestionType[];
};

type StudentsStatusRow = {
  student: TestHubStudent;
  displayName: string;
  className: string;
  latestScore: number | null;
  completedAtMs: number | null;
  violationCount: number;
  hasAttempted: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function toStringArray(value: unknown): string[] {
  return asArray(value).map((item) => toText(item, '')).filter(Boolean);
}

function getQuestionText(question: Record<string, unknown>): string {
  return toText(question.question ?? question.text ?? question.instruction ?? question.prompt, 'Question');
}

function getQuestionOptions(question: Record<string, unknown>): string[] {
  return toStringArray(question.options ?? question.answers ?? question.choices);
}

function getQuestionChoiceCount(question: Record<string, unknown>): number {
  const value = Number(question.choiceCount ?? question.choiceNumber ?? question.choicesCount);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function getQuestionOptionCount(question: Record<string, unknown>): number {
  const value = Number(question.optionCount ?? question.optionsCount);
  return Number.isFinite(value) && value > 0 ? value : 6;
}

function normalizeQuestionType(value: unknown, index: number): PreviewQuestionType {
  const record = asRecord(value) || {};
  const questions = asArray(record.questions ?? record.items).map((item) => asRecord(item) || {}).filter(Boolean);

  return {
    title: toText(record.title ?? record.name ?? record.label ?? record.type, `Section ${index + 1}`),
    type: toText(record.type ?? record.kind ?? record.label ?? 'Questions', 'Questions'),
    startNumber: Number.isFinite(Number(record.startNumber ?? record.start ?? 1)) ? Number(record.startNumber ?? record.start ?? 1) : 1,
    questions,
    instructions: toText(record.instructions ?? record.instruction ?? '', ''),
    wordBank: toText(record.wordBank ?? '', ''),
    featuresList: toText(record.featuresList ?? '', ''),
    headingsList: toText(record.headingsList ?? '', ''),
    choiceCount: getQuestionChoiceCount(record),
    optionCount: getQuestionOptionCount(record),
  };
}

function normalizeQuestionTypes(value: unknown): PreviewQuestionType[] {
  return asArray(value).map((item, index) => normalizeQuestionType(item, index));
}

function buildPreviewSections(data: PreviewData, skill: TestSkill): PreviewSection[] {
  const record = asRecord(data);
  if (!record) return [];

  const metadata = asRecord(record.metadata);
  const parts = asArray(metadata?.parts);
  if (parts.length > 0) {
    return parts.map((part, index) => {
      const partRecord = asRecord(part) || {};
      const questionTypes = normalizeQuestionTypes(partRecord.questionTypes ?? partRecord.questionType ?? partRecord.sections ?? partRecord.questions);
      return {
        title: toText(partRecord.name ?? partRecord.title ?? partRecord.partName, `Part ${index + 1}`),
        questionTypes: questionTypes.length > 0 ? questionTypes : [normalizeQuestionType(partRecord, index)],
      };
    });
  }

  const skillSections = skill === 'writing'
    ? asArray(record.writingTasks)
    : skill === 'reading'
      ? asArray(record.readingSections)
      : skill === 'listening'
        ? asArray(record.listeningSections)
        : [];

  if (skillSections.length > 0) {
    return skillSections.map((section, index) => {
      const sectionRecord = asRecord(section) || {};
      const questionTypes = normalizeQuestionTypes(sectionRecord.questionTypes ?? sectionRecord.questions);
      return {
        title: toText(sectionRecord.name ?? sectionRecord.title ?? sectionRecord.partName ?? sectionRecord.label, `Part ${index + 1}`),
        questionTypes: questionTypes.length > 0 ? questionTypes : [normalizeQuestionType(sectionRecord, index)],
      };
    });
  }

  const fallbackQuestions = asArray(record.questions);
  if (fallbackQuestions.length > 0) {
    return [{
      title: 'Questions',
      questionTypes: [{
        title: 'Questions',
        type: 'Questions',
        startNumber: 1,
        questions: fallbackQuestions.map((item) => asRecord(item) || {}),
        instructions: '',
        wordBank: '',
        featuresList: '',
        headingsList: '',
        choiceCount: 3,
        optionCount: 6,
      }],
    }];
  }

  return [];
}

function isLikelyUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return (
    text.startsWith('http://') ||
    text.startsWith('https://') ||
    text.startsWith('gs://') ||
    text.startsWith('/') ||
    text.includes('/o/') ||
    text.includes('%2f')
  );
}

function isAudioUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return /(\.(mp3|wav|m4a|ogg|aac|webm))(\?|#|$)/.test(text) || (isLikelyUrl(text) && text.includes('audio'));
}

function isPdfUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return /\.pdf(\?|#|$)/.test(text) || (isLikelyUrl(text) && text.includes('pdf'));
}

function isImageUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/.test(text) || (isLikelyUrl(text) && text.includes('image'));
}

function collectRawStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 7 || value == null) return;

  if (typeof value === 'string') {
    const text = value.trim();
    if (text) output.push(text);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectRawStrings(item, output, depth + 1));
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  Object.values(record).forEach((item) => collectRawStrings(item, output, depth + 1));
}

function collectMediaUrls(values: unknown[], kind: 'any' | 'audio' | 'pdf' | 'image' = 'any'): string[] {
  const allStrings: string[] = [];
  values.forEach((value) => collectRawStrings(value, allStrings));

  const filtered = allStrings.filter((item) => {
    if (kind === 'audio') return isAudioUrl(item);
    if (kind === 'pdf') return isPdfUrl(item);
    if (kind === 'image') return isImageUrl(item);
    return isLikelyUrl(item);
  });

  return Array.from(new Set(filtered));
}

function getPreviewMedia(data: PreviewData) {
  const record = asRecord(data);
  const files = asRecord(record?.files);
  const metadata = asRecord(record?.metadata);

  return {
    writingTask1: collectMediaUrls([
      files?.writingTask1,
      files?.task1,
      record?.writingTask1,
      record?.writingTask1Files,
    ], 'image'),
    writingTask2: collectMediaUrls([
      files?.writingTask2,
      files?.task2,
      record?.writingTask2,
      record?.writingTask2Files,
    ], 'image'),
    reading: collectMediaUrls([
      files?.reading,
      files?.readingPdf,
      record?.reading,
      record?.readingFile,
      record?.readingPassage,
      asArray(record?.readingSections),
      metadata?.parts,
    ], 'pdf'),
    listening: collectMediaUrls([
      files,
      files?.listening,
      files?.audio,
      files?.listeningAudio,
      record?.listening,
      record?.audioFiles,
      record?.audio,
      record?.listeningAudio,
      asArray(record?.listeningSections),
      metadata?.parts,
    ], 'audio'),
    passageText: toText(record?.passage ?? record?.readingPassageText ?? record?.readingText ?? '', ''),
  };
}

function formatDate(value: Date | null): string {
  if (!value) return '-';
  return value.toLocaleDateString('en-US');
}

function distributionLabel(test: TestHubTest): string {
  return test.distribution === 'all'
    ? 'All Classes'
    : `${Math.max(test.selectedClasses.length, 1)} ${test.selectedClasses.length === 1 ? 'Class' : 'Classes'}`;
}

function getStudentInitials(student: TestHubStudent): string {
  const source = student.name || student.email || 'S';
  return source
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function getSafeTime(value: Date | string | number | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function truncateId(value: string, left = 10, right = 8): string {
  const text = String(value || '');
  if (text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function toSafeDomId(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function extractStudentEmail(data: Record<string, unknown>): string {
  return toText(data.studentEmail ?? data.studentUid ?? data.email, '').toLowerCase();
}

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const record = asRecord(value);
  if (record && typeof (record as { toDate?: unknown }).toDate === 'function') {
    const date = ((record as { toDate: () => Date }).toDate());
    const ms = date.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (record && typeof record.seconds === 'number') {
    return Math.round(Number(record.seconds) * 1000);
  }
  const parsed = new Date(String(value));
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toNumericScore(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 10) / 10;
}

function getViolationCount(value: unknown): number {
  if (!value) return 0;
  if (Array.isArray(value)) return value.length;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  if (typeof value === 'string') {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
  }

  const record = asRecord(value);
  if (!record) return 0;

  const total = Number(record.total ?? record.count ?? 0);
  if (Number.isFinite(total)) return Math.max(0, Math.floor(total));
  return 0;
}

export function TestHubContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [auth, setAuth] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [tests, setTests] = useState<TestHubTest[]>([]);
  const [classes, setClasses] = useState<TestHubClass[]>([]);
  const [students, setStudents] = useState<TestHubStudent[]>([]);

  const [skillFilter, setSkillFilter] = useState<TestSkill | 'all'>('all');
  const [searchFilter, setSearchFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('created');
  const [currentPage, setCurrentPage] = useState(1);

  const [previewTest, setPreviewTest] = useState<TestHubTest | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [studentsTest, setStudentsTest] = useState<TestHubTest | null>(null);
  const [studentsStatusRows, setStudentsStatusRows] = useState<StudentsStatusRow[]>([]);
  const [studentsStatusLoading, setStudentsStatusLoading] = useState(false);
  const [studentsStatusError, setStudentsStatusError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TestHubTest | null>(null);
  const [distributionTarget, setDistributionTarget] = useState<TestHubTest | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editDistributionType, setEditDistributionType] = useState<'all' | 'specific'>('all');
  const [editSelectedClasses, setEditSelectedClasses] = useState<string[]>([]);
  const [isSavingDistribution, setIsSavingDistribution] = useState(false);

  const sidebarRef = useRef<HTMLElement | null>(null);
  const loadSeqRef = useRef(0);
  const studentsStatusCacheRef = useRef<Map<string, StudentsStatusRow[]>>(new Map());
  const studentsAutoOpenRef = useRef(false);
  const studentsAutoScrollRef = useRef(false);

  const openMode = (searchParams.get('open') || '').trim().toLowerCase();
  const focusStudentEmail = (searchParams.get('student') || '').trim().toLowerCase();
  const focusTestId = (searchParams.get('testId') || '').trim();
  const focusTestName = (searchParams.get('test') || '').trim().toLowerCase();
  const focusSkill = (searchParams.get('skill') || '').trim().toLowerCase();

  useEffect(() => {
    studentsAutoOpenRef.current = false;
    studentsAutoScrollRef.current = false;
  }, [openMode, focusStudentEmail, focusTestId, focusTestName, focusSkill]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setAuth(getAuth(firebaseApp));
  }, []);

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, [auth, router]);

  const loadData = async (options?: { showLoading?: boolean; forceFresh?: boolean }) => {
    if (!user?.email) return;
    const { showLoading = true, forceFresh = false } = options || {};
    const seq = ++loadSeqRef.current;

    try {
      if (showLoading) setIsLoading(true);
      setError(null);
      if (forceFresh) invalidateTestHubCache(user.email);

      const payload: TestHubPayload = await getTestHubData(user.email, forceFresh);
      if (seq !== loadSeqRef.current) return;

      setTests(payload.tests);
      setClasses(payload.classes);
      setStudents(payload.students);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load test hub data');
    } finally {
      if (seq === loadSeqRef.current && showLoading) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!user?.email) return;
    let active = true;

    const unsubscribe = subscribeTestHubRealtime(user.email, () => {
      if (!active) return;
      loadData({ showLoading: false, forceFresh: true });
    });

    loadData({ showLoading: true, forceFresh: false });

    const intervalId = setInterval(() => {
      if (!active) return;
      loadData({ showLoading: false, forceFresh: true });
    }, 5 * 60 * 1000);

    return () => {
      active = false;
      unsubscribe();
      clearInterval(intervalId);
    };
  }, [user?.email]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onDocClick = (event: MouseEvent) => {
      const node = sidebarRef.current;
      const target = event.target as Node | null;
      if (!node || !target) return;
      if (!node.contains(target)) setSidebarOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [sidebarOpen]);

  const classMap = useMemo(() => {
    const map = new Map<string, TestHubClass>();
    classes.forEach((cls) => {
      map.set(cls.id, cls);
      if (cls.code) map.set(cls.code, cls);
    });
    return map;
  }, [classes]);

  useEffect(() => {
    studentsStatusCacheRef.current.clear();
  }, [tests, classes, students]);

  // Normalize selectedClasses to use class codes for consistent key matching
  const normalizeSelectedClasses = (rawClasses: string[]): string[] => {
    return rawClasses
      .map((key) => {
        const cls = classMap.get(key);
        // Prefer code as selection key (used in checkboxes)
        return cls ? (cls.code || cls.id) : key;
      })
      .filter((key) => classMap.has(key)); // Only include valid classes
  };

  useEffect(() => {
    if (!distributionTarget) return;
    setEditDistributionType(distributionTarget.distribution);
    // Normalize selected classes to match checkbox keys
    const normalizedClasses = normalizeSelectedClasses(distributionTarget.selectedClasses);
    setEditSelectedClasses(normalizedClasses);
  }, [distributionTarget, classMap]);

  useEffect(() => {
    if (!previewTest) {
      setPreviewData(null);
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;

    const loadPreviewData = async () => {
      setIsPreviewLoading(true);
      try {
        const snapshot = await getDoc(doc(db, 'tests', previewTest.id));
        if (cancelled) return;
        setPreviewData(snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as Record<string, unknown>) : null);
      } catch {
        if (!cancelled) setPreviewData(null);
      } finally {
        if (!cancelled) setIsPreviewLoading(false);
      }
    };

    void loadPreviewData();

    return () => {
      cancelled = true;
    };
  }, [previewTest]);

  const filteredTests = useMemo(() => {
    let list = [...tests];

    if (skillFilter !== 'all') {
      list = list.filter((item) => item.skill === skillFilter);
    }

    if (searchFilter.trim()) {
      const query = searchFilter.toLowerCase();
      list = list.filter((item) => item.name.toLowerCase().includes(query) || item.id.toLowerCase().includes(query));
    }

    list.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
      if (sortBy === 'skill') return a.skill.localeCompare(b.skill, 'en', { sensitivity: 'base' });

      const at = getSafeTime(a.createdAt);
      const bt = getSafeTime(b.createdAt);
      return bt - at;
    });

    return list;
  }, [tests, skillFilter, searchFilter, sortBy]);

  useEffect(() => {
    if (studentsAutoOpenRef.current) return;
    if (openMode !== 'students') return;
    if (!focusStudentEmail) return;
    if (tests.length === 0) return;

    const matchById = focusTestId ? tests.find((test) => test.id === focusTestId) : null;
    const matchByName = !matchById && focusTestName
      ? tests.find((test) => {
          const sameName = test.name.trim().toLowerCase() === focusTestName;
          if (!sameName) return false;
          if (!focusSkill) return true;
          return test.skill === focusSkill;
        })
      : null;

    const targetTest = matchById || matchByName;
    if (!targetTest) return;

    studentsAutoOpenRef.current = true;
    studentsAutoScrollRef.current = false;
    setStudentsTest(targetTest);
  }, [openMode, focusStudentEmail, focusTestId, focusTestName, focusSkill, tests]);

  useEffect(() => {
    setCurrentPage(1);
  }, [skillFilter, searchFilter, sortBy]);

  useEffect(() => {
    if (!studentsTest) return;
    studentsAutoScrollRef.current = false;
  }, [studentsTest]);

  useEffect(() => {
    if (openMode !== 'students') return;
    if (!studentsTest) return;
    if (!focusStudentEmail) return;
    if (studentsStatusLoading) return;
    if (studentsAutoScrollRef.current) return;
    if (focusTestId && studentsTest.id !== focusTestId) return;

    const hasMatch = studentsStatusRows.some(
      (row) => String(row.student.email || '').trim().toLowerCase() === focusStudentEmail,
    );
    if (!hasMatch) return;

    const rowId = `students-row-${toSafeDomId(focusStudentEmail)}`;
    const targetRow = document.getElementById(rowId);
    if (!targetRow) return;

    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    studentsAutoScrollRef.current = true;
  }, [openMode, studentsTest, focusStudentEmail, focusTestId, studentsStatusRows, studentsStatusLoading]);

  const totalPages = Math.max(1, Math.ceil(filteredTests.length / TESTS_PER_PAGE));
  const currentTests = useMemo(() => {
    const start = (currentPage - 1) * TESTS_PER_PAGE;
    return filteredTests.slice(start, start + TESTS_PER_PAGE);
  }, [filteredTests, currentPage]);

  const paginationItems = useMemo(() => {
    if (totalPages <= 1) return [1] as Array<number | 'ellipsis-left' | 'ellipsis-right'>;

    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1) as Array<number | 'ellipsis-left' | 'ellipsis-right'>;
    }

    const items: Array<number | 'ellipsis-left' | 'ellipsis-right'> = [1];
    const windowStart = Math.max(2, currentPage - 1);
    const windowEnd = Math.min(totalPages - 1, currentPage + 1);

    if (windowStart > 2) items.push('ellipsis-left');

    for (let page = windowStart; page <= windowEnd; page += 1) {
      items.push(page);
    }

    if (windowEnd < totalPages - 1) items.push('ellipsis-right');
    items.push(totalPages);

    return items;
  }, [currentPage, totalPages]);

  useEffect(() => {
    if (!studentsTest) {
      setStudentsStatusRows([]);
      setStudentsStatusError(null);
      setStudentsStatusLoading(false);
      return;
    }

    const cachedRows = studentsStatusCacheRef.current.get(studentsTest.id);
    if (cachedRows) {
      setStudentsStatusRows(cachedRows);
      setStudentsStatusError(null);
      setStudentsStatusLoading(false);
      return;
    }

    let cancelled = false;

    const loadStudentsStatus = async () => {
      setStudentsStatusLoading(true);
      setStudentsStatusError(null);

      try {
        const assignedKeys = new Set<string>();
        if (studentsTest.distribution !== 'all') {
          studentsTest.selectedClasses.forEach((key) => {
            const trimmed = String(key || '').trim();
            if (!trimmed) return;

            assignedKeys.add(trimmed);
            const cls = classMap.get(trimmed);
            if (cls) {
              assignedKeys.add(cls.id);
              if (cls.code) assignedKeys.add(cls.code);
            }
          });
        }

        const relevantStudents = studentsTest.distribution === 'all'
          ? students
          : students.filter((student) => {
              const studentClassId = String(student.classId || '').trim();
              const studentClassCode = String(student.classCode || '').trim();
              const keys = new Set<string>();

              if (studentClassId) {
                keys.add(studentClassId);
                const cls = classMap.get(studentClassId);
                if (cls) {
                  keys.add(cls.id);
                  if (cls.code) keys.add(cls.code);
                }
              }

              if (studentClassCode) {
                keys.add(studentClassCode);
                const cls = classMap.get(studentClassCode);
                if (cls) {
                  keys.add(cls.id);
                  if (cls.code) keys.add(cls.code);
                }
              }

              for (const key of keys) {
                if (assignedKeys.has(key)) return true;
              }
              return false;
            });

        const [testResultsSnapshot, attemptsSnapshot, writingSnapshot] = await Promise.all([
          getDocs(query(collection(db, 'testResults'), where('testId', '==', studentsTest.id))),
          getDocs(query(collection(db, 'attempts'), where('testId', '==', studentsTest.id), where('status', '==', 'completed'))),
          getDocs(query(collection(db, 'writing'), where('testId', '==', studentsTest.id))),
        ]);

        if (cancelled) return;

        const attemptedStudents = new Set<string>();
        const scoreByEmail = new Map<string, { score: number | null; completedAtMs: number | null }>();
        const violationCountByEmail = new Map<string, number>();

        const updateScore = (email: string, score: number | null, completedAtMs: number | null) => {
          if (!email) return;
          const current = scoreByEmail.get(email);
          const currentMs = current?.completedAtMs ?? -1;
          const nextMs = completedAtMs ?? -1;

          if (!current || nextMs >= currentMs) {
            scoreByEmail.set(email, { score, completedAtMs });
          }
        };

        const updateViolationCount = (email: string, value: unknown) => {
          if (!email) return;
          const count = getViolationCount(value);
          const prev = violationCountByEmail.get(email) ?? 0;
          if (count > prev) violationCountByEmail.set(email, count);
        };

        testResultsSnapshot.forEach((item) => {
          const data = item.data() as Record<string, unknown>;
          const email = extractStudentEmail(data);
          if (!email) return;

          attemptedStudents.add(email);
          updateScore(email, toNumericScore(data.ieltsBand ?? data.score), toMillis(data.completedAt));
          updateViolationCount(email, data.violations);
          updateViolationCount(email, asRecord(data.antiCheat)?.violations);
        });

        attemptsSnapshot.forEach((item) => {
          const data = item.data() as Record<string, unknown>;
          const email = extractStudentEmail(data);
          if (!email) return;

          attemptedStudents.add(email);
          const scores = asRecord(data.scores);
          updateScore(email, toNumericScore(scores?.writing ?? data.score), toMillis(data.completedAt));
          updateViolationCount(email, data.violations);
          updateViolationCount(email, asRecord(data.antiCheat)?.violations);
        });

        writingSnapshot.forEach((item) => {
          const data = item.data() as Record<string, unknown>;
          const email = extractStudentEmail(data);
          if (!email) return;

          attemptedStudents.add(email);
          updateScore(
            email,
            toNumericScore(data.writingScore ?? data.teacherScore ?? data.score),
            toMillis(data.gradedAt ?? data.submittedAt ?? data.completedAt),
          );

          updateViolationCount(email, data.violations);
          updateViolationCount(email, asRecord(data.violationSummary)?.total ?? asRecord(data.violationSummary)?.count);
          updateViolationCount(email, data.violationCount);
          updateViolationCount(email, asRecord(data.antiCheat)?.violations);
        });

        const rows: StudentsStatusRow[] = relevantStudents.map((student) => {
          const email = String(student.email || '').trim().toLowerCase();
          const classKey = String(student.classId || student.classCode || '').trim();
          const className = classKey ? (classMap.get(classKey)?.name || 'Unknown Class') : 'No Class';
          const displayName = student.displayName || student.name || student.email.split('@')[0] || 'Student';
          const scoreData = scoreByEmail.get(email);

          return {
            student,
            displayName,
            className,
            latestScore: scoreData?.score ?? null,
            completedAtMs: scoreData?.completedAtMs ?? null,
            violationCount: attemptedStudents.has(email) ? (violationCountByEmail.get(email) ?? 0) : 0,
            hasAttempted: attemptedStudents.has(email),
          };
        });

        rows.sort((a, b) => {
          const classCmp = a.className.localeCompare(b.className, 'en', { sensitivity: 'base' });
          if (classCmp !== 0) return classCmp;
          return a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' });
        });

        if (cancelled) return;
        studentsStatusCacheRef.current.set(studentsTest.id, rows);
        setStudentsStatusRows(rows);
      } catch (err) {
        if (cancelled) return;
        setStudentsStatusRows([]);
        setStudentsStatusError(err instanceof Error ? err.message : 'Failed to load students status');
      } finally {
        if (!cancelled) setStudentsStatusLoading(false);
      }
    };

    void loadStudentsStatus();

    return () => {
      cancelled = true;
    };
  }, [studentsTest, students, classMap]);

  const formatStudentsCompletedAt = (value: number | null): string => {
    if (!value || !Number.isFinite(value)) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';

    const dateText = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeText = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    return `${dateText} ${timeText}`;
  };

  const previewMedia = useMemo(() => getPreviewMedia(previewData), [previewData]);

  const previewSections = useMemo(
    () => buildPreviewSections(previewData, previewTest?.skill ?? 'unknown'),
    [previewData, previewTest?.skill],
  );

  const renderPreviewQuestionType = (questionType: PreviewQuestionType, partIndex: number, typeIndex: number) => {
    const normalizedType = questionType.type.toLowerCase();
    const isMultipleChoice = normalizedType.includes('multiple choice') && !normalizedType.includes('choose multiple');
    const isChooseMultiple = normalizedType.includes('choose multiple');
    const isYesNo = normalizedType.includes('yes / no');
    const isTrueFalse = normalizedType.includes('true / false') || isYesNo;
    const isMatching = normalizedType.includes('matching') || normalizedType.includes('pick from a list');
    const isCompletion = normalizedType.includes('completion') || normalizedType.includes('summary') || normalizedType.includes('diagram') || normalizedType.includes('form') || normalizedType.includes('sentence completion');
    const isShortAnswer = normalizedType.includes('short answer');

    return (
      <section className="preview-question-type" key={`${partIndex}-${typeIndex}`}>
        <div className="preview-question-type-header">
          <div>
            <h5>{questionType.title}</h5>
            <p>{questionType.type}</p>
          </div>
        </div>

        {questionType.instructions ? <div className="preview-callout">{questionType.instructions}</div> : null}
        {questionType.wordBank ? <div className="preview-bank"><strong>Word Bank:</strong> {questionType.wordBank}</div> : null}
        {questionType.featuresList ? <div className="preview-bank"><strong>Options:</strong> {questionType.featuresList}</div> : null}
        {questionType.headingsList ? <div className="preview-bank"><strong>Headings:</strong> {questionType.headingsList}</div> : null}

        <div className="preview-question-list">
          {questionType.questions.map((question, questionIndex) => {
            let questionNumber = questionType.startNumber + questionIndex;
            let questionNumberLabel = String(questionNumber);

            if (isChooseMultiple) {
              questionNumber = questionType.startNumber;

              for (let i = 0; i < questionIndex; i += 1) {
                questionNumber += getQuestionChoiceCount(questionType.questions[i] || {});
              }

              const currentChoiceCount = getQuestionChoiceCount(question || {});
              const questionEndNumber = questionNumber + currentChoiceCount - 1;
              questionNumberLabel = currentChoiceCount > 1
                ? `${questionNumber}-${questionEndNumber}`
                : String(questionNumber);
            }

            const questionText = getQuestionText(question);
            const options = getQuestionOptions(question);

            return (
              <article className="preview-question-card" key={`${partIndex}-${typeIndex}-${questionNumber}`}>
                <div className="preview-question-topline">
                  <span className="preview-question-meta">Question {questionNumberLabel}</span>
                </div>
                <p className="preview-question-text">{questionText}</p>

                {isMultipleChoice || isChooseMultiple ? (
                  <div className="preview-option-list">
                    {options.slice(0, questionType.optionCount).map((option, optionIndex) => (
                      <label className="preview-option" key={`${questionNumber}-${optionIndex}`}>
                        <input type={isMultipleChoice ? 'radio' : 'checkbox'} disabled />
                        <span className="preview-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
                        <span>{option}</span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {isTrueFalse ? (
                  <div className="preview-binary-options">
                    {(isYesNo ? ['Yes', 'No', 'Not Given'] : ['True', 'False', 'Not Given']).map((choice) => (
                      <label className="preview-option preview-option-inline" key={choice}>
                        <input type="radio" disabled />
                        <span>{choice}</span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {isMatching || isCompletion || isShortAnswer || (!isMultipleChoice && !isChooseMultiple && !isTrueFalse) ? (
                  <div className="preview-answer-line">
                    <span>Answer</span>
                    <div className="preview-answer-box" />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    );
  };

  const renderWritingLegacyPanel = () => {
    if (previewTest?.skill !== 'writing') return null;

    const writingParts = previewSections.length > 0
      ? previewSections
      : [
          { title: 'Task 1', questionTypes: [] as PreviewQuestionType[] },
          { title: 'Task 2', questionTypes: [] as PreviewQuestionType[] },
        ];

    return (
      <section className="preview-panel preview-panel--questions preview-panel--writing-legacy">
        <div className="preview-panel-header">
          <h3>Writing Questions &amp; Answer Sheets</h3>
          <p>Layout is aligned with the legacy writing preview format</p>
        </div>

        <div className="preview-question-sections">
          {writingParts.map((section, sectionIndex) => {
            const questionCount = section.questionTypes.reduce((count, questionType) => count + questionType.questions.length, 0);
            return (
              <div className="preview-section" key={`${section.title}-${sectionIndex}`}>
                <div className="preview-section-header">
                  <h4>{section.title}</h4>
                </div>

                <div className="preview-section-body preview-writing-legacy-body">
                  <div className="preview-writing-legacy-meta">
                    <span><strong>Estimated Questions:</strong> {questionCount || 'N/A'}</span>
                    <span><strong>Minimum Words:</strong> {sectionIndex === 0 ? '150' : '250'}</span>
                  </div>

                  <div className="preview-writing-legacy-sheet">
                    <div className="preview-writing-legacy-sheet-header">
                      <strong>{sectionIndex === 0 ? 'Task 1 Response Area' : 'Task 2 Response Area'}</strong>
                      <span>Candidate should write in complete sentences.</span>
                    </div>
                    <div className="preview-writing-legacy-lines">
                      {Array.from({ length: 12 }).map((_, lineIndex) => (
                        <div className="preview-writing-legacy-line" key={lineIndex} />
                      ))}
                    </div>
                  </div>

                  {section.questionTypes.length > 0 ? (
                    <div className="preview-writing-legacy-types">
                      {section.questionTypes.map((questionType, typeIndex) => renderPreviewQuestionType(questionType, sectionIndex, typeIndex))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const renderPreviewBody = () => {
    if (!previewTest) return null;

    const media = previewMedia;
    const hasSections = previewSections.length > 0;

    return (
      <div className="preview-shell">
        <div className="preview-hero">
          <div className="preview-hero-title">
            <h2>{previewTest.name}</h2>
            <p>Test Preview Mode</p>
          </div>

          <div className="preview-meta-grid">
            <div className="preview-meta-card"><strong>Skill</strong><span>{previewTest.skill}</span></div>
            <div className="preview-meta-card"><strong>Created</strong><span>{formatDate(previewTest.createdAt)}</span></div>
            <div className="preview-meta-card"><strong>Files</strong><span>{previewTest.filesCount}</span></div>
            <div className="preview-meta-card"><strong>Distribution</strong><span>{distributionLabel(previewTest)}</span></div>
            <div className="preview-meta-card">
              <strong>Test ID</strong>
              <span className="preview-test-id" title={previewTest.id}>{truncateId(previewTest.id)}</span>
            </div>
          </div>
        </div>

        {isPreviewLoading ? (
          <div className="preview-loading">
            <i className="fas fa-spinner" />
            <p>Loading full preview...</p>
          </div>
        ) : null}

        {!isPreviewLoading ? (
          <div className={`preview-layout preview-layout--${previewTest.skill}`}>
            <section className="preview-panel preview-panel--resource">
              <div className="preview-panel-header">
                <h3>{previewTest.skill === 'writing' ? 'Writing Tasks' : previewTest.skill === 'reading' ? 'Reading Passage' : 'Audio Files'}</h3>
                <p>{previewTest.skill === 'writing' ? 'Source files used by students in the test' : previewTest.skill === 'reading' ? 'Passage viewer and source file' : 'Listening audio for each part'}</p>
              </div>

              <div className="preview-resource-stack">
                {previewTest.skill === 'writing' ? (
                  <>
                    {[{ title: 'Task 1', urls: media.writingTask1 }, { title: 'Task 2', urls: media.writingTask2 }].map((task) => (
                      <div className="preview-resource-card" key={task.title}>
                        <div className="preview-resource-card-header"><strong>{task.title}</strong></div>
                        {task.urls.length > 0 ? task.urls.map((url) => (
                          <div className="preview-resource-frame preview-resource-frame--image" key={url}>
                            <img src={url} alt={task.title} />
                          </div>
                        )) : <p className="preview-empty-inline">No {task.title.toLowerCase()} file uploaded</p>}
                      </div>
                    ))}
                  </>
                ) : null}

                {previewTest.skill === 'reading' ? (
                  <div className="preview-resource-card">
                    <div className="preview-resource-card-header"><strong>Reading Source</strong></div>
                    {media.reading.filter((url) => url.toLowerCase().includes('.pdf')).length > 0 ? (
                      media.reading
                        .filter((url) => url.toLowerCase().includes('.pdf'))
                        .map((url) => (
                          <div className="preview-resource-frame" key={url}>
                            <iframe src={url} title="Reading passage PDF" />
                          </div>
                        ))
                    ) : media.passageText ? (
                      <div className="preview-passage-text">{media.passageText}</div>
                    ) : (
                      <p className="preview-empty-inline">No PDF reading file uploaded</p>
                    )}
                  </div>
                ) : null}

                {previewTest.skill === 'listening' ? (
                  <>
                    {media.listening.length > 0 ? media.listening.map((url, index) => (
                      <div className="preview-resource-card" key={url}>
                        <div className="preview-resource-card-header"><strong>Part {index + 1}</strong></div>
                        <audio controls style={{ width: '100%' }}>
                          <source src={url} />
                          Your browser does not support the audio element.
                        </audio>
                      </div>
                    )) : <p className="preview-empty-inline">No audio files uploaded</p>}
                  </>
                ) : null}
              </div>
            </section>

            {previewTest.skill === 'writing' ? renderWritingLegacyPanel() : (
              <section className="preview-panel preview-panel--questions">
                <div className="preview-panel-header">
                  <h3>Questions</h3>
                  <p>{hasSections ? `${previewSections.length} section${previewSections.length === 1 ? '' : 's'} in preview` : 'No structured questions found in this test'}</p>
                </div>

                <div className="preview-question-sections">
                  {hasSections ? previewSections.map((section, sectionIndex) => (
                    <div className="preview-section" key={`${section.title}-${sectionIndex}`}>
                      <div className="preview-section-header">
                        <h4>{section.title}</h4>
                      </div>
                      <div className="preview-section-body">
                        {section.questionTypes.map((questionType, typeIndex) => renderPreviewQuestionType(questionType, sectionIndex, typeIndex))}
                      </div>
                    </div>
                  )) : (
                    <div className="preview-empty-state">
                      <p>This test currently does not expose structured preview data.</p>
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const userInitials = useMemo(() => {
    if (!user) return 'T';
    if (user.displayName) {
      return user.displayName
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase();
    }
    return user.email?.split('@')[0].slice(0, 2).toUpperCase() || 'T';
  }, [user]);

  const handleRefresh = async () => {
    await loadData({ showLoading: true, forceFresh: true });
  };

  const handleLogout = async () => {
    if (!window.confirm('Are you sure you want to logout?')) return;
    try {
      await signOut(auth);
      localStorage.clear();
      router.push('/login');
    } catch {
      router.push('/login');
    }
  };

  const handleDeleteTest = async () => {
    if (!deleteTarget || !user?.email) return;
    try {
      setIsDeleting(true);
      await deleteTestById(deleteTarget.id);
      setDeleteTarget(null);
      invalidateTestHubCache(user.email);
      await loadData({ showLoading: false, forceFresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete test');
    } finally {
      setIsDeleting(false);
    }
  };

  const getClassSelectionKey = (cls: TestHubClass) => cls.code || cls.id;

  const toggleDistributionClass = (classKey: string) => {
    setEditSelectedClasses((prev) => {
      if (prev.includes(classKey)) return prev.filter((item) => item !== classKey);
      return [...prev, classKey];
    });
  };

  const resolveAssignedClassNames = (keys: string[]): string => {
    if (keys.length === 0) return 'All Classes';
    const names = keys
      .map((key) => {
        const cls = classMap.get(key);
        return cls?.name || key;
      })
      .filter(Boolean);
    return names.length > 0 ? names.join(', ') : 'No specific classes';
  };

  const handleSaveDistribution = async () => {
    if (!distributionTarget || !user?.email) return;

    if (editDistributionType === 'specific' && editSelectedClasses.length === 0) {
      setError('Please select at least one class for Specific Classes mode.');
      return;
    }

    try {
      setIsSavingDistribution(true);
      await updateTestDistribution({
        testId: distributionTarget.id,
        distribution: editDistributionType,
        selectedClasses: editDistributionType === 'all' ? [] : editSelectedClasses,
      });

      setDistributionTarget(null);
      invalidateTestHubCache(user.email);
      await loadData({ showLoading: false, forceFresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update distribution');
    } finally {
      setIsSavingDistribution(false);
    }
  };

  return (
    <div className="dashboard-container testhub-page">
      <div className="left-edge-zone" onMouseEnter={() => setSidebarOpen(true)} />

      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">hanh94esl</div>
          <div className="user-role">Smart Teacher Dashboard</div>
        </div>

        <nav className="sidebar-nav">
          <a href="/teacher" className="nav-item">
            <i className="fas fa-tachometer-alt" />
            <span>Dashboard</span>
          </a>
          <a href="/teacher/tests" className="nav-item active">
            <i className="fas fa-database" />
            <span>Test Hub</span>
          </a>
          <a href="/teacher/upload" className="nav-item">
            <i className="fas fa-upload" />
            <span>Upload Test</span>
          </a>
          <a href="/teacher/grading" className="nav-item">
            <i className="fas fa-pen-fancy" />
            <span>Manual Grading</span>
          </a>
          <a href="/teacher/users" className="nav-item">
            <i className="fas fa-users-cog" />
            <span>Manage Users</span>
          </a>
          <button type="button" onClick={handleLogout} className="nav-item">
            <i className="fas fa-sign-out-alt" />
            <span>Logout</span>
          </button>
        </nav>
      </aside>

      <main className="main-content">
        <header className="top-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle Sidebar" aria-label="Toggle Sidebar">
              <i className="fas fa-bars" />
            </button>
            <h1 className="page-title">Test Hub</h1>
          </div>

          <div className="user-info">
            <div className="user-avatar">{user?.photoURL ? <img src={user.photoURL} alt={user.displayName || 'Teacher'} /> : <span>{userInitials}</span>}</div>
            <div className="user-details">
              <h4>{user?.displayName || user?.email?.split('@')[0] || 'Teacher'}</h4>
              <p>IELTS Teacher</p>
            </div>
            <button type="button" className="logout-btn" onClick={handleLogout}>
              <i className="fas fa-sign-out-alt" /> Logout
            </button>
          </div>
        </header>

        <div className="content-area">
          <div className="test-hub-header">
            <h1>Test Hub</h1>
            <p>Manage and control all uploaded tests in one central location</p>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}

          <div className="filters-section">
            <div className="filters-grid">
              <div className="filter-group">
                <label className="filter-label">Test Skill</label>
                <select className="filter-select" value={skillFilter} onChange={(e) => setSkillFilter(e.target.value as TestSkill | 'all')}>
                  <option value="all">All Skills</option>
                  <option value="listening">Listening</option>
                  <option value="reading">Reading</option>
                  <option value="writing">Writing</option>
                  <option value="speaking">Speaking</option>
                </select>
              </div>
              <div className="filter-group">
                <label className="filter-label">Search</label>
                <input
                  className="filter-input"
                  placeholder="Search test names..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                />
              </div>
              <div className="filter-group">
                <label className="filter-label">Sort By</label>
                <select className="filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
                  <option value="created">Date Created</option>
                  <option value="name">Name</option>
                  <option value="skill">Skill</option>
                </select>
              </div>
            </div>
          </div>

          <div className="tests-table-container">
            <div className="tests-table-header">
              <h2>All Tests</h2>
              <button className="btn btn-refresh" type="button" onClick={() => void handleRefresh()}>
                <i className="fas fa-sync-alt" /> Refresh
              </button>
            </div>

            {isLoading ? (
              <div className="loading"><i className="fas fa-spinner" /> Loading tests...</div>
            ) : currentTests.length === 0 ? (
              <div className="empty-state">
                <i className="fas fa-folder-open" />
                <h3>No tests found</h3>
                <p>Try changing filters or upload a new test.</p>
              </div>
            ) : (
              <>
                <table className="tests-table">
                  <thead>
                    <tr>
                      <th>Test Name</th>
                      <th>Skill</th>
                      <th>Created</th>
                      <th>Files</th>
                      <th>Distribution</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentTests.map((test) => (
                      <tr key={test.id}>
                        <td>
                          <div className="test-name">{test.name}</div>
                          <div className="test-id">ID: {test.id}</div>
                        </td>
                        <td className="capitalize">{test.skill}</td>
                        <td>{formatDate(test.createdAt)}</td>
                        <td>{test.filesCount} files</td>
                        <td>
                          <button className={`distribution-badge ${test.distribution === 'all' ? 'all-classes' : 'specific-classes'}`} type="button" onClick={() => setDistributionTarget(test)}>
                            <i className="fas fa-chalkboard" /> {distributionLabel(test)}
                          </button>
                          <div className="distribution-hint">Click to view & edit</div>
                        </td>
                        <td>
                          <div className="action-row">
                            <button className="btn btn-view" type="button" onClick={() => setPreviewTest(test)}>
                              <i className="fas fa-eye" /> Preview
                            </button>
                            <button className="btn btn-students" type="button" onClick={() => setStudentsTest(test)}>
                              <i className="fas fa-users" /> Students
                            </button>
                            <button className="btn btn-delete" type="button" onClick={() => setDeleteTarget(test)}>
                              <i className="fas fa-trash" /> Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="pagination-footer">
                  <div>Showing {(currentPage - 1) * TESTS_PER_PAGE + 1}-{Math.min(currentPage * TESTS_PER_PAGE, filteredTests.length)} of {filteredTests.length} tests</div>
                  <div className="pagination-controls">
                    <button type="button" className="pagination-nav" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
                      <i className="fas fa-chevron-left" /> Previous
                    </button>

                    <div className="pagination-pages">
                      {paginationItems.map((item) => {
                        if (typeof item !== 'number') {
                          return <span key={item} className="pagination-ellipsis">...</span>;
                        }

                        return (
                          <button
                            key={item}
                            type="button"
                            className={`pagination-page-btn ${item === currentPage ? 'active' : ''}`}
                            onClick={() => setCurrentPage(item)}
                          >
                            {item}
                          </button>
                        );
                      })}
                    </div>

                    <button type="button" className="pagination-nav" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
                      Next <i className="fas fa-chevron-right" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {previewTest ? (
        <div className="modal" onClick={() => setPreviewTest(null)}>
          <div className="modal-content preview-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Test Preview</h3>
              <button className="modal-close" type="button" onClick={() => setPreviewTest(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="modal-body">
              {renderPreviewBody()}
            </div>
          </div>
        </div>
      ) : null}

      {studentsTest ? (
        <div className="modal" onClick={() => setStudentsTest(null)}>
          <div className="modal-content students-status-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Students Status</h3>
              <button className="modal-close" type="button" onClick={() => setStudentsTest(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="modal-body">
              <h4 className="students-status-subtitle">Students Status for: {studentsTest.name}</h4>

              <div className="students-status-head">
                <div>Student</div>
                <div>Last Completed</div>
                <div>Latest Score</div>
                <div>Flag Status</div>
                <div>Status</div>
              </div>

              <div className="students-status-list">
                {studentsStatusLoading ? (
                  <div className="loading"><i className="fas fa-spinner" /> Loading students data...</div>
                ) : studentsStatusError ? (
                  <div className="empty-state"><p>{studentsStatusError}</p></div>
                ) : studentsStatusRows.length === 0 ? (
                  <div className="empty-state"><p>No students are assigned to this test.</p></div>
                ) : (
                  studentsStatusRows.map((row) => {
                    const score = row.latestScore;
                    const scoreClass = score == null
                      ? ''
                      : score >= 7
                        ? 'score-high'
                        : score >= 5
                          ? 'score-mid'
                          : 'score-low';
                    const rowEmail = String(row.student.email || '').trim().toLowerCase();
                    const isFocusedRow = openMode === 'students'
                      && !!focusStudentEmail
                      && rowEmail === focusStudentEmail
                      && (!focusTestId || studentsTest?.id === focusTestId);

                    return (
                      <div
                        id={isFocusedRow ? `students-row-${toSafeDomId(rowEmail)}` : undefined}
                        className={`students-status-row ${isFocusedRow ? 'students-status-row-focused' : ''}`}
                        key={row.student.id}
                      >
                        <div className="student-info">
                          <div className="student-avatar students-status-avatar">
                            {row.student.photoURL ? (
                              <img src={row.student.photoURL} alt={row.displayName} />
                            ) : (
                              <span>{getStudentInitials(row.student)}</span>
                            )}
                          </div>
                          <div className="student-details">
                            <h4>{row.className !== 'No Class' ? `${row.displayName} - ${row.className}` : row.displayName}</h4>
                            <p>{row.student.email}</p>
                          </div>
                        </div>

                        <div className="students-status-cell">{formatStudentsCompletedAt(row.completedAtMs)}</div>

                        <div className="students-status-cell">
                          {score == null ? (
                            <span className="students-score-empty">-</span>
                          ) : (
                            <span className={`students-score-chip ${scoreClass}`}>{score}</span>
                          )}
                        </div>

                        <div className="students-status-cell">
                          {!row.hasAttempted ? (
                            <span className="students-flag-empty">-</span>
                          ) : row.violationCount === 0 ? (
                            <span className="students-flag-ok" title="No violations">
                              <i className="fas fa-check-circle" />
                            </span>
                          ) : row.violationCount >= 3 ? (
                            <span className="students-flag-danger" title={`${row.violationCount} violations`}>
                              <i className="fas fa-flag" /> {row.violationCount}
                            </span>
                          ) : (
                            <span className="students-flag-warn" title={`${row.violationCount} violations`}>
                              <i className="fas fa-exclamation-triangle" /> {row.violationCount}
                            </span>
                          )}
                        </div>

                        <div className="students-status-cell">
                          <span className={`student-status ${row.hasAttempted ? 'status-done' : 'status-not-done'}`}>
                            {row.hasAttempted ? 'Completed' : 'Not Done'}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {distributionTarget ? (
        <div className="modal" onClick={() => setDistributionTarget(null)}>
          <div className="modal-content distribution-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Distribution Details &amp; Edit</h3>
              <button className="modal-close" type="button" onClick={() => setDistributionTarget(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="modal-body">
              <div className="distribution-summary">
                <p><strong>Test:</strong> {distributionTarget.name}</p>
                <p><strong>Current Distribution Type:</strong> {distributionTarget.distribution === 'all' ? 'All Classes' : 'Specific Classes'}</p>
                <p><strong>Assigned Classes:</strong> {resolveAssignedClassNames(distributionTarget.selectedClasses)}</p>
              </div>

              <div className="distribution-edit-form">
                <h4 className="distribution-edit-title"><i className="fas fa-edit" /> Edit Distribution</h4>
                <div className="distribution-options">
                  <label className={`distribution-option ${editDistributionType === 'all' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="distributionType"
                      value="all"
                      checked={editDistributionType === 'all'}
                      onChange={() => setEditDistributionType('all')}
                    />
                    <div>
                      <div className="distribution-option-title"><i className="fas fa-globe" /> All Classes</div>
                      <div className="distribution-option-description">Assign this test to all existing classes</div>
                    </div>
                  </label>

                  <label className={`distribution-option ${editDistributionType === 'specific' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="distributionType"
                      value="specific"
                      checked={editDistributionType === 'specific'}
                      onChange={() => setEditDistributionType('specific')}
                    />
                    <div>
                      <div className="distribution-option-title"><i className="fas fa-chalkboard-teacher" /> Specific Classes</div>
                      <div className="distribution-option-description">Choose which classes should receive this test</div>
                    </div>
                  </label>
                </div>

                {editDistributionType === 'specific' ? (
                  <div>
                    <div className="distribution-classes-label">Select Classes:</div>
                    <div className="distribution-classes-list">
                      {classes
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
                        .map((cls) => {
                          const classKey = getClassSelectionKey(cls);
                          const checked = editSelectedClasses.includes(classKey);
                          return (
                            <label key={cls.id} className="distribution-class-item">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleDistributionClass(classKey)}
                              />
                              <span className="distribution-class-name">{cls.name}</span>
                              <span className="distribution-class-code">{cls.code}</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>
                ) : null}

                <div className="distribution-form-actions">
                  <button className="btn btn-cancel" type="button" onClick={() => setDistributionTarget(null)} disabled={isSavingDistribution}>
                    Cancel
                  </button>
                  <button className="btn btn-refresh" type="button" onClick={() => void handleSaveDistribution()} disabled={isSavingDistribution}>
                    <i className="fas fa-save" /> {isSavingDistribution ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal" onClick={() => setDeleteTarget(null)}>
          <div className="modal-content small-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Delete Test</h3>
              <button className="modal-close" type="button" onClick={() => setDeleteTarget(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="modal-body">
              <p>Are you sure you want to delete <strong>{deleteTarget.name}</strong>?</p>
            </div>
            <div className="modal-actions">
              <button className="btn btn-cancel" type="button" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>Cancel</button>
              <button className="btn btn-confirm" type="button" onClick={() => void handleDeleteTest()} disabled={isDeleting}>
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
