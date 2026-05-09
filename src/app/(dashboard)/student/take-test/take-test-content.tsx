'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, getFirestore, serverTimestamp, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { firebaseApp, firebaseStorage } from '@/services/firebase';
import { calculateIELTSBand, countTotalQuestionsFromMetadata } from './take-test-utils';
import { invalidateStudentCache } from '@/services/student-dashboard';
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

type SubmitResponse = {
  ok?: boolean;
  autoScore?: number;
  ieltsBand?: number;
  correctAnswers?: number;
  totalQuestions?: number;
};

type Notification = {
  id: string;
  type: 'info' | 'warning' | 'error';
  message: string;
  dismissible?: boolean;
  actionLabel?: string;
  actionId?: string;
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
  const [mode, setMode] = useState<'direct' | 'google' | 'error'>('direct');
  const googleViewerUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`;

  return (
    <div className="tt-media-preview">
      <div className="tt-media-title">{label}</div>
      <div className="tt-media-frame">
        {isImageUrl(url) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} />
        ) : mode === 'direct' ? (
          <iframe src={url} title={label} onError={() => setMode('google')} />
        ) : mode === 'google' ? (
          <iframe src={googleViewerUrl} title={label} onError={() => setMode('error')} />
        ) : (
          <div className="tt-media-error" style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
            <h3>PDF cannot be displayed</h3>
            <p style={{ wordBreak: 'break-all' }}>{url}</p>
            <div style={{ margin: '1rem 0' }}>
              <a href={url} target="_blank" rel="noreferrer" style={{ color: '#006769', textDecoration: 'underline', margin: '0 0.5rem' }}>
                Open in new tab
              </a>
              <a href={url} download style={{ color: '#006769', textDecoration: 'underline', margin: '0 0.5rem' }}>
                Download
              </a>
            </div>
          </div>
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
  const draftIdRef = useRef<string | null>(null);
  const autoSubmitActive = useRef(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isStarted, setIsStarted] = useState(false);
  const [hasTestBegun, setHasTestBegun] = useState(false);
  const isStartedRef = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const remainingRef = useRef(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [isFullscreenPaused, setIsFullscreenPaused] = useState(false);
  const isFullscreenPausedRef = useRef(false);
  const [violations, setViolations] = useState<Array<{ type: string; description: string; timestamp: string }>>([]);
  const violationsRef = useRef<Array<{ type: string; description: string; timestamp: string }>>([]);
  const [warningCount, setWarningCount] = useState(0);
  const warningCountRef = useRef(0);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const tabSwitchCountRef = useRef(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeWritingTask, setActiveWritingTask] = useState<1 | 2>(1);
  const [audioPlayed, setAudioPlayed] = useState<Record<number, 'idle' | 'playing' | 'ended'>>({});
  const [isInitializing, setIsInitializing] = useState(false);

  const [isMonitoringReady, setIsMonitoringReady] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autosaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastTabSwitchRef = useRef(0);
  const isInitializingRef = useRef(false);

  // Anti-cheat evidence capture refs
  const evidenceUploadQueueRef = useRef<Array<() => Promise<void>>>([]);
  const lastEvidenceUploadRef = useRef(0);
  const lastHeartbeatRef = useRef(0);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const evidenceVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  // Keep refs to latest streams so interval callbacks always access current values
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const skill = normalizeSkill(test?.skill);
  const durationMinutes = useMemo(() => {
    if (!test) return 60;
    const base = normalizeSkill(test.skill) === 'listening' ? 45 : 60;
    return Number(test.metadata?.duration || base);
  }, [test]);

  const actionHandlersRef = useRef<Record<string, () => void>>({});

  const showNotification = useCallback((type: 'info' | 'warning' | 'error', message: string, dismissible: boolean = true, actionLabel?: string, onAction?: () => void) => {
    const id = `${Date.now()}-${Math.random()}`;
    let actionId: string | undefined;
    if (onAction) {
      actionId = `act-${Date.now()}-${Math.random()}`;
      actionHandlersRef.current[actionId] = onAction;
    }
    setNotifications((current) => [...current, { id, type, message, dismissible, actionLabel, actionId }]);

    // Auto-dismiss info and warning notifications after 5 seconds unless there's an action
    if (type !== 'error' && !onAction) {
      setTimeout(() => {
        setNotifications((current) => current.filter((n) => n.id !== id));
      }, 5000);
    }
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((n) => n.id !== id));
  }, []);

  const updateAnswers = useCallback((updater: (current: Answers) => Answers) => {
    setAnswers((current) => {
      const next = updater(current);
      answersRef.current = next;
      return next;
    });
  }, []);

  // scheduleAutosave must be declared BEFORE recordViolation since recordViolation calls it
  const scheduleAutosave = useCallback(() => {
    if (!draftIdRef.current) return;
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    autosaveRef.current = setTimeout(() => {
      const db = getFirestore(firebaseApp);
      void updateDoc(doc(db, 'testResults', draftIdRef.current!), {
        answers: answersRef.current,
        lastAutosaveAt: serverTimestamp(),
        antiCheat: {
          violations: violationsRef.current.length,
          tabSwitches: tabSwitchCountRef.current,
        },
      }).catch((err) => console.warn('[take-test autosave]', err));
    }, 500);
  }, []);

  const recordViolation = useCallback((type: string, description: string) => {
    const violation = { type, description, timestamp: new Date().toISOString() };
    violationsRef.current = [...violationsRef.current, violation];
    warningCountRef.current += 1;
    setViolations(violationsRef.current);
    setWarningCount(warningCountRef.current);
    scheduleAutosave();
    // Capture evidence screenshot for this violation (non-blocking)
    // Intentionally NOT in dependency array to avoid TDZ; captureAndUploadEvidence is
    // a stable function that closes over state via refs.
    try { void captureAndUploadEvidence(type); } catch { /* evidence capture is best-effort */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleAutosave]);

  // ── Anti-Cheat Evidence Capture ───────────────────────────────────
  // Capture a video frame from the camera stream as a JPEG blob and
  // upload it to Firebase Storage under /violations/{studentUid}/{testId}/

  const captureAndUploadEvidence = useCallback(
    async (type: string): Promise<void> => {
      if (!user || !test) return;
      const now = Date.now();
      const filename = `${type}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;

      const safeTest = (test.name || test.id || 'unknown_test')
        .replace(/[^a-zA-Z0-9_\-]/g, '_')
        .slice(0, 80);
      const studentFolder = user.uid;
      const storagePath = `violations/${studentFolder}/${test.id}/${filename}`;

      let blob: Blob | null = null;

      // Try camera stream first
      if (cameraStreamRef.current) {
        const video = evidenceVideoRef.current;
        if (video && video.readyState >= 2) {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            try {
              blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.75);
              });
            } catch { /* ignore */ }
          }
        }
      }

      // Fallback: try screen stream
      if (!blob && screenStreamRef.current) {
        const video = screenVideoRef.current;
        if (video && video.readyState >= 2) {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 1280;
          canvas.height = video.videoHeight || 720;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            try {
              blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.75);
              });
            } catch { /* ignore */ }
          }
        }
      }

      if (!blob) {
        console.warn('[anti-cheat] no blob captured for', type);
        return;
      }

      // Throttle: don't upload more than 1 evidence every 3 seconds
      if (now - lastEvidenceUploadRef.current < 3000) {
        return;
      }
      lastEvidenceUploadRef.current = now;

      try {
        const storageRef = ref(firebaseStorage, storagePath);
        await uploadBytes(storageRef, blob);
        console.log('[anti-cheat] evidence uploaded:', storagePath);
      } catch (err) {
        console.warn('[anti-cheat] evidence upload failed', err);
      }
    },
    [user, test],
  );

  // Periodic heartbeat: capture evidence every 60 seconds while test is active
  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    heartbeatIntervalRef.current = setInterval(async () => {
      if (!isStartedRef.current) return;
      const now = Date.now();
      if (now - lastHeartbeatRef.current < 60000) return;
      lastHeartbeatRef.current = now;
      await captureAndUploadEvidence('heartbeat');
    }, 15000); // check every 15s, but only capture if 60s has passed
  }, [captureAndUploadEvidence]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const stopMonitoring = useCallback(() => {
    stopTimer();
    stopHeartbeat();
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
          showNotification('info', 'Time is up. You can continue writing because this test allows overtime.');
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
        showNotification('warning', 'Please choose Entire screen when sharing your screen.');
        return false;
      }

      if (!displaySurface && label && !/entire screen|screen|monitor/i.test(label)) {
        stream.getTracks().forEach((item) => item.stop());
        showNotification('warning', 'Please choose Entire screen when sharing your screen.');
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
      if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
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
    setHasTestBegun(false);

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
    if (evidenceVideoRef.current && cameraStream) {
      evidenceVideoRef.current.srcObject = cameraStream;
    }
    // Keep refs in sync so interval callbacks always have current values
    cameraStreamRef.current = cameraStream;
  }, [cameraStream]);

  // Sync screenStream ref
  useEffect(() => {
    screenStreamRef.current = screenStream;
  }, [screenStream]);

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

  // ── Track-enable monitoring: detect when camera/screen tracks are muted ──
  useEffect(() => {
    if (!isStartedRef.current) return;

    const checkInterval = setInterval(() => {
      if (!isStartedRef.current) return;

      // Check camera track
      if (cameraStreamRef.current) {
        const tracks = cameraStreamRef.current.getVideoTracks();
        tracks.forEach((track) => {
          if (!track.enabled) {
            recordViolation('camera_disabled', 'Camera video track was disabled during the test');
          }
        });
      }

      // Check screen share track
      if (screenStreamRef.current) {
        const tracks = screenStreamRef.current.getVideoTracks();
        tracks.forEach((track) => {
          if (!track.enabled) {
            recordViolation('screen_share_disabled', 'Screen sharing track was disabled during the test');
          }
        });
      }
    }, 5000); // poll every 5 seconds

    return () => clearInterval(checkInterval);
  }, [recordViolation]);

  useEffect(() => () => {
    stopMonitoring();
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
  }, [stopMonitoring]);

  const setSingleAnswer = (key: string, value: string) => {
    if (isPausedRef.current) {
      showNotification('warning', 'Please re-share your entire screen before continuing.');
      return;
    }
    updateAnswers((current) => ({ ...current, [key]: value }));
    scheduleAutosave();
  };

  const trimAnswer = (key: string) => {
    const val = answers[key];
    if (val && val !== val.trim()) {
      updateAnswers((current) => ({ ...current, [key]: val.trim() }));
      scheduleAutosave();
    }
  };

  const setMultipleAnswer = (start: number, requiredCount: number, value: string, checked: boolean) => {
    if (isPausedRef.current) {
      showNotification('warning', 'Please re-share your entire screen before continuing.');
      return;
    }

    const groupId = `${start}-${start + requiredCount - 1}`;
    updateAnswers((current) => {
      const selected = new Set(splitAnswerTokens(current[groupId]));
      if (checked) selected.add(value);
      else selected.delete(value);

      const nextValues = Array.from(selected).sort();
      if (nextValues.length > requiredCount) {
        showNotification('warning', `You can only select ${requiredCount} options.`);
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
    if (isAutoSubmit) return true;
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
      showNotification('error', `Please meet the minimum word count requirements:\n\n${errors.join('\n')}`);
      return false;
    }

    return true;
  };

  const validateMultipleChoiceGroups = (): boolean => {
    // Submission should not be blocked for multiple-choice / grouped questions.
    // If answers are missing or incomplete, the student will simply lose points.
    return true;
  };

  const startTest = async () => {
    if (!test || isInitializingRef.current) return;

    isInitializingRef.current = true;
    setIsInitializing(true);

    const cameraOk = await startCamera();
    if (!cameraOk) {
      showNotification('error', 'Camera access is required to take this test.');
      isInitializingRef.current = false;
      setIsInitializing(false);
      return;
    }

    const screenOk = await startScreenShare();
    if (!screenOk) {
      showNotification('error', 'Screen sharing is required to take this test.');
      isInitializingRef.current = false;
      setIsInitializing(false);
      return;
    }

    const fullscreenOk = await requestFullscreen();
    if (!fullscreenOk) {
      showNotification('error', 'Fullscreen mode is required to take this test.');
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
      setIsMonitoringReady(false);
      beginTest();
      isInitializingRef.current = false;
      setIsInitializing(false);
    } catch (err) {
      stopMonitoring();
      isInitializingRef.current = false;
      setIsInitializing(false);
      isFullscreenPausedRef.current = false;
      setIsFullscreenPaused(false);
      showNotification('error', err instanceof Error ? err.message : 'Failed to start test. Please try again.');
    }
  };

  const beginTest = async () => {
    if (!test || !user) return;

    // Create draft document for autosave
    const db = getFirestore(firebaseApp);
    try {
      const draftRef = await addDoc(collection(db, 'testResults'), {
        testId: test.id,
        testName: test.name || 'Objective Test',
        testType: test.skill || 'reading',
        studentEmail: user.email,
        studentName: user.displayName || user.email?.split('@')[0] || 'Student',
        studentUid: user.uid,
        status: 'in_progress',
        startedAt: serverTimestamp(),
        answers: {},
        testOwnerUid: test.ownerUid || null,
      });
      draftIdRef.current = draftRef.id;
    } catch (err) {
      console.warn('[take-test] failed to create draft', err);
    }

    isStartedRef.current = true;
    setIsStarted(true);
    setHasTestBegun(true);
    startTimer(durationMinutes * 60);
    startHeartbeat(); // Begin periodic evidence heartbeat
  };

  async function submitTest(auto = false) {
    if (!test || !user || isSubmitting) return;
    if (!auto) {
      showNotification('warning', 'Submit your test now?', false, 'Submit', () => { void submitTest(true); });
      return;
    }

    if (!validateWriting(auto)) return;
    if (!validateMultipleChoiceGroups()) return;

    setIsSubmitting(true);
    stopTimer();

    const db = getFirestore(firebaseApp);

    if (skill !== 'writing') {
      // ── Objective test: auto-grade and save ──────────────────────
      const answerKey = test.answerKey || {};
      let correctCount = 0;
      const totalCount = countTotalQuestionsFromMetadata(test);

      Object.entries(answersRef.current).forEach(([key, studentAns]) => {
        if (key.startsWith('writing')) return;
        const correct = answerKey[key];
        if (!correct || !studentAns) return;
        if (key.includes('-')) {
          const tokens = Array.from(new Set(splitAnswerTokens(studentAns)));
          const acceptedList = Array.isArray(correct) ? correct : [correct];
          acceptedList.forEach((acceptedItem) => {
            const acceptedTokens = Array.from(new Set(splitAnswerTokens(acceptedItem)));
            tokens.forEach((t) => {
              if (acceptedTokens.includes(t)) correctCount += 1;
            });
          });
        } else {
          const accepted = Array.isArray(correct) ? correct : [correct];
          if (calculateSingleAnswerScore(studentAns, accepted) > 0) correctCount += 1;
        }
      });

      const band = calculateIELTSBand(correctCount, skill);

      try {
        const data = {
          status: 'completed',
          completedAt: serverTimestamp(),
          answers: answersRef.current,
          correctAnswers: correctCount,
          totalQuestions: totalCount,
          ieltsBand: band,
          timeSpent: durationMinutes * 60 - remainingRef.current,
          antiCheat: {
            violations: violationsRef.current.length,
            tabSwitches: tabSwitchCountRef.current,
          },
        };
        const docId = draftIdRef.current
          ?? (await addDoc(collection(db, 'testResults'), {
            testId: test.id,
            testName: test.name || 'Objective Test',
            testType: skill,
            studentEmail: user.email,
            studentName: user.displayName || user.email?.split('@')[0] || 'Student',
            studentUid: user.uid,
            startedAt: serverTimestamp(),
            testOwnerUid: test.ownerUid || null,
          })).id;
        await updateDoc(doc(db, 'testResults', docId), data);
        if (user?.email) invalidateStudentCache(user.email);
        sessionStorage.setItem(`needs_refresh_${user.email}`, '1');
        stopMonitoring();
        isStartedRef.current = false;
        router.push(`/student/performance?reviewTestId=${encodeURIComponent(docId)}`);
      } catch (err) {
        showNotification('error', err instanceof Error ? err.message : 'Failed to submit test.');
        startTimer(remainingRef.current);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // ── Writing: save submission ───────────────────────────────────
    try {
      const docRef = await addDoc(collection(db, 'testResults'), {
        testId: test.id,
        testName: test.name || 'Writing Test',
        testType: 'writing',
        studentEmail: user.email,
        studentName: user.displayName || user.email?.split('@')[0] || 'Student',
        studentUid: user.uid,
        status: 'pending',
        completedAt: serverTimestamp(),
        answers: {
          writingTask1: answersRef.current.writingTask1 || '',
          writingTask2: answersRef.current.writingTask2 || '',
        },
        wordCounts: {
          task1: (answersRef.current.writingTask1 || '').trim()
            ? (answersRef.current.writingTask1 || '').trim().split(/\s+/).length : 0,
          task2: (answersRef.current.writingTask2 || '').trim()
            ? (answersRef.current.writingTask2 || '').trim().split(/\s+/).length : 0,
        },
        antiCheat: {
          violations: violationsRef.current.length,
          tabSwitches: tabSwitchCountRef.current,
        },
        timeSpent: durationMinutes * 60 - remainingRef.current,
        testOwnerUid: test.ownerUid || null,
      });
      if (user?.email) invalidateStudentCache(user.email);
      sessionStorage.setItem(`needs_refresh_${user.email}`, '1');
      stopMonitoring();
      isStartedRef.current = false;
      router.push(`/student/performance?reviewTestId=${encodeURIComponent(docRef.id)}&fromSubmission=true`);
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Failed to submit test.');
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
    const imageSrc = getImageSrc(question) || getImageSrc(qt);
    const imageUrl = imageSrc ? (imageSrc.includes('?') ? `${imageSrc}&t=${Date.now()}` : `${imageSrc}?t=${Date.now()}`) : '';
    const title = group
      ? `Question ${group.start}-${group.end}. ${question.question || 'Choose the correct answer'}`
      : `Question ${qNum}. ${question.question || ''}`;
    // These types already display images at the question-set level — no need to repeat per question
    const imageAlreadyShownAtSetLevel = type.includes('diagram') || type.includes('flow-chart') || type.includes('table') || type.includes('note completion') || type.includes('summary completion') || type.includes('form');
    const questionImage = imageSrc && !imageAlreadyShownAtSetLevel ? (
      <div className="tt-question-image" style={{ margin: '.5rem 0', border: '2px solid #ddd', padding: '1rem', borderRadius: '8px', background: '#f9f9f9' }}>
        <div style={{ fontWeight: 600, marginBottom: '.5rem', color: '#006769' }}>Question Image:</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="Question image" style={{ maxWidth: '100%', height: 'auto', borderRadius: '8px', display: 'block', margin: '0 auto' }} />
      </div>
    ) : null;

    if (group) {
      const selected = splitAnswerTokens(answers[`${group.start}-${group.end}`]);
      const options = splitList(question.options);

      return (
        <div className="tt-question-card" key={`group-${group.start}`}>
          <h4>{title}</h4>
          <p className="tt-question-hint">Select {group.requiredCount}</p>
          {questionImage}
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

    if (type.includes('true') && type.includes('false') && type.includes('not given')) {
      const options = ['True', 'False', 'Not Given'];
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
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

    if (type.includes('yes') && type.includes('no') && type.includes('not given')) {
      const options = ['Yes', 'No', 'Not Given'];
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
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

    if (type.includes('sentence completion') && type.includes('summary completion')) {
      const summaryText = question.summaryText || qt.summaryText || '';
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          {summaryText && <div className="tt-summary-text">{summaryText}</div>}
          <label className="tt-question-line wide">
            <input
              type="text"
              value={answers[qNum] || ''}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              onBlur={() => trimAnswer(String(qNum))}
              placeholder="Type your answer..."
            />
          </label>
        </div>
      );
    }

    if (type.includes('multiple choice') && (type.includes('single') || !type.includes('choose multiple'))) {
      const options = getOptions(question.options, 4);
      const saveText = false;
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          <div className="tt-options">
            {options.map((option, index) => {
              const letter = toLetter(index);
              const value = saveText ? option : letter;
              return (
                <label key={option} className="tt-option">
                  <input
                    type="radio"
                    name={`q${qNum}`}
                    value={value}
                    checked={answers[qNum] === value}
                    onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
                  />
                  <span>{letter}</span>
                  <strong>{option}</strong>
                </label>
              );
            })}
          </div>
        </div>
      );
    }

    if (type.includes('matching headings')) {
      const paragraphLetter = question.paragraphLetter || (() => {
        const lastDigit = qNum % 10;
        let questionIndex = lastDigit - 3;
        if (questionIndex < 1) questionIndex = 1;
        return String.fromCharCode(64 + questionIndex);
      })();
      const headingCount = qt.headingCount || qt.customOptionsCount || 7;
      const romanNumerals = Array.from({ length: headingCount }, (_, index) => ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv'][index] || String(index + 1));

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{`Question ${qNum}. Paragraph ${paragraphLetter}`}</h4>
          {questionImage}
          <label className="tt-question-line wide">
            <select value={answers[qNum] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)} style={{ padding: '0.5rem', width: '100px', border: '2px solid var(--gray-300)', borderRadius: '8px' }}>
              <option value="">Select...</option>
              {romanNumerals.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        </div>
      );
    }

    if (type.includes('matching information') || type.includes('matching features') || type.includes('matching (info/features/sentence halves)') || type.includes('pick from a list')) {
      const options = getOptions(question.options || qt.options || qt.featuresList || qt.features, qt.customOptionsCount || 12);
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          <label className="tt-question-line wide">
            <select value={answers[qNum] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)} style={{ padding: '0.5rem', width: '100px', border: '2px solid var(--gray-300)', borderRadius: '8px' }}>
              <option value="">Select...</option>
              {options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        </div>
      );
    }

    if (type.includes('matching sentence endings')) {
      const rawOptions = splitList(question.options || qt.endingsList || qt.options || []);
      const parsedEndings = rawOptions
        .map((line) => {
          const match = line.match(/^([A-Z])\.?\s*(.*)$/i);
          if (match) return { letter: match[1].toUpperCase(), text: match[2] || line };
          return null;
        })
        .filter((item): item is { letter: string; text: string } => item !== null);

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          <label className="tt-question-line wide">
            <select value={answers[qNum] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)} style={{ padding: '0.5rem', width: '100px', border: '2px solid var(--gray-300)', borderRadius: '8px' }}>
              <option value="">Select...</option>
              {parsedEndings.length > 0
                ? parsedEndings.map((ending) => (
                  <option key={ending.letter} value={ending.letter}>{ending.letter}. {ending.text}</option>
                ))
                : getOptions(question.options || qt.options || [], qt.customOptionsCount || 12).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
            </select>
          </label>
        </div>
      );
    }

    if (type.includes('summary completion')) {
      const options = splitList(question.options || question.wordBank || qt.wordBank || qt.options || []);
      if (options.length > 0) {
        return (
          <div className="tt-question-card" key={qNum}>
            <h4>{title}</h4>
            {questionImage}
            <label className="tt-question-line wide">
              <select value={answers[qNum] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)} style={{ padding: '0.5rem', width: '260px', border: '2px solid var(--gray-300)', borderRadius: '8px' }}>
                <option value="">Select from word bank...</option>
                {options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>
        );
      }
    }

    if ((type.includes('completion') || type.includes('fill in the blanks')) && !type.includes('summary completion')) {
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          <label className="tt-question-line wide">
            <input
              type="text"
              value={answers[qNum] || ''}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              onBlur={() => trimAnswer(String(qNum))}
              placeholder="Enter your answer"
            />
          </label>
        </div>
      );
    }

    if (type.includes('sentence completion')) {
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          <label className="tt-question-line wide">
            <input
              type="text"
              value={answers[qNum] || ''}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              onBlur={() => trimAnswer(String(qNum))}
              placeholder="Your answer"
            />
          </label>
        </div>
      );
    }

    if (type.includes('diagram') || type.includes('flow-chart') || type.includes('table') || type.includes('note completion') || type.includes('form') || type.includes('map')) {
      const options = splitList(question.options || question.wordBank || qt.wordBank || qt.options || []);
      if (options.length > 0) {
        return (
          <div className="tt-question-card" key={qNum}>
            <h4>{title}</h4>
            {questionImage}
            <label className="tt-question-line wide">
              <select value={answers[qNum] || ''} onChange={(event) => setSingleAnswer(String(qNum), event.target.value)} style={{ padding: '0.5rem', width: '260px', border: '2px solid var(--gray-300)', borderRadius: '8px' }}>
                <option value="">Select from word bank...</option>
                {options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>
        );
      }

      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          <label className="tt-question-line wide">
            <input
              type="text"
              value={answers[qNum] || ''}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              onBlur={() => trimAnswer(String(qNum))}
              placeholder="Your answer"
            />
          </label>
        </div>
      );
    }

    if (type.includes('short answer')) {
      return (
        <div className="tt-question-card" key={qNum}>
          <h4>{title}</h4>
          {questionImage}
          <label className="tt-question-line wide">
            <input
              type="text"
              value={answers[qNum] || ''}
              onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
              onBlur={() => trimAnswer(String(qNum))}
              placeholder="Your answer"
            />
          </label>
        </div>
      );
    }

    return (
      <div className="tt-question-card" key={qNum}>
        <h4>{title}</h4>
        {questionImage}
        <label className="tt-question-line wide">
          <input
            type="text"
            value={answers[qNum] || ''}
            onChange={(event) => setSingleAnswer(String(qNum), event.target.value)}
            onBlur={() => trimAnswer(String(qNum))}
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
          <button type="button" className="tt-submit" disabled={!isStarted || isSubmitting} onClick={() => submitTest(false)}>
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </header>

      {!hasTestBegun && (
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
                <div className="tt-start-icon"><i className="fas fa-check-circle" style={{ color: '#10b981' }} /></div>
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

      {isPaused && (
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
      {/* Hidden video elements for evidence capture */}
      <video ref={evidenceVideoRef} autoPlay muted playsInline style={{ display: 'none' }} aria-hidden="true" />
      <video ref={screenVideoRef} autoPlay muted playsInline style={{ display: 'none' }} aria-hidden="true" />

      {/* Notification toasts — always visible above everything */}
      <div className="tt-notifications" aria-live="polite" style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999 }}>
        {notifications.map((n) => (
          <div key={n.id} className={`tt-notice tt-notice-${n.type}`} style={{ background: n.type === 'error' ? '#fee2e2' : n.type === 'warning' ? '#fff7ed' : '#ecfeff', color: '#071e26', border: '1px solid #e6e6e6', padding: '0.75rem 1rem', borderRadius: 8, marginBottom: '.5rem', minWidth: 280 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '.95rem' }}>{n.message}</div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {n.actionLabel && n.actionId && (
                  <button type="button" onClick={() => { const h = actionHandlersRef.current[n.actionId || '']; if (h) h(); dismissNotification(n.id); }} style={{ background: '#006769', color: '#fff', border: 'none', padding: '0.4rem 0.6rem', borderRadius: 6, cursor: 'pointer' }}>{n.actionLabel}</button>
                )}
                {n.dismissible !== false && (
                  <button type="button" onClick={() => dismissNotification(n.id)} style={{ marginLeft: '0.75rem', background: 'transparent', border: 'none', cursor: 'pointer' }} aria-label="Dismiss notification">✕</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
