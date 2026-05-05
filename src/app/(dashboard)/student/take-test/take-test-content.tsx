'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, getFirestore, serverTimestamp } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import './take-test.css';

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

function formatSeconds(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeSkill(value: unknown): Skill {
  const skill = String(value || '').toLowerCase();
  if (skill.includes('listening')) return 'listening';
  if (skill.includes('reading')) return 'reading';
  if (skill.includes('writing')) return 'writing';
  return skill || 'reading';
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n|[,;|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitAnswerTokens(value: unknown): string[] {
  return String(value || '')
    .split(/[,\s;/]+/)
    .map((choice) => choice.trim().toUpperCase())
    .filter(Boolean);
}

function toLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function getImageSrc(source: TestQuestionType | TestQuestion | undefined): string | null {
  if (!source) return null;
  if ('imageData' in source && source.imageData?.src) return source.imageData.src;
  if ('image' in source && source.image) return source.image;
  return null;
}

function getQuestionTypeImages(qt: TestQuestionType): string[] {
  const urls = [getImageSrc(qt), ...(qt.questions || []).map((question) => getImageSrc(question))]
    .filter((url): url is string => Boolean(url));
  return Array.from(new Set(urls));
}

function getOptions(value: unknown, fallbackCount = 12): string[] {
  const parsed = splitList(value);
  if (parsed.length > 0) return parsed;
  return Array.from({ length: fallbackCount }, (_, index) => toLetter(index));
}

function calculateSingleAnswerScore(userAnswer: unknown, accepted: unknown[]): number {
  if (!String(userAnswer || '').trim()) return 0;

  const userStr = String(userAnswer).trim();
  const userLower = userStr.toLowerCase();

  const isCorrect = accepted.some((item) => {
    const acceptedStr = String(item).trim();
    if (acceptedStr.toLowerCase() === userLower) return true;

    if (acceptedStr.includes('/')) {
      return acceptedStr.split('/').map((option) => option.trim().toLowerCase()).includes(userLower);
    }

    if (acceptedStr.includes(',') || acceptedStr.includes(';')) {
      return acceptedStr.split(/[,;]/).map((option) => option.trim().toLowerCase()).includes(userLower);
    }

    return false;
  });

  return isCorrect ? 1 : 0;
}

function calculateMultipleChoiceScore(userAnswer: unknown, accepted: unknown[]): number {
  const studentChoices = Array.from(new Set(splitAnswerTokens(userAnswer)));
  const acceptedChoices = accepted.flatMap((item) => splitAnswerTokens(item));

  let correctChoices = 0;
  studentChoices.forEach((choice) => {
    if (acceptedChoices.includes(choice)) correctChoices += 1;
  });

  return Math.min(correctChoices, acceptedChoices.length);
}

function calculateScore(userAnswer: unknown, accepted: unknown[]): number {
  if (!String(userAnswer || '').trim()) return 0;

  const isMultipleChoice = accepted.some((item) => {
    const answer = String(item);
    return answer.includes(',') ||
      answer.includes(';') ||
      answer.includes('/') ||
      answer.includes(' ') ||
      (answer.length > 1 && /^[A-Z\s,;/]+$/i.test(answer));
  });

  return isMultipleChoice
    ? calculateMultipleChoiceScore(userAnswer, accepted)
    : calculateSingleAnswerScore(userAnswer, accepted);
}

function calculateIELTSBand(correctAnswers: number, skill: Skill): number {
  const scoreMap: Record<number, number> = {
    39: 9.0, 40: 9.0,
    37: 8.5, 38: 8.5,
    35: 8.0, 36: 8.0,
    33: 7.5, 34: 7.5,
    30: 7.0, 31: 7.0, 32: 7.0,
    27: 6.5, 28: 6.5, 29: 6.5,
    23: 6.0, 24: 6.0, 25: 6.0, 26: 6.0,
    20: 5.5, 21: 5.5, 22: 5.5,
    16: 5.0, 17: 5.0, 18: 5.0, 19: 5.0,
    13: 4.5, 14: 4.5, 15: 4.5,
    10: 4.0, 11: 4.0, 12: 4.0,
    7: 3.5, 8: 3.5, 9: 3.5,
    5: 3.0, 6: 3.0,
    3: 2.5, 4: 2.5,
  };

  const safeSkill = normalizeSkill(skill);
  const _sameAcademicTableForReadingAndListening = safeSkill === 'reading' || safeSkill === 'listening';

  for (let answers = correctAnswers; answers >= 0; answers -= 1) {
    if (scoreMap[answers] !== undefined) return scoreMap[answers];
  }

  return 0;
}

function generateQuestionResults(test: TestData, answers: Answers): QuestionResult[] {
  if (normalizeSkill(test.skill) === 'writing') {
    const task1 = answers.writingTask1 || '';
    const task2 = answers.writingTask2 || '';
    const task1Words = task1.trim() ? task1.trim().split(/\s+/).length : 0;
    const task2Words = task2.trim() ? task2.trim().split(/\s+/).length : 0;

    return [
      {
        questionId: 'writingTask1',
        questionDisplayName: 'Writing Task 1',
        studentAnswer: task1 || 'No answer',
        correctAnswer: 'Manual grading required',
        isCorrect: task1Words >= 150,
        score: task1Words >= 150 ? 1 : 0,
        maxScore: 1,
        wordCount: task1Words,
        minRequired: 150,
      },
      {
        questionId: 'writingTask2',
        questionDisplayName: 'Writing Task 2',
        studentAnswer: task2 || 'No answer',
        correctAnswer: 'Manual grading required',
        isCorrect: task2Words >= 250,
        score: task2Words >= 250 ? 1 : 0,
        maxScore: 1,
        wordCount: task2Words,
        minRequired: 250,
      },
    ];
  }

  const answerKey = test.answerKey || {};
  const groupKeys = Object.keys(answers).filter((key) => key.includes('-'));
  const processedGroups = new Set<string>();
  const results: QuestionResult[] = [];

  Object.keys(answerKey).forEach((qid) => {
    const accepted = Array.isArray(answerKey[qid]) ? answerKey[qid] as string[] : [answerKey[qid] as string];
    const currentQid = parseInt(qid, 10);

    const shouldProcess = groupKeys.some((groupKey) => {
      const [start] = groupKey.split('-').map(Number);
      return currentQid === start;
    }) || !groupKeys.some((groupKey) => {
      const [start, end] = groupKey.split('-').map(Number);
      return currentQid >= start && currentQid <= end;
    });

    if (!shouldProcess) return;

    const isGroup = groupKeys.some((groupKey) => {
      const [start, end] = groupKey.split('-').map(Number);
      return currentQid >= start && currentQid <= end;
    });

    if (isGroup) {
      const acceptedChoices = accepted.flatMap((item) => splitAnswerTokens(item));
      const startNum = currentQid;
      const endNum = startNum + acceptedChoices.length - 1;
      const groupId = `${startNum}-${endNum}`;

      if (processedGroups.has(groupId)) return;
      processedGroups.add(groupId);

      const studentAnswer = answers[groupId] || '';
      const score = calculateScore(studentAnswer, accepted);
      results.push({
        questionId: groupId,
        questionDisplayName: `Question ${startNum}-${endNum}`,
        studentAnswer: studentAnswer || 'No answer',
        correctAnswer: String(answerKey[qid]),
        isCorrect: score >= acceptedChoices.length,
        score,
        maxScore: acceptedChoices.length,
        isMultipleChoice: true,
      });
      return;
    }

    const studentAnswer = answers[qid] || '';
    const score = calculateSingleAnswerScore(studentAnswer, accepted);
    results.push({
      questionId: qid,
      questionDisplayName: `Question ${qid}`,
      studentAnswer: studentAnswer || 'No answer',
      correctAnswer: String(answerKey[qid]),
      isCorrect: score > 0,
      score,
      maxScore: 1,
    });
  });

  return results;
}

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
      <a href={url} target="_blank" rel="noreferrer" className="tt-open-link">Open in new tab</a>
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
  const [violations, setViolations] = useState<Array<{ type: string; description: string; timestamp: string }>>([]);
  const violationsRef = useRef<Array<{ type: string; description: string; timestamp: string }>>([]);
  const [warningCount, setWarningCount] = useState(0);
  const warningCountRef = useRef(0);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const tabSwitchCountRef = useRef(0);
  const [submitResponse, setSubmitResponse] = useState<SubmitResponse | null>(null);
  const [questionResults, setQuestionResults] = useState<QuestionResult[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeWritingTask, setActiveWritingTask] = useState<1 | 2>(1);
  const [audioPlayed, setAudioPlayed] = useState<Record<number, 'idle' | 'playing' | 'ended'>>({});

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autosaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastTabSwitchRef = useRef(0);

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
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [recordViolation]);

  useEffect(() => () => {
    stopMonitoring();
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
  }, [stopMonitoring]);

  const setSingleAnswer = (key: string, value: string) => {
    if (isPausedRef.current) {
      alert('Please re-share your entire screen before continuing.');
      return;
    }
    updateAnswers((current) => ({ ...current, [key]: value.trim() }));
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

  const validateWriting = (): boolean => {
    if (!test || skill !== 'writing') return true;
    if (test.writingRule === 'auto-submit') return true;

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

  const startTest = async () => {
    if (!test) return;

    const cameraOk = await startCamera();
    if (!cameraOk) {
      alert('Camera access is required to take this test.');
      return;
    }

    const screenOk = await startScreenShare();
    if (!screenOk) {
      alert('Screen sharing is required to take this test.');
      return;
    }

    const fullscreenOk = await requestFullscreen();
    if (!fullscreenOk) {
      alert('Fullscreen mode is required to take this test.');
      return;
    }

    try {
      const response = await callFunction<{ attemptId: string }>('/startAttempt', 'POST', {
        examId: null,
        testId: test.id,
      });
      attemptIdRef.current = response.attemptId;
      setAttemptId(response.attemptId);
      isStartedRef.current = true;
      setIsStarted(true);
      startTimer(durationMinutes * 60);
    } catch (err) {
      stopMonitoring();
      alert(err instanceof Error ? err.message : 'Failed to start test. Please try again.');
    }
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
    if (!auto && !confirm('Submit your test now?')) return;
    if (!validateWriting()) return;

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

      const results = generateQuestionResults(test, answersRef.current);
      const localCorrect = results.reduce((total, result) => total + result.score, 0);
      setQuestionResults(results);
      setSubmitResponse({
        ...resp,
        correctAnswers: resp.correctAnswers ?? localCorrect,
        totalQuestions: resp.totalQuestions ?? 40,
        ieltsBand: resp.ieltsBand ?? calculateIELTSBand(localCorrect, skill),
      });
      stopMonitoring();
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

    if (group) {
      const selected = splitAnswerTokens(answers[`${group.start}-${group.end}`]);
      const options = getOptions(question.options, 4);
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

    if (type.includes('multiple choice') || (type.includes('true') && type.includes('false')) || (type.includes('yes') && type.includes('no'))) {
      const options = type.includes('true') && type.includes('false')
        ? ['True', 'False', 'Not Given']
        : type.includes('yes') && type.includes('no')
          ? ['Yes', 'No', 'Not Given']
          : getOptions(question.options, 4);
      const savesText = (type.includes('true') && type.includes('false')) || (type.includes('yes') && type.includes('no'));

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          <div className="tt-options">
            {options.map((option, index) => {
              const value = savesText ? option : toLetter(index);
              return (
                <label key={`${qNum}-${value}`} className="tt-option">
                  <input
                    type="radio"
                    name={`q-${qNum}`}
                    checked={answers[String(qNum)] === value}
                    onChange={() => setSingleAnswer(String(qNum), value)}
                  />
                  <span>{toLetter(index)}</span>
                  <strong>{option}</strong>
                </label>
              );
            })}
          </div>
        </div>
      );
    }

    if (type.includes('matching headings')) {
      const count = qt.headingCount || qt.customOptionsCount || splitList(qt.headingsList || qt.headings).length || 7;
      const numerals = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv'].slice(0, count);
      return (
        <div className="tt-question-line" key={qNum}>
          <label>{qNum}. Paragraph {question.paragraphLetter || toLetter(qNum - 1)}</label>
          <select value={answers[String(qNum)] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}>
            <option value="">Select...</option>
            {numerals.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
      );
    }

    if (type.includes('matching') || type.includes('pick from a list')) {
      const source = qt.endingsList || qt.options || question.options || qt.featuresList;
      const options = getOptions(source, qt.customOptionsCount || 12);
      return (
        <div className="tt-question-line" key={qNum}>
          <label>{qNum}. {question.question || ''}</label>
          <select value={answers[String(qNum)] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}>
            <option value="">Select...</option>
            {options.map((option, index) => {
              const match = option.match(/^([A-Za-z])\.?\s*(.*)$/);
              const value = match?.[1]?.toUpperCase() || option;
              return <option key={`${value}-${index}`} value={value}>{option}</option>;
            })}
          </select>
        </div>
      );
    }

    const wordBank = getOptions(question.options || question.wordBank || qt.wordBank, 0);
    if (wordBank.length > 0) {
      return (
        <div className="tt-question-line wide" key={qNum}>
          <label>{title}</label>
          <select value={answers[String(qNum)] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}>
            <option value="">Select from word bank...</option>
            {wordBank.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
      );
    }

    return (
      <div className="tt-question-line wide" key={qNum}>
        <label>{title}</label>
        <input value={answers[String(qNum)] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)} placeholder="Your answer" />
      </div>
    );
  };

  const questionBlocks = useMemo(() => {
    if (!test || skill === 'writing') return null;
    let currentNumber = 1;

    return (test.metadata?.parts || []).map((part, partIndex) => (
      <section className="tt-section" key={`${part.name || 'part'}-${partIndex}`}>
        <h3>{part.name || `Part ${partIndex + 1}`}</h3>
        {(part.questionTypes || []).map((qt, qtIndex) => {
          const type = String(qt.type || '');
          const lowerType = type.toLowerCase();
          const questions = qt.questions || [];
          const count = Number(qt.questionCount || questions.length || 0);
          const images = getQuestionTypeImages(qt);
          const preludeItems = splitList(qt.headingsList || qt.headings || qt.featuresList || qt.features || qt.endingsList);
          const renderedQuestions = [];

          if (lowerType.includes('multiple') && lowerType.includes('choose multiple')) {
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
                  {preludeItems.map((item, index) => <div key={`${item}-${index}`}>{item}</div>)}
                </div>
              )}
              {qt.summaryText && <div className="tt-summary-text">{qt.summaryText}</div>}
              <div className="tt-question-list">{renderedQuestions}</div>
            </div>
          );
        })}
      </section>
    ));
  // renderQuestionInput closes over the current answers and answer setters by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, skill, test]);

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
          <button type="button" className="tt-submit" disabled={!isStarted || isSubmitting} onClick={() => submitTest(false)}>
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </header>

      {!isStarted && !submitResponse && (
        <div className="tt-start-overlay">
          <div className="tt-start-modal">
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
              <button type="button" className="tt-secondary" onClick={() => router.push('/student/assignments')}>Cancel</button>
              <button type="button" className="tt-primary" onClick={startTest}>Start Test</button>
            </div>
          </div>
        </div>
      )}

      {isPaused && (
        <div className="tt-pause-overlay">
          <div>
            <h2>Screen sharing required</h2>
            <p>To continue, re-share your entire screen.</p>
            <button type="button" className="tt-primary" onClick={resumeScreenShare}>Re-share screen</button>
          </div>
        </div>
      )}

      <main className="tt-workspace">
        <aside className="tt-media-panel">
          {skill === 'reading' && test.files?.reading?.[0] && <MediaPreview url={test.files.reading[0]} label="Reading Passage" />}
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
      </main>

      <div className="tt-camera">
        <video ref={cameraVideoRef} autoPlay muted playsInline aria-label="Camera monitoring feed" />
      </div>

      {submitResponse && (
        <div className="tt-results-overlay">
          <div className="tt-results-modal">
            <div className="tt-results-header">
              <h2>{skill === 'writing' ? 'Writing Submitted' : 'Test Completed'}</h2>
              <button type="button" onClick={() => router.push('/student/performance')} aria-label="Close results"><i className="fas fa-times" /></button>
            </div>
            {skill !== 'writing' ? (
              <div className="tt-result-stats">
                <div><strong>{submitResponse.correctAnswers ?? 0}/40</strong><span>Correct</span></div>
                <div><strong>{Math.round(((submitResponse.correctAnswers ?? 0) / 40) * 100)}%</strong><span>Score</span></div>
                <div><strong>{submitResponse.ieltsBand ?? 0}</strong><span>Band</span></div>
              </div>
            ) : (
              <p className="tt-writing-submitted">Your writing response has been sent for teacher grading.</p>
            )}
            <div className="tt-result-list">
              {questionResults.map((result) => (
                <div key={result.questionId} className={`tt-result-row ${result.isCorrect ? 'correct' : 'incorrect'}`}>
                  <div>
                    <strong>{result.questionDisplayName}</strong>
                    {result.isMultipleChoice && <span>{result.score}/{result.maxScore} points</span>}
                    {result.wordCount !== undefined && <span>{result.wordCount}/{result.minRequired} words</span>}
                  </div>
                  <p>Your answer: {result.studentAnswer}</p>
                  <p>Correct answer: {result.correctAnswer}</p>
                </div>
              ))}
            </div>
            <button type="button" className="tt-primary full" onClick={() => router.push('/student/performance')}>Go to performance</button>
          </div>
        </div>
      )}
    </div>
  );
}
