'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, getFirestore, serverTimestamp } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import './take-test.css';
import {
  formatSeconds,
  normalizeSkill,
  splitList,
  splitAnswerTokens,
  toLetter,
  calculateSingleAnswerScore,
  calculateMultipleChoiceScore,
  calculateScore,
  calculateIELTSBand,
  generateQuestionResults,
  getImageSrc,
  getQuestionTypeImages,
  getOptions,
} from './take-test-utils';

type Skill = 'listening' | 'reading' | 'writing' | string;
type Answers = Record<string, string>;

type TestQuestion = {
  question?: string;
  instructions?: string;
  choiceCount?: number;
  options?: string[];
  paragraphLetter?: string;
  image?: string;
  imageData?: { src?: string; name?: string };
  summaryText?: string;
  wordBank?: string | string[];
};

type TestQuestionType = {
  type?: string;
  questionCount?: number;
  instructions?: string;
  headings?: string[] | string;
  headingsList?: string;
  headingCount?: number;
  features?: string[] | string;
  featuresList?: string;
  endingsList?: string;
  summaryText?: string;
  wordBank?: string | string[];
  options?: string[] | string;
  customOptionsCount?: number;
  image?: string;
  imageData?: { src?: string; name?: string };
  questions?: TestQuestion[];
};

type TestPart = {
  name?: string;
  questionTypes?: TestQuestionType[];
};

type TestData = {
  id: string;
  name?: string;
  skill?: Skill;
  files?: Record<string, string[]>;
  metadata?: {
    duration?: number | string;
    difficulty?: string;
    parts?: TestPart[];
  };
  answerKey?: Record<string, string | string[]>;
  writingRule?: 'auto-submit' | 'overtime' | string | null;
  ownerUid?: string | null;
};

type QuestionResult = {
  questionId: string;
  questionDisplayName: string;
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  score: number;
  maxScore: number;
  isMultipleChoice?: boolean;
  wordCount?: number;
  minRequired?: number;
};

type SubmitResponse = {
  ok?: boolean;
  autoScore?: number;
  ieltsBand?: number;
  correctAnswers?: number;
  totalQuestions?: number;
};

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'hanh94esl-71776';
const FUNCTIONS_BASE = `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;
const MAX_WARNINGS = 3;

async function callFunction<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const auth = getAuth(firebaseApp);
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Missing auth token. Please sign in again.');

  const response = await fetch(`${FUNCTIONS_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

function isImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes('image/') ||
    lower.includes('data:image/') ||
    /\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?|$)/i.test(lower) ||
    (lower.includes('firebasestorage') && lower.includes('writing'));
}

function MediaPreview({ url, label }: { url: string; label: string }) {
  return (
    <div className="tt-media-preview">
      <div className="tt-media-title">{label}</div>
      <div className="tt-media-frame">
        {isImageUrl(url) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} />
        ) : (
          <iframe src={url} title={label} />
        )}
      </div>
    </div>
  );
}

export function TakeTestContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const testId = searchParams.get('testId') || '';

  const [user, setUser] = useState<User | null>(null);
  const [test, setTest] = useState<TestData | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const answersRef = useRef<Answers>({});
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const attemptIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isStarted, setIsStarted] = useState(false);
  const isStartedRef = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const remainingRef = useRef(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const [isFullscreenPaused, setIsFullscreenPaused] = useState(false);
  const isFullscreenPausedRef = useRef(false);
  const [violations, setViolations] = useState<Array<{ type: string; description: string; timestamp: string }>>([]);
  const violationsRef = useRef<Array<{ type: string; description: string; timestamp: string }>>([]);
  const [warningCount, setWarningCount] = useState(0);
  const warningCountRef = useRef(0);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const tabSwitchCountRef = useRef(0);
  // submitResponse and questionResults removed: redirect to performance page immediately after submit
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [isSubmitConfirmOpen, setIsSubmitConfirmOpen] = useState(false);
  const [activeWritingTask, setActiveWritingTask] = useState<1 | 2>(1);
  const [audioPlayed, setAudioPlayed] = useState<Record<number, 'idle' | 'playing' | 'ended'>>({});
  const [isInitializing, setIsInitializing] = useState(false);
  const [isMonitoringReady, setIsMonitoringReady] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autosaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastTabSwitchRef = useRef(0);
  const isInitializingRef = useRef(false);
  const isFinishedRef = useRef(false);

  const skill = normalizeSkill(test?.skill);
  const durationMinutes = useMemo(() => {
    if (!test) return 60;
    const base = normalizeSkill(test.skill) === 'listening' ? 45 : 60;
    return Number(test.metadata?.duration || base);
  }, [test]);

  const updateAnswers = useCallback((updater: (current: Answers) => Answers) => {
    setAnswers((current) => {
      const next = updater(current);
      answersRef.current = next;
      return next;
    });
  }, []);

  const recordViolation = useCallback((type: string, description: string) => {
    const violation = { type, description, timestamp: new Date().toISOString() };
    violationsRef.current = [...violationsRef.current, violation];
    warningCountRef.current += 1;
    setViolations(violationsRef.current);
    setWarningCount(warningCountRef.current);
    scheduleAutosave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (!attemptIdRef.current) return;
    if (isFinishedRef.current) return;
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    autosaveRef.current = setTimeout(() => {
      void callFunction('/saveAnswers', 'POST', {
        attemptId: attemptIdRef.current,
        answers: answersRef.current,
        antiCheatDelta: {
          violations: violationsRef.current.length,
          tabSwitches: tabSwitchCountRef.current,
        },
      }).catch((err) => console.warn('[take-test autosave]', err));
    }, 500);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const stopMonitoring = useCallback(() => {
    stopTimer();
    isStartedRef.current = false;
    setIsStarted(false);

    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    setScreenStream(null);

    setCameraStream((stream) => {
      stream?.getTracks().forEach((track) => track.stop());
      return null;
    });

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [stopTimer]);

  const startTimer = useCallback((seconds: number) => {
    stopTimer();
    remainingRef.current = seconds;
    setRemainingSeconds(seconds);

    timerRef.current = setInterval(() => {
      remainingRef.current -= 1;
      setRemainingSeconds(remainingRef.current);

      if (remainingRef.current <= 0) {
        stopTimer();
        if (skill === 'writing' && test?.writingRule === 'overtime') {
          alert('Time is up. You can continue writing because this test allows overtime.');
          return;
        }
        void submitTest(true);
      }
    }, 1000);
  // submitTest is a function declaration below; including it would recreate the timer every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill, stopTimer, test?.writingRule]);

  const startCamera = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });

      const [track] = stream.getVideoTracks();
      track?.addEventListener('ended', () => {
        if (!isStartedRef.current) return;
        recordViolation('camera_stopped', 'Camera stream stopped during the test');
      });

      setCameraStream(stream);
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream;
      return true;
    } catch {
      return false;
    }
  }, [recordViolation]);

  const startScreenShare = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' } as MediaTrackConstraints,
        audio: false,
      });
      const [track] = stream.getVideoTracks();
      const settings = track?.getSettings?.() || {};
      const displaySurface = (settings as MediaTrackSettings & { displaySurface?: string }).displaySurface;
      const label = track?.label || '';

      if (displaySurface && displaySurface !== 'monitor') {
        stream.getTracks().forEach((item) => item.stop());
        alert('Please choose Entire screen when sharing your screen.');
        return false;
      }

      if (!displaySurface && label && !/entire screen|screen|monitor/i.test(label)) {
        stream.getTracks().forEach((item) => item.stop());
        alert('Please choose Entire screen when sharing your screen.');
        return false;
      }

      track?.addEventListener('ended', () => {
        if (!isStartedRef.current) return;
        isPausedRef.current = true;
        setIsPaused(true);
        recordViolation('screen_sharing_stopped', 'Student stopped screen sharing');
        stopTimer();
      });

      screenStreamRef.current = stream;
      setScreenStream(stream);
      return true;
    } catch {
      return false;
    }
  }, [recordViolation, stopTimer]);

  const requestFullscreen = useCallback(async (): Promise<boolean> => {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      return true;
    } catch {
      return false;
    }
  }, []);

  const resumeScreenShare = useCallback(async () => {
    const ok = await startScreenShare();
    if (!ok) return;
    isPausedRef.current = false;
    setIsPaused(false);
    startTimer(remainingRef.current || durationMinutes * 60);
  }, [durationMinutes, startScreenShare, startTimer]);

  const resumeFullscreen = useCallback(async () => {
    const ok = await requestFullscreen();
    if (!ok) return;
    isPausedRef.current = false;
    isFullscreenPausedRef.current = false;
    setIsPaused(false);
    setIsFullscreenPaused(false);
    startTimer(remainingRef.current || durationMinutes * 60);
  }, [durationMinutes, requestFullscreen, startTimer]);

  useEffect(() => {
    const auth = getAuth(firebaseApp);
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) router.replace('/login');
    });
    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!testId || !user) return;
    let active = true;
    setIsLoading(true);
    setError(null);

    callFunction<TestData>(`/getTest?id=${encodeURIComponent(testId)}`, 'GET')
      .then((data) => {
        if (!active) return;
        setTest(data);
        const base = normalizeSkill(data.skill) === 'listening' ? 45 : 60;
        const duration = Number(data.metadata?.duration || base);
        remainingRef.current = duration * 60;
        setRemainingSeconds(duration * 60);
      })
      .catch(async (err) => {
        try {
          const db = getFirestore(firebaseApp);
          const snap = await getDoc(doc(db, 'tests', testId));
          if (!snap.exists()) throw err;
          if (!active) return;
          const data = { id: snap.id, ...snap.data() } as TestData;
          setTest(data);
          const base = normalizeSkill(data.skill) === 'listening' ? 45 : 60;
          const duration = Number(data.metadata?.duration || base);
          remainingRef.current = duration * 60;
          setRemainingSeconds(duration * 60);
        } catch (fallbackErr) {
          if (active) setError(fallbackErr instanceof Error ? fallbackErr.message : 'Failed to load test.');
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [testId, user]);

  useEffect(() => {
    if (cameraVideoRef.current && cameraStream) {
      cameraVideoRef.current.srcObject = cameraStream;
    }
  }, [cameraStream]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!isStartedRef.current || !document.hidden) return;
      const now = Date.now();
      if (now - lastTabSwitchRef.current < 5000) return;
      lastTabSwitchRef.current = now;
      tabSwitchCountRef.current += 1;
      setTabSwitchCount(tabSwitchCountRef.current);
      recordViolation('tab_switch', `User switched tab (${tabSwitchCountRef.current} times)`);
    };

    const onFullscreenChange = () => {
      if (!isStartedRef.current) return;
      if (!document.fullscreenElement) {
        recordViolation('fullscreen_exit', 'User exited fullscreen mode');
        isPausedRef.current = true;
        isFullscreenPausedRef.current = true;
        setIsPaused(true);
        setIsFullscreenPaused(true);
        stopTimer();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [recordViolation, stopTimer]);

  useEffect(() => () => {
    stopMonitoring();
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
  }, [stopMonitoring]);

  const setSingleAnswer = (key: string, value: string) => {
    if (isPausedRef.current) {
      alert('Please re-share your entire screen before continuing.');
      return;
    }
    // Don't trim - allow spaces in answers (trim only for comparisons later)
    updateAnswers((current) => ({ ...current, [key]: value }));
    scheduleAutosave();
  };

  const setMultipleAnswer = (start: number, requiredCount: number, value: string, checked: boolean) => {
    if (isPausedRef.current) {
      alert('Please re-share your entire screen before continuing.');
      return;
    }

    const groupId = `${start}-${start + requiredCount - 1}`;
    updateAnswers((current) => {
      const selected = new Set(splitAnswerTokens(current[groupId]));
      if (checked) selected.add(value);
      else selected.delete(value);

      const nextValues = Array.from(selected).sort();
      if (nextValues.length > requiredCount) {
        alert(`You can only select ${requiredCount} options.`);
        return current;
      }

      const next = { ...current, [groupId]: nextValues.join(',') };
      for (let index = 0; index < requiredCount; index += 1) delete next[String(start + index)];
      return next;
    });
    scheduleAutosave();
  };

  const playAudio = (partIndex: number) => {
    const audio = document.getElementById(`tt-audio-${partIndex}`) as HTMLAudioElement | null;
    if (!audio) return;
    if (audioPlayed[partIndex] && audioPlayed[partIndex] !== 'idle') return;

    void audio.play().then(() => {
      setAudioPlayed((current) => ({ ...current, [partIndex]: 'playing' }));
    }).catch(() => {
      setAudioPlayed((current) => ({ ...current, [partIndex]: 'idle' }));
    });
  };

  const validateWriting = (isAutoSubmit = false): boolean => {
    if (!test || skill !== 'writing') return true;
    if (isAutoSubmit) return true; // auto-submit when time is up always ignores word counts
    if (test.writingRule === 'auto-submit') return true; // also allow manual early submit if rule explicitly allows it

    const task1Words = (answersRef.current.writingTask1 || '').trim()
      ? (answersRef.current.writingTask1 || '').trim().split(/\s+/).length
      : 0;
    const task2Words = (answersRef.current.writingTask2 || '').trim()
      ? (answersRef.current.writingTask2 || '').trim().split(/\s+/).length
      : 0;
    const errors: string[] = [];
    if (task1Words < 150) errors.push(`Task 1: You need at least 150 words (currently ${task1Words}).`);
    if (task2Words < 250) errors.push(`Task 2: You need at least 250 words (currently ${task2Words}).`);
    if (errors.length > 0) {
      alert(`Please meet the minimum word count requirements:\n\n${errors.join('\n')}`);
      return false;
    }
    return true;
  };

  const openSubmitConfirm = () => {
    if (!test || !attemptIdRef.current || isSubmitting || isFinished) return;
    if (!validateWriting(false)) return;
    setIsSubmitConfirmOpen(true);
  };

  const startTest = async () => {
    if (!test || isInitializingRef.current) return;

    isInitializingRef.current = true;
    setIsInitializing(true);

    const cameraOk = await startCamera();
    if (!cameraOk) {
      alert('Camera access is required to take this test.');
      isInitializingRef.current = false;
      setIsInitializing(false);
      return;
    }

    const screenOk = await startScreenShare();
    if (!screenOk) {
      alert('Screen sharing is required to take this test.');
      isInitializingRef.current = false;
      setIsInitializing(false);
      return;
    }

    const fullscreenOk = await requestFullscreen();
    if (!fullscreenOk) {
      alert('Fullscreen mode is required to take this test.');
      isInitializingRef.current = false;
      setIsInitializing(false);
      return;
    }

    try {
      const response = await callFunction<{ attemptId: string }>('/startAttempt', 'POST', {
        examId: null,
        testId: test.id,
      });
      attemptIdRef.current = response.attemptId;
      setAttemptId(response.attemptId);
      isInitializingRef.current = false;
      setIsInitializing(false);
      setIsMonitoringReady(true);
    } catch (err) {
      stopMonitoring();
      isInitializingRef.current = false;
      setIsInitializing(false);
      isFullscreenPausedRef.current = false;
      setIsFullscreenPaused(false);
      alert(err instanceof Error ? err.message : 'Failed to start test. Please try again.');
    }
  };

  const beginTest = () => {
    if (!test) return;
    isStartedRef.current = true;
    setIsStarted(true);
    startTimer(durationMinutes * 60);
  };

  async function saveWritingSubmission(resp: SubmitResponse) {
    if (!test || !user) return;
    const db = getFirestore(firebaseApp);
    const task1 = answersRef.current.writingTask1 || '';
    const task2 = answersRef.current.writingTask2 || '';
    const task1Words = task1.trim() ? task1.trim().split(/\s+/).length : 0;
    const task2Words = task2.trim() ? task2.trim().split(/\s+/).length : 0;

    await addDoc(collection(db, 'writing'), {
      testId: test.id,
      testName: test.name || 'Writing Test',
      studentEmail: user.email,
      studentName: user.displayName || user.email?.split('@')[0] || 'Student',
      studentUid: user.uid,
      status: 'pending',
      submittedAt: serverTimestamp(),
      answers: {
        writingTask1: task1,
        writingTask2: task2,
      },
      wordCounts: {
        task1: task1Words,
        task2: task2Words,
      },
      violations: violationsRef.current,
      violationSummary: {
        total: violationsRef.current.length,
        warnings: warningCountRef.current,
        tabSwitches: tabSwitchCountRef.current,
      },
      antiCheat: {
        violations: violationsRef.current.length,
        warnings: warningCountRef.current,
        tabSwitches: tabSwitchCountRef.current,
      },
      timeSpent: durationMinutes * 60 - remainingRef.current,
      testOwnerUid: test.ownerUid || null,
      writingScore: null,
      task1Score: null,
      task2Score: null,
      teacherFeedback: null,
      gradedAt: null,
      gradedBy: null,
      submitResponse: resp,
    });
  }

  async function submitTest(auto = false) {
    if (!test || !attemptIdRef.current || isSubmitting) return;
    if (!validateWriting(auto)) return;

    setIsSubmitConfirmOpen(false);
    setIsSubmitting(true);
    stopTimer();

    try {
      await callFunction('/saveAnswers', 'POST', {
        attemptId: attemptIdRef.current,
        answers: answersRef.current,
        antiCheatDelta: {
          violations: violationsRef.current.length,
          tabSwitches: tabSwitchCountRef.current,
        },
      });
      const resp = await callFunction<SubmitResponse>('/submitAttempt', 'POST', {
        attemptId: attemptIdRef.current,
      });
      if (skill === 'writing') await saveWritingSubmission(resp);

      // generate local results for logging but don't show a modal — go straight to performance
      // (we still compute localCorrect to populate any server-side fallbacks if needed)
      const results = generateQuestionResults(test, answersRef.current);
      const localCorrect = results.reduce((total, result) => total + result.score, 0);
      stopMonitoring();
      // Redirect to performance page showing the specific attempt when available
      const preferredId = (resp && (resp as any).attemptId) || attemptIdRef.current || test.id;
      const target = `/student/performance?reviewTestId=${encodeURIComponent(preferredId)}`;
      try {
        console.log('[take-test] navigating to performance via router.replace', target);
        router.replace(target);
      } catch (navErr) {
        console.warn('[take-test] router.replace failed, falling back to location.href', navErr);
        // fallback to full navigation
        window.location.href = target;
      }

      // Mark finished so monitoring/overlays are disabled permanently
      setIsFinished(true);
      isFinishedRef.current = true;
      // Ensure pause/fullscreen states are cleared so overlays won't show after submit
      setIsPaused(false);
      isPausedRef.current = false;
      setIsFullscreenPaused(false);
      isFullscreenPausedRef.current = false;
      setIsStarted(false);
      isStartedRef.current = false;

      // As a secondary safety-net: if router.replace doesn't navigate (some runtime edge),
      // force a full navigation after a brief delay so the modal cannot persist.
      setTimeout(() => {
        try {
          if (typeof window !== 'undefined' && window.location.pathname.includes('/student/take-test')) {
            console.log('[take-test] fallback: forcing full navigation to', target);
            window.location.href = target;
          }
        } catch (err) {
          /* ignore */
        }
      }, 600);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to submit test.');
      startTimer(remainingRef.current);
    } finally {
      setIsSubmitting(false);
    }
  }

  const renderQuestionInput = (
    qt: TestQuestionType,
    question: TestQuestion,
    qNum: number,
    group?: { start: number; end: number; requiredCount: number },
  ) => {
    const type = String(qt.type || '').toLowerCase();
    const title = group
      ? `Question ${group.start}-${group.end}. ${question.question || 'Choose the correct answer'}`
      : `Question ${qNum}. ${question.question || ''}`;

    const displayValue = (value: string | undefined) => {
      if (value === undefined || value === null) return '';
      return String(value).trim().length === 0 ? '' : value;
    };

    const getTypeSpecificList = () => {
      if (type.includes('matching headings')) return splitList(qt.headingsList || qt.headings || []);
      if (type.includes('matching features') || type.includes('matching information') || type.includes('matching (info/features/sentence halves)') || type.includes('pick from a list')) {
        return splitList(qt.featuresList || qt.features || qt.options || question.options || []);
      }
      if (type.includes('matching sentence endings')) return splitList(qt.endingsList || qt.options || question.options || []);
      if (type.includes('diagram') || type.includes('flow-chart') || type.includes('table') || type.includes('note completion') || type.includes('form') || type.includes('summary completion')) {
        return splitList(qt.wordBank || question.wordBank || qt.options || question.options || []);
      }
      return [] as string[];
    };

    const parseWordBankOptions = () => {
      const sources: unknown[] = [qt.wordBank, question.wordBank, question.options];
      for (const source of sources) {
        const options = splitList(source);
        if (options.length > 0) return options;
      }
      return [] as string[];
    };

    const parseLetterOptions = (source: unknown, fallbackCount = 12) => {
      const parsed = splitList(source);
      if (parsed.length > 0) {
        return parsed.map((option) => {
          const match = String(option).match(/^([A-Z])\.\s*(.*)$/i);
          return match
            ? { value: match[1].toUpperCase(), label: `${match[1].toUpperCase()}. ${match[2] || ''}`.trim() }
            : { value: option, label: option };
        }).filter((option) => option.value && option.label);
      }

      return Array.from({ length: fallbackCount }, (_, index) => {
        const value = toLetter(index);
        return { value, label: value };
      });
    };

    const parseRomanOptions = (count = 7) => {
      // Generate roman numerals dynamically based on requested count.
      // For values beyond the supported roman map, fall back to numeric string.
      const toRoman = (num: number) => {
        if (num <= 0) return String(num);
        const map: [number, string][] = [
          [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
          [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
          [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
        ];
        let n = num;
        let res = '';
        for (const [val, sym] of map) {
          while (n >= val) {
            res += sym;
            n -= val;
          }
        }
        return res || String(num);
      };

      return Array.from({ length: count }, (_, index) => {
        const roman = toRoman(index + 1);
        const value = roman || String(index + 1);
        return { value, label: value };
      });
    };

    if (group) {
      const selected = splitAnswerTokens(answers[`${group.start}-${group.end}`]);
      const options = getOptions(qt.options || question.options, 4);
      return (
        <div className="tt-question-card" key={`group-${group.start}`}>
          <h4>{title}</h4>
          <p className="tt-question-hint">Select {group.requiredCount}</p>
          <div className="tt-options">
            {options.map((option, index) => {
              const letter = toLetter(index);
              const checked = selected.includes(letter);
              return (
                <label key={letter} className="tt-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && selected.length >= group.requiredCount}
                    onChange={(event) => setMultipleAnswer(group.start, group.requiredCount, letter, event.target.checked)}
                  />
                  <span>{letter}</span>
                  <strong>{option}</strong>
                </label>
              );
            })}
          </div>
          <div className="tt-selection-count">Selected: {selected.length}/{group.requiredCount}</div>
        </div>
      );
    }

    if (type.includes('matching headings')) {
      const headings = splitList(qt.headingsList || qt.headings || []);
      const dropdownOptions = parseRomanOptions(qt.headingCount || headings.length || 7);

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          <select
            value={answers[qNum] || ''}
            onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
            style={{
              padding: '0.5rem',
              minWidth: '100px',
              border: '2px solid #cbd5e1',
              borderRadius: '8px',
              fontSize: '1rem',
            }}
          >
            <option value="">Select...</option>
            {dropdownOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (type.includes('matching features') || type.includes('matching information') || type.includes('matching (info/features/sentence halves)') || type.includes('pick from a list')) {
      const featureCount = getTypeSpecificList().length;
      const options = parseLetterOptions(qt.options || question.options, featureCount || qt.customOptionsCount || 12);

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          <select
            value={answers[qNum] || ''}
            onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
            style={{
              padding: '0.5rem',
              minWidth: '100px',
              border: '2px solid #cbd5e1',
              borderRadius: '8px',
              fontSize: '1rem',
            }}
          >
            <option value="">Select...</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (type.includes('matching sentence endings')) {
      const endings = splitList(qt.endingsList || qt.options || question.options || []);
      const options = endings.length > 0
        ? endings.map((ending, index) => {
            const match = String(ending).match(/^([A-Z])\.\s*(.*)$/i);
            if (match) return { value: match[1].toUpperCase(), label: `${match[1].toUpperCase()}. ${match[2] || ''}`.trim() };
            return { value: toLetter(index), label: ending };
          })
        : parseLetterOptions([], qt.customOptionsCount || 12);

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          <select
            value={answers[qNum] || ''}
            onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
            style={{
              padding: '0.5rem',
              minWidth: '100px',
              border: '2px solid #cbd5e1',
              borderRadius: '8px',
              fontSize: '1rem',
            }}
          >
            <option value="">Select...</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    // Handle diagram/form/table completion with wordbank dropdown
    if (type.includes('diagram') || type.includes('flow-chart') || type.includes('table') || type.includes('note completion') || type.includes('form')) {
      const dropdownOptions = parseWordBankOptions();

      // If we have dropdown options, render as dropdown; otherwise, text input
      if (dropdownOptions.length > 0) {
        return (
          <div className="tt-question-card" key={qNum}>
            <h4>{title}</h4>
            <select
              value={answers[qNum] || ''}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              style={{
                padding: '0.5rem',
                minWidth: '200px',
                border: '2px solid #cbd5e1',
                borderRadius: '8px',
                fontSize: '1rem',
              }}
            >
              <option value="">Select from word bank...</option>
              {dropdownOptions.map((option, index) => (
                <option key={`${option}-${index}`} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        );
      }

      // Fallback to text input if no wordbank
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          <label className="tt-question-line wide">
            <input
              type="text"
              value={displayValue(answers[qNum])}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              placeholder="Type your answer..."
            />
          </label>
        </div>
      );
    }

    // Handle summary completion with wordbank dropdown
    if (type.includes('summary completion')) {
      const dropdownOptions = parseWordBankOptions();

      // If we have dropdown options, render as dropdown; otherwise, text input
      if (dropdownOptions.length > 0) {
        return (
          <div className="tt-question-card" key={qNum}>
            <h4>{title}</h4>
            <select
              value={answers[qNum] || ''}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              style={{
                padding: '0.5rem',
                minWidth: '200px',
                border: '2px solid #cbd5e1',
                borderRadius: '8px',
                fontSize: '1rem',
              }}
            >
              <option value="">Select from word bank...</option>
              {dropdownOptions.map((option, index) => (
                <option key={`${option}-${index}`} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        );
      }

      // Fallback to text input if no wordbank
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          <label className="tt-question-line wide">
            <input
              type="text"
              value={displayValue(answers[qNum])}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              placeholder="Type your answer..."
            />
          </label>
        </div>
      );
    }

    if (type.includes('multiple choice') || (type.includes('true') && type.includes('false')) || (type.includes('yes') && type.includes('no'))) {
      const options = type.includes('true') && type.includes('false')
        ? ['True', 'False', 'Not Given']
        : type.includes('yes') && type.includes('no')
          ? ['Yes', 'No', 'Not Given']
          : getOptions(question.options, 4);

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          <div className="tt-options">
            {options.map((option, index) => (
              <label key={option} className="tt-option">
                <input
                  type="radio"
                  name={`q${qNum}`}
                  value={option}
                  checked={answers[qNum] === option}
                  onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
                />
                <span>{toLetter(index)}</span>
                <strong>{option}</strong>
              </label>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="tt-question-card" key={qNum}>
        <h4>{title}</h4>
        <label className="tt-question-line wide">
          <input
            type="text"
            value={displayValue(answers[qNum])}
            onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
            placeholder="Type your answer..."
          />
        </label>
      </div>
    );
  };

  const questionBlocks = useMemo(() => {
    if (!test || !test.metadata?.parts) return null;

    let currentNumber = 1;

    return (
      <section>
        {test.metadata.parts.map((part, partIndex) => {
          const questionTypes = part.questionTypes || [];

          return (
            <div key={`part-${partIndex}`} className="tt-section">
              <h3>{part.name || `Part ${partIndex + 1}`}</h3>
              {questionTypes.map((qt, qtIndex) => {
                const type = String(qt.type || '').toLowerCase();
                const images = getQuestionTypeImages(qt);
                const questions = qt.questions || [];
                const count = qt.questionCount || questions.length || 0;
                const preludeItems = type.includes('matching headings')
                  ? splitList(qt.headingsList || qt.headings || [])
                  : type.includes('matching features') || type.includes('matching information') || type.includes('matching (info/features/sentence halves)') || type.includes('pick from a list')
                    ? splitList(qt.featuresList || qt.features || qt.options || [])
                    : type.includes('matching sentence endings')
                      ? splitList(qt.endingsList || qt.options || [])
                      : type.includes('diagram') || type.includes('flow-chart') || type.includes('table') || type.includes('note completion') || type.includes('form') || type.includes('summary completion')
                        ? splitList(qt.wordBank || qt.options || [])
                        : [];
                const renderedQuestions = [];

                if (type.includes('multiple') && type.includes('choose multiple')) {
                  for (let index = 0; index < count; index += 1) {
                    const question = questions[index] || {};
                    const requiredCount = Number(question.choiceCount || 3);
                    const start = currentNumber;
                    const end = start + requiredCount - 1;
                    renderedQuestions.push(renderQuestionInput(qt, question, start, { start, end, requiredCount }));
                    currentNumber = end + 1;
                  }
                } else {
                  for (let index = 0; index < count; index += 1) {
                    const question = questions[index] || {};
                    const qNum = currentNumber;
                    renderedQuestions.push(renderQuestionInput(qt, question, qNum));
                    currentNumber += 1;
                  }
                }

                return (
                  <div className="tt-question-set" key={`${type}-${qtIndex}`}>
                    <div className="tt-set-header">
                      <span>{type || 'Question Set'}</span>
                      {qt.instructions && <p>{qt.instructions}</p>}
                    </div>
                    {images.length > 0 && (
                      <div className="tt-set-images">
                        {images.map((url, index) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={url} src={url} alt={`Question reference ${index + 1}`} />
                        ))}
                      </div>
                    )}
                    {preludeItems.length > 0 && (
                      <div className="tt-prelude-list">
                        {preludeItems.map((item, idx) => <div key={`${item}-${idx}`}>{item}</div>)}
                      </div>
                    )}
                    {qt.summaryText && <div className="tt-summary-text">{qt.summaryText}</div>}
                    <div className="tt-question-list">{renderedQuestions}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>
    );
  // renderQuestionInput closes over answers and answer setters by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, test]);

  const task1Words = (answers.writingTask1 || '').trim() ? (answers.writingTask1 || '').trim().split(/\s+/).length : 0;
  const task2Words = (answers.writingTask2 || '').trim() ? (answers.writingTask2 || '').trim().split(/\s+/).length : 0;

  if (isLoading) {
    return <div className="tt-loading">Loading test...</div>;
  }

  if (error || !test) {
    return (
      <div className="tt-loading">
        <div>{error || 'Test not found.'}</div>
        <button type="button" onClick={() => router.push('/student/assignments')}>Back to assignments</button>
      </div>
    );
  }

  return (
    <div className="tt-shell">
      <header className="tt-topbar">
        <div className="tt-brand"><i className="fas fa-clipboard-list" /> Take Test</div>
        <div className="tt-topbar-actions">
          <span className="tt-warning" title="Anti-cheat violations detected"><i className="fas fa-shield-halved" /> {violations.length}</span>
          <span className={`tt-timer${remainingSeconds < 300 && remainingSeconds > 0 ? ' urgent' : ''}`} aria-live="polite" aria-label={`Time remaining: ${formatSeconds(remainingSeconds)}`}><i className="fas fa-clock" /> {formatSeconds(remainingSeconds)}</span>
          <button type="button" className="tt-submit" disabled={!isStarted || isSubmitting || isFinished} onClick={openSubmitConfirm}>
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </header>

      {!isStarted && (
        <div className="tt-start-overlay">
          <div className="tt-start-modal">
            {!isMonitoringReady ? (
              <>
                <div className="tt-start-icon"><i className="fas fa-shield-alt" /></div>
                <h1>Ready to Start Test?</h1>
                <p>You are about to start <strong>{test.name || 'the test'}</strong>.</p>
                <p>Duration: <strong>{durationMinutes} minutes</strong></p>
                <div className="tt-setup-list">
                  <div><i className="fas fa-expand" /> Fullscreen is required</div>
                  <div><i className="fas fa-camera" /> Camera monitoring is required</div>
                  <div><i className="fas fa-display" /> Entire screen sharing is required</div>
                  <div><i className="fas fa-eye" /> Tab switches and exits are logged</div>
                </div>
                <div className="tt-modal-actions">
                  <button type="button" className="tt-secondary" onClick={() => router.push('/student/assignments')} disabled={isInitializing}>Cancel</button>
                  <button type="button" className="tt-primary" onClick={startTest} disabled={isInitializing}>
                    {isInitializing ? 'Setting up monitoring...' : 'Start Test'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="tt-start-icon"><i className="fas fa-check-circle" style={{ color: '#fff' }} /></div>
                <h1>Monitoring Confirmed</h1>
                <p>All monitoring systems are active and running.</p>
                <div className="tt-setup-list">
                  <div><i className="fas fa-check" style={{ color: '#10b981' }} /> Fullscreen mode: Active</div>
                  <div><i className="fas fa-check" style={{ color: '#10b981' }} /> Camera monitoring: Active</div>
                  <div><i className="fas fa-check" style={{ color: '#10b981' }} /> Screen sharing: Active</div>
                </div>
                <p style={{ marginTop: '20px', fontWeight: 'bold' }}>Click &quot;Begin Test&quot; to start the timer and begin answering questions.</p>
                <div className="tt-modal-actions">
                  <button type="button" className="tt-secondary" onClick={() => { setIsMonitoringReady(false); stopMonitoring(); }} disabled={false}>Cancel & Redo Setup</button>
                  <button type="button" className="tt-primary" onClick={beginTest} disabled={false}>Begin Test</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

        {isPaused && !isFinished && (
        <div className="tt-pause-overlay">
          <div>
            {isFullscreenPaused ? (
              <>
                <h2>Fullscreen required</h2>
                <p>You left fullscreen mode. Return to fullscreen to continue the test.</p>
                <button type="button" className="tt-primary" onClick={resumeFullscreen}>Return to fullscreen</button>
              </>
            ) : (
              <>
                <h2>Screen sharing required</h2>
                <p>To continue, re-share your entire screen.</p>
                <button type="button" className="tt-primary" onClick={resumeScreenShare}>Re-share screen</button>
              </>
            )}
          </div>
        </div>
      )}

      {isSubmitConfirmOpen && !isFinished && (
        <div className="tt-submit-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="tt-submit-confirm-title">
          <div className="tt-submit-confirm-modal">
            <h2 id="tt-submit-confirm-title">Submit your test now?</h2>
            <p>This will finalize your answers and take you to Performance.</p>
            <div className="tt-submit-confirm-actions">
              <button type="button" className="tt-secondary" onClick={() => setIsSubmitConfirmOpen(false)} disabled={isSubmitting}>
                Cancel
              </button>
              <button type="button" className="tt-primary" onClick={() => void submitTest(false)} disabled={isSubmitting}>
                Confirm Submit
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="tt-workspace">
        {!isStarted ? (
          <div className="tt-workspace-locked" aria-hidden="true">
            <div className="tt-workspace-locked-card">
              <h2>Test is preparing</h2>
              <p>Please complete setup and click Begin Test to reveal the material.</p>
            </div>
          </div>
        ) : (
          <>
            <aside className="tt-media-panel">
              {skill === 'reading' && Array.isArray(test.files?.reading) && test.files.reading.map((url, index) => (
                <MediaPreview key={`${url}-${index}`} url={url} label={`Reading Passage ${index + 1}`} />
              ))}
              {skill === 'listening' && [1, 2, 3, 4].map((part) => {
                const url = test.files?.[`listeningPart${part}`]?.[0];
                if (!url) return null;
                const status = audioPlayed[part - 1] || 'idle';
                return (
                  <div className="tt-audio-card" key={part}>
                    <h3>Audio Part {part}</h3>
                    <audio
                      id={`tt-audio-${part - 1}`}
                      preload="auto"
                      src={url}
                      onEnded={() => setAudioPlayed((current) => ({ ...current, [part - 1]: 'ended' }))}
                    />
                    <button type="button" disabled={status !== 'idle'} onClick={() => playAudio(part - 1)} aria-label={`Play audio part ${part}`}>
                      <i className="fas fa-play" /> {status === 'idle' ? 'Play' : status === 'playing' ? 'Playing...' : 'Played'}
                    </button>
                    <span>{status === 'idle' ? 'Click Play to start listening' : status === 'playing' ? 'Playing... Cannot pause or replay' : 'Audio has ended. Cannot replay.'}</span>
                  </div>
                );
              })}
              {skill === 'writing' && (
                <>
                  <div className="tt-writing-tabs">
                    <button type="button" className={activeWritingTask === 1 ? 'active' : ''} onClick={() => setActiveWritingTask(1)}>Task 1</button>
                    <button type="button" className={activeWritingTask === 2 ? 'active' : ''} onClick={() => setActiveWritingTask(2)}>Task 2</button>
                  </div>
                  {activeWritingTask === 1 && (test.files?.writingTask1?.[0] || test.files?.writingTasks?.[0]) && (
                    <MediaPreview url={(test.files?.writingTask1?.[0] || test.files?.writingTasks?.[0]) as string} label="Writing Task 1" />
                  )}
                  {activeWritingTask === 2 && (test.files?.writingTask2?.[0] || test.files?.writingTasks?.[0]) && (
                    <MediaPreview url={(test.files?.writingTask2?.[0] || test.files?.writingTasks?.[0]) as string} label="Writing Task 2" />
                  )}
                </>
              )}
            </aside>

            <section className="tt-question-panel">
              <div className="tt-test-title">
                <h2>{test.name || 'IELTS Test'}</h2>
                <span>{skill}</span>
              </div>

              {skill === 'writing' ? (
                <div className="tt-writing-answer">
                  <div className={activeWritingTask === 1 ? 'active' : ''}>
                    <h3>Writing Task 1</h3>
                    <p>Write at least 150 words.</p>
                    <textarea
                      value={answers.writingTask1 || ''}
                      onChange={(event) => {
                        updateAnswers((current) => ({ ...current, writingTask1: event.target.value }));
                        scheduleAutosave();
                      }}
                      placeholder="Write your Task 1 response here..."
                    />
                    <span>Word count: {task1Words} / 150 minimum</span>
                  </div>
                  <div className={activeWritingTask === 2 ? 'active' : ''}>
                    <h3>Writing Task 2</h3>
                    <p>Write at least 250 words.</p>
                    <textarea
                      value={answers.writingTask2 || ''}
                      onChange={(event) => {
                        updateAnswers((current) => ({ ...current, writingTask2: event.target.value }));
                        scheduleAutosave();
                      }}
                      placeholder="Write your Task 2 response here..."
                    />
                    <span>Word count: {task2Words} / 250 minimum</span>
                  </div>
                </div>
              ) : questionBlocks}
            </section>
          </>
        )}
      </main>

      <div className="tt-camera">
        <video ref={cameraVideoRef} autoPlay muted playsInline aria-label="Camera monitoring feed" />
      </div>
    </div>
  );
}
