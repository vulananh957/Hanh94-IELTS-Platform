'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import { ref, uploadBytes } from 'firebase/storage';
import { firebaseApp, firebaseStorage } from '@/services/firebase';
import {
  calculateIELTSBand,
  countTotalQuestionsFromMetadata,
  formatSeconds,
  normalizeSkill,
  splitList,
  splitAnswerTokens,
  toLetter,
  getImageSrc,
  getQuestionTypeImages,
  getOptions,
  calculateSingleAnswerScore,
  calculateMultipleChoiceScore,
  calculateScore,
} from './take-test-utils';
import {
  buildEvidenceCapturePath,
  type EvidenceAttemptPathInput,
} from './evidence-storage';
import {
  activateScreenSharePreview,
  ensureMonitoringStreams,
  getMonitoringRecoveryStep,
  getScreenShareVerificationStatus,
  getMonitoringViolationType,
  isLiveMonitoringTrack,
  shouldHardLockMonitoringViolation,
  waitForVerifiedEntireScreenShare,
} from './monitoring-recovery';
import {
  callTestAccess as callFunction,
  TestAccessLockedError,
  clearPendingHardLock,
  getPendingHardLock,
  hardLockAttempt,
  fetchAccessibleTest,
  isProtectedTestMaterialUrl,
  rememberPendingHardLock,
} from '@/services/test-access';
import { invalidateStudentCache } from '@/services/student-dashboard';
import { ZoomableImage } from '@/components/shared/zoomable-image';
import { TestLockedPanel } from '@/components/test-access/TestLockedPanel';
import './take-test.css';
import '@/components/shared/zoomable-image.css';

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

const MAX_WARNINGS = 3;

function isImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes('image/') ||
    lower.includes('data:image/') ||
    /\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?|$)/i.test(lower) ||
    (lower.includes('firebasestorage') && lower.includes('writing'));
}

function MediaPreview({ url, label, isWriting = false }: { url: string; label: string; isWriting?: boolean }) {
  const [mode, setMode] = useState<'direct' | 'google' | 'error'>('direct');
  const canUseGoogleViewer = !isProtectedTestMaterialUrl(url);
  const googleViewerUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`;

  return (
    <div className="tt-media-preview">
      <div className="tt-media-title">{label}</div>
      <div className={`tt-media-frame ${isWriting ? 'tt-media-frame-writing' : ''}`}>
        {isImageUrl(url) && isWriting ? (
          // Use zoomable image for writing task images
          <ZoomableImage src={url} alt={label} maxZoom={5} minZoom={1} />
        ) : isImageUrl(url) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} />
        ) : mode === 'direct' ? (
          <iframe src={url} title={label} onError={() => setMode(canUseGoogleViewer ? 'google' : 'error')} />
        ) : mode === 'google' ? (
          <iframe src={googleViewerUrl} title={label} onError={() => setMode('error')} />
        ) : (
          <div className="tt-media-error" style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
            <h3>PDF cannot be displayed</h3>
            <p>Please refresh the test or ask your teacher for help.</p>
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
  const startRequestIdRef = useRef<string | null>(null);
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
  const [isFullscreenActive, setIsFullscreenActive] = useState(false);
  const [violations, setViolations] = useState<Array<{ type: string; description: string; timestamp: string }>>([]);
  const violationsRef = useRef<Array<{ type: string; description: string; timestamp: string }>>([]);
  const [warningCount, setWarningCount] = useState(0);
  const warningCountRef = useRef(0);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const tabSwitchCountRef = useRef(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [isHardLocked, setIsHardLocked] = useState(false);
  const hardLockRef = useRef(false);
  const monitoringCleanupRef = useRef(false);
  const [activeWritingTask, setActiveWritingTask] = useState<1 | 2>(1);
  const [audioPlayed, setAudioPlayed] = useState<Record<number, 'idle' | 'playing' | 'ended'>>({});
  const [listeningUnlockedPart, setListeningUnlockedPart] = useState(1);
  const [listeningWaitingPart, setListeningWaitingPart] = useState<number | null>(null);
  const [listeningGapRemaining, setListeningGapRemaining] = useState(0);
  const [isInitializing, setIsInitializing] = useState(false);
  const [cameraPosition, setCameraPosition] = useState({ x: 0, y: 0 });
  const [isDraggingCamera, setIsDraggingCamera] = useState(false);
  const cameraDragStartRef = useRef({ x: 0, y: 0, clientX: 0, clientY: 0 });

  const [isMonitoringReady, setIsMonitoringReady] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autosaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listeningGapTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listeningGapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraElementRef = useRef<HTMLDivElement | null>(null);
  const lastTabSwitchRef = useRef(0);
  const isInitializingRef = useRef(false);

  // Anti-cheat evidence capture refs
  const lastHeartbeatRef = useRef(0);
  const lastScreenFrameCaptureRef = useRef(0);
  const lastLiveScreenFrameRef = useRef<{ blob: Blob; capturedAt: string } | null>(null);
  const evidenceAttemptRef = useRef<EvidenceAttemptPathInput | null>(null);
  const evidenceSequenceRef = useRef(0);
  const cameraRequirementLostRef = useRef(false);
  const screenRequirementLostRef = useRef(false);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  // Keep refs to latest streams so interval callbacks always access current values
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const pendingScreenStreamRef = useRef<MediaStream | null>(null);
  const screenSetupMessageRef = useRef<string | null>(null);

  const skill = normalizeSkill(test?.skill);
  const durationMinutes = useMemo(() => {
    if (!test) return 60;
    const base = normalizeSkill(test.skill) === 'listening' ? 35 : 60;
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
    if (!draftIdRef.current || !attemptIdRef.current || hardLockRef.current) return;
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    autosaveRef.current = setTimeout(() => {
      if (hardLockRef.current || !attemptIdRef.current || !testId) return;
      void callFunction('/saveAnswers', 'POST', {
        testId,
        attemptId: attemptIdRef.current,
        answers: answersRef.current,
        antiCheat: {
          violations: violationsRef.current.length,
          tabSwitches: tabSwitchCountRef.current,
        },
      }).catch((err) => console.warn('[take-test autosave]', err));
    }, 500);
  }, [testId]);

  const setWritingAnswer = useCallback((key: 'writingTask1' | 'writingTask2', value: string) => {
    if (hardLockRef.current || isPausedRef.current) return;
    updateAnswers((current) => ({ ...current, [key]: value }));
    scheduleAutosave();
  }, [scheduleAutosave, updateAnswers]);

  // ── Monitoring evidence ──────────────────────────────────────────
  // Evidence is always an Entire-screen frame. Webcam video is required for
  // monitoring, but it is never used as evidence.
  const captureLiveScreenFrame = useCallback(async (): Promise<{ blob: Blob; capturedAt: string } | null> => {
    const [track] = screenStreamRef.current?.getVideoTracks() || [];
    const video = screenVideoRef.current;
    if (!track || track.readyState !== 'live' || !track.enabled || track.muted || !video || video.readyState < 2) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((image) => resolve(image), 'image/jpeg', 0.75);
    }).catch(() => null);

    return blob ? { blob, capturedAt: new Date().toISOString() } : null;
  }, []);

  const refreshLastLiveScreenFrame = useCallback(async () => {
    const now = Date.now();
    if (now - lastScreenFrameCaptureRef.current < 15000) return;
    lastScreenFrameCaptureRef.current = now;
    const frame = await captureLiveScreenFrame();
    if (frame) lastLiveScreenFrameRef.current = frame;
  }, [captureLiveScreenFrame]);

  const captureAndUploadEvidence = useCallback(async (type: string): Promise<void> => {
    const attempt = evidenceAttemptRef.current;
    if (!attempt) return;

    const eventAt = new Date().toISOString();
    const liveFrame = await captureLiveScreenFrame();
    const frame = liveFrame || lastLiveScreenFrameRef.current;
    if (!frame) {
      console.warn('[monitoring-evidence] no valid screen frame available for', type);
      return;
    }

    if (liveFrame) lastLiveScreenFrameRef.current = liveFrame;

    const storagePath = buildEvidenceCapturePath({
      ...attempt,
      eventAt,
      sequence: ++evidenceSequenceRef.current,
      trigger: type,
      lastLiveAt: liveFrame ? undefined : frame.capturedAt,
    });

    for (let uploadAttempt = 1; uploadAttempt <= 3; uploadAttempt += 1) {
      try {
        await uploadBytes(ref(firebaseStorage, storagePath), frame.blob, { contentType: 'image/jpeg' });
        console.log('[monitoring-evidence] uploaded:', storagePath);
        return;
      } catch (err) {
        if (uploadAttempt === 3) {
          console.warn('[monitoring-evidence] upload failed after retries', err);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, uploadAttempt * 500));
      }
    }
  }, [captureLiveScreenFrame]);

  const recordViolation = useCallback((type: string, description: string) => {
    const violation = { type, description, timestamp: new Date().toISOString() };
    violationsRef.current = [...violationsRef.current, violation];
    warningCountRef.current += 1;
    setViolations(violationsRef.current);
    setWarningCount(warningCountRef.current);
    scheduleAutosave();
    void captureAndUploadEvidence(type);
  }, [captureAndUploadEvidence, scheduleAutosave]);

  // Persist one periodic screen frame per minute, while refreshing the
  // in-memory frame every 15 seconds for a meaningful last-live capture.
  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    const renewMonitoringLease = () => {
      const attemptId = attemptIdRef.current;
      const [screenTrack] = screenStreamRef.current?.getVideoTracks() || [];
      if (!isStartedRef.current || !attemptId || !testId || !isLiveMonitoringTrack(screenTrack)) return;
      void callFunction('/monitorAttempt', 'POST', { testId, attemptId })
        .catch((error) => console.warn('[take-test monitoring lease]', error));
    };
    void refreshLastLiveScreenFrame();
    renewMonitoringLease();
    heartbeatIntervalRef.current = setInterval(() => {
      if (!isStartedRef.current) return;
      renewMonitoringLease();
      void refreshLastLiveScreenFrame();
      const now = Date.now();
      if (now - lastHeartbeatRef.current < 60000) return;
      lastHeartbeatRef.current = now;
      void captureAndUploadEvidence('heartbeat');
    }, 5000);
  }, [captureAndUploadEvidence, refreshLastLiveScreenFrame, testId]);

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

  const pauseForMonitoringViolation = useCallback((type: string, description: string) => {
    if (!isStartedRef.current) return;
    isPausedRef.current = true;
    setIsPaused(true);
    recordViolation(type, description);
    stopTimer();
  }, [recordViolation, stopTimer]);

  const clearListeningGapTimers = useCallback(() => {
    if (listeningGapTimerRef.current) clearInterval(listeningGapTimerRef.current);
    if (listeningGapTimeoutRef.current) clearTimeout(listeningGapTimeoutRef.current);
    listeningGapTimerRef.current = null;
    listeningGapTimeoutRef.current = null;
  }, []);

  const triggerHardLock = useCallback((type: string, description: string) => {
    const attemptId = attemptIdRef.current;
    if (!user || !attemptId || !shouldHardLockMonitoringViolation({
      violation: type,
      attemptActive: isStartedRef.current,
      submitting: isSubmittingRef.current,
      monitoringCleanup: monitoringCleanupRef.current,
    })) return false;
    if (hardLockRef.current) return true;

    hardLockRef.current = true;
    setIsHardLocked(true);
    isPausedRef.current = true;
    setIsPaused(false);
    stopTimer();
    stopHeartbeat();
    clearListeningGapTimers();
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    recordViolation(type, description);
    isStartedRef.current = false;
    setIsStarted(false);

    const incident = {
      testId,
      attemptId,
      studentUid: user.uid,
      reason: 'screen_sharing_stopped' as const,
    };
    rememberPendingHardLock(incident);
    void hardLockAttempt(incident)
      .then(() => clearPendingHardLock(testId, user.uid))
      .catch((err) => console.warn('[take-test hard-lock] backend retry pending', err));
    return true;
  }, [clearListeningGapTimers, recordViolation, stopHeartbeat, stopTimer, testId, user]);

  const handleCameraMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // Only left mouse button
    setIsDraggingCamera(true);
    cameraDragStartRef.current = {
      x: cameraPosition.x,
      y: cameraPosition.y,
      clientX: e.clientX,
      clientY: e.clientY,
    };
  }, [cameraPosition]);

  const handleCameraMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingCamera) return;
    const start = cameraDragStartRef.current;
    const deltaX = e.clientX - start.clientX;
    const deltaY = e.clientY - start.clientY;
    setCameraPosition({
      x: start.x + deltaX,
      y: start.y + deltaY,
    });
  }, [isDraggingCamera]);

  const handleCameraMouseUp = useCallback(() => {
    setIsDraggingCamera(false);
  }, []);

  useEffect(() => {
    if (!isDraggingCamera) return;
    document.addEventListener('mousemove', handleCameraMouseMove);
    document.addEventListener('mouseup', handleCameraMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleCameraMouseMove);
      document.removeEventListener('mouseup', handleCameraMouseUp);
    };
  }, [isDraggingCamera, handleCameraMouseMove, handleCameraMouseUp]);

  const stopMonitoring = useCallback(() => {
    monitoringCleanupRef.current = true;
    stopTimer();
    stopHeartbeat();
    isStartedRef.current = false;
    setIsStarted(false);
    lastLiveScreenFrameRef.current = null;
    evidenceAttemptRef.current = null;
    setIsMonitoringReady(false);
    setIsFullscreenActive(false);
    cameraRequirementLostRef.current = false;
    screenRequirementLostRef.current = false;
    isPausedRef.current = false;
    setIsPaused(false);

    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    pendingScreenStreamRef.current?.getTracks().forEach((track) => track.stop());
    pendingScreenStreamRef.current = null;
    screenSetupMessageRef.current = null;
    setScreenStream(null);

    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setCameraStream(null);

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [stopHeartbeat, stopTimer]);

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

  const startListeningGap = useCallback((nextPart: number) => {
    clearListeningGapTimers();
    setListeningWaitingPart(nextPart);
    setListeningGapRemaining(60);

    const startedAt = Date.now();
    listeningGapTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = Math.max(0, 60 - elapsed);
      setListeningGapRemaining(remaining);
      if (remaining <= 0 && listeningGapTimerRef.current) {
        clearInterval(listeningGapTimerRef.current);
        listeningGapTimerRef.current = null;
      }
    }, 1000);

    listeningGapTimeoutRef.current = setTimeout(() => {
      setListeningUnlockedPart(nextPart);
      setListeningWaitingPart(null);
      setListeningGapRemaining(0);
      clearListeningGapTimers();
    }, 60000);
  }, [clearListeningGapTimers]);

  const startCamera = useCallback(async (): Promise<boolean> => {
    // Reuse existing live stream if already active
    const existingTrack = cameraStreamRef.current?.getVideoTracks()[0];
    if (isLiveMonitoringTrack(existingTrack)) return true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });

      const [track] = stream.getVideoTracks();
      track?.addEventListener('ended', () => {
        if (cameraStreamRef.current?.getVideoTracks()[0] !== track) return;
        if (cameraRequirementLostRef.current) return;
        cameraRequirementLostRef.current = true;
        setIsMonitoringReady(false);
        pauseForMonitoringViolation('camera_stopped', 'Camera stream stopped during the test');
      });

      cameraRequirementLostRef.current = false;
      cameraStreamRef.current = stream;
      setCameraStream(stream);
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream;
      return true;
    } catch {
      return false;
    }
  }, [pauseForMonitoringViolation]);

  const startScreenShare = useCallback(async (): Promise<boolean> => {
    // Reuse existing live stream if already active to prevent double prompts
    const existingTrack = screenStreamRef.current?.getVideoTracks()[0];
    if (isLiveMonitoringTrack(existingTrack)) return true;

    const acceptVerifiedStream = (stream: MediaStream, track: MediaStreamTrack | undefined) => {
      track?.addEventListener('ended', () => {
        if (screenStreamRef.current?.getVideoTracks()[0] !== track) return;
        if (screenRequirementLostRef.current) return;
        screenRequirementLostRef.current = true;
        setIsMonitoringReady(false);
        if (triggerHardLock('screen_sharing_stopped', 'Student stopped screen sharing')) return;
        pauseForMonitoringViolation('screen_sharing_stopped', 'Student stopped screen sharing');
      });

      pendingScreenStreamRef.current = null;
      screenSetupMessageRef.current = null;
      screenRequirementLostRef.current = false;
      screenStreamRef.current = stream;
      setScreenStream(stream);
    };

    const verifySelectedStream = async (stream: MediaStream): Promise<boolean> => {
      const [track] = stream.getVideoTracks();
      if (!track || track.readyState === 'ended') {
        pendingScreenStreamRef.current = null;
        screenSetupMessageRef.current = 'Screen sharing ended before it could be verified. Please choose Entire screen and try again.';
        return false;
      }
      activateScreenSharePreview(screenVideoRef.current, stream);

      if (await waitForVerifiedEntireScreenShare(track)) {
        acceptVerifiedStream(stream, track);
        return true;
      }

      const status = getScreenShareVerificationStatus(track?.getSettings?.().displaySurface);
      if (status === 'pending') {
        // Do not terminate a user-selected stream merely because Chromium has
        // not exposed its surface metadata yet. A later setup click rechecks
        // this same stream; it can never start an Attempt until verified.
        pendingScreenStreamRef.current = stream;
        screenSetupMessageRef.current = 'Screen sharing is active, but Chrome is still confirming Entire screen. Keep sharing and try again in a moment.';
        return false;
      }

      stream.getTracks().forEach((item) => item.stop());
      pendingScreenStreamRef.current = null;
      screenSetupMessageRef.current = 'Please choose Entire screen in a browser that supports screen verification.';
      return false;
    };

    try {
      const pendingStream = pendingScreenStreamRef.current;
      if (pendingStream) return await verifySelectedStream(pendingStream);

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
        } as MediaTrackConstraints,
        audio: false,
        // @ts-expect-error - Chromium display surface preference hints
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include',
      });
      return await verifySelectedStream(stream);
    } catch {
      screenSetupMessageRef.current = 'Screen sharing was not started. Please choose Entire screen and try again.';
      return false;
    }
  }, [pauseForMonitoringViolation, triggerHardLock]);

  const requestFullscreen = useCallback(async (): Promise<boolean> => {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      const active = Boolean(document.fullscreenElement);
      setIsFullscreenActive(active);
      return active;
    } catch {
      setIsFullscreenActive(false);
      return false;
    }
  }, []);

  const resumeMonitoring = useCallback(async () => {
    if (isInitializingRef.current) return;
    isInitializingRef.current = true;
    setIsInitializing(true);

    try {
      const cameraTrack = cameraStreamRef.current?.getVideoTracks()[0];
      const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
      const result = await ensureMonitoringStreams({
        cameraLive: isLiveMonitoringTrack(cameraTrack),
        screenLive: isLiveMonitoringTrack(screenTrack),
        requestCamera: startCamera,
        requestScreen: startScreenShare,
      });
      if (!result.ready) {
        showNotification(
          'error',
          result.missing === 'camera'
            ? 'Camera access is required to continue the test.'
            : screenSetupMessageRef.current || 'Entire screen sharing is required to continue the test.',
        );
        return;
      }

      // Browsers can leave fullscreen while the screen-share picker is open.
      // Keep the attempt paused so the next user gesture can restore fullscreen.
      if (!document.fullscreenElement) {
        isPausedRef.current = true;
        setIsPaused(true);
        setIsFullscreenActive(false);
        stopTimer();
        return;
      }

      isPausedRef.current = false;
      setIsPaused(false);
      setIsFullscreenActive(true);
      startTimer(remainingRef.current || durationMinutes * 60);
    } finally {
      isInitializingRef.current = false;
      setIsInitializing(false);
    }
  }, [durationMinutes, showNotification, startCamera, startScreenShare, startTimer, stopTimer]);

  const resumeFullscreen = useCallback(async () => {
    if (isInitializingRef.current) return;
    isInitializingRef.current = true;
    setIsInitializing(true);

    try {
      if (!document.fullscreenElement) {
        const ok = await requestFullscreen();
        if (!ok) return;
      }

      const recoveryStep = getMonitoringRecoveryStep({
        cameraLive: isLiveMonitoringTrack(cameraStreamRef.current?.getVideoTracks()[0]),
        screenLive: isLiveMonitoringTrack(screenStreamRef.current?.getVideoTracks()[0]),
        fullscreenActive: Boolean(document.fullscreenElement),
      });
      if (recoveryStep !== 'ready') {
        isPausedRef.current = true;
        setIsPaused(true);
        setIsFullscreenActive(Boolean(document.fullscreenElement));
        stopTimer();
        return;
      }

      isPausedRef.current = false;
      setIsPaused(false);
      setIsFullscreenActive(true);
      startTimer(remainingRef.current || durationMinutes * 60);
    } finally {
      isInitializingRef.current = false;
      setIsInitializing(false);
    }
  }, [durationMinutes, requestFullscreen, startTimer, stopTimer]);

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

    const loadTest = async () => {
      const applyLoadedTest = (data: TestData) => {
        hardLockRef.current = false;
        setIsHardLocked(false);
        setTest(data);
        setAudioPlayed({});
        setListeningUnlockedPart(1);
        setListeningWaitingPart(null);
        setListeningGapRemaining(0);
        clearListeningGapTimers();
        const base = normalizeSkill(data.skill) === 'listening' ? 35 : 60;
        const duration = Number(data.metadata?.duration || base);
        remainingRef.current = duration * 60;
        setRemainingSeconds(duration * 60);
      };
      const pending = getPendingHardLock(testId, user.uid);
      if (pending) {
        hardLockRef.current = true;
        setIsHardLocked(true);
        setTest(null);
        try {
          const result = await hardLockAttempt(pending);
          clearPendingHardLock(testId, user.uid);
          if (!result.locked) {
            const data = await fetchAccessibleTest<TestData>(testId, { hydrateMaterials: false });
            if (active) applyLoadedTest(data);
          }
        } catch (err) {
          console.warn('[take-test hard-lock] pending incident still awaiting backend', err);
        } finally {
          if (active) setIsLoading(false);
        }
        return;
      }

      try {
        const data = await fetchAccessibleTest<TestData>(testId, { hydrateMaterials: false });
        if (!active) return;
        applyLoadedTest(data);
      } catch (err) {
        if (!active) return;
        if (err instanceof TestAccessLockedError) {
          hardLockRef.current = true;
          setIsHardLocked(true);
          setTest(null);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load test.');
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void loadTest();

    return () => {
      active = false;
    };
  }, [clearListeningGapTimers, testId, user]);

  useEffect(() => {
    if (!isHardLocked || !user || !testId) return;
    let cancelled = false;
    let retryCount = 0;
    let retryTimer: number | null = null;

    const retryPendingLock = async () => {
      const pending = getPendingHardLock(testId, user.uid);
      if (!pending || cancelled) return;
      try {
        const result = await hardLockAttempt(pending);
        if (cancelled) return;
        clearPendingHardLock(testId, user.uid);
        if (!result.locked) router.replace('/student/assignments');
      } catch (err) {
        retryCount += 1;
        const delay = Math.min(30_000, 500 * 2 ** Math.min(retryCount, 6));
        console.warn(`[take-test hard-lock] retry ${retryCount} in ${delay}ms`, err);
        retryTimer = window.setTimeout(() => { void retryPendingLock(); }, delay);
      }
    };

    void retryPendingLock();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [isHardLocked, router, testId, user]);

  useEffect(() => {
    if (cameraVideoRef.current && cameraStream) {
      cameraVideoRef.current.srcObject = cameraStream;
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
      if (!isStartedRef.current) return;
      if (!document.hidden) {
        const fullscreenActive = Boolean(document.fullscreenElement);
        setIsFullscreenActive(fullscreenActive);
        if (!fullscreenActive) {
          isPausedRef.current = true;
          setIsPaused(true);
          stopTimer();
        }
        return;
      }
      const now = Date.now();
      if (now - lastTabSwitchRef.current < 5000) return;
      lastTabSwitchRef.current = now;
      tabSwitchCountRef.current += 1;
      setTabSwitchCount(tabSwitchCountRef.current);
      recordViolation('tab_switch', `User switched tab (${tabSwitchCountRef.current} times)`);
    };

    const onFullscreenChange = () => {
      if (!isStartedRef.current) return;
      const fullscreenActive = Boolean(document.fullscreenElement);
      setIsFullscreenActive(fullscreenActive);
      if (!fullscreenActive) {
        recordViolation('fullscreen_exit', 'User exited fullscreen mode');
        isPausedRef.current = true;
        setIsPaused(true);
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
    if (!isStarted) return;

    const checkInterval = setInterval(() => {
      if (!isStartedRef.current) return;

      const cameraTrack = cameraStreamRef.current?.getVideoTracks()[0];
      const cameraViolation = getMonitoringViolationType('camera', cameraTrack);
      if (cameraViolation && !cameraRequirementLostRef.current) {
        cameraRequirementLostRef.current = true;
        pauseForMonitoringViolation(cameraViolation, 'Camera monitoring became unavailable during the test');
      }

      const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
      const screenViolation = getMonitoringViolationType('screen', screenTrack);
      if (screenViolation && !screenRequirementLostRef.current) {
        screenRequirementLostRef.current = true;
        if (!triggerHardLock(screenViolation, 'Student stopped screen sharing')) {
          pauseForMonitoringViolation(screenViolation, 'Entire screen sharing became unavailable during the test');
        }
      }
    }, 5000); // poll every 5 seconds

    return () => clearInterval(checkInterval);
  }, [isStarted, pauseForMonitoringViolation, triggerHardLock]);

  useEffect(() => () => {
    stopMonitoring();
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    clearListeningGapTimers();
  }, [clearListeningGapTimers, stopMonitoring]);

  const setSingleAnswer = (key: string, value: string) => {
    if (hardLockRef.current) return;
    if (isPausedRef.current) {
      showNotification('warning', 'Please re-share your entire screen before continuing.');
      return;
    }
    updateAnswers((current) => ({ ...current, [key]: value }));
    scheduleAutosave();
  };

  const trimAnswer = (key: string) => {
    if (hardLockRef.current) return;
    const val = answers[key];
    if (val && val !== val.trim()) {
      updateAnswers((current) => ({ ...current, [key]: val.trim() }));
      scheduleAutosave();
    }
  };

  const setMultipleAnswer = (start: number, requiredCount: number, value: string, checked: boolean) => {
    if (hardLockRef.current) return;
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

  const handleListeningAudioEnded = (part: number) => {
    setAudioPlayed((current) => ({ ...current, [part - 1]: 'ended' }));
    if (part < 4) {
      const nextPart = part + 1;
      setListeningUnlockedPart((current) => Math.max(current, part));
      startListeningGap(nextPart);
    }
  };

  const playAudio = (partIndex: number) => {
    const audio = document.getElementById(`tt-audio-${partIndex}`) as HTMLAudioElement | null;
    if (!audio) return;
    if (audioPlayed[partIndex] && audioPlayed[partIndex] !== 'idle') return;
    if (partIndex + 1 > listeningUnlockedPart) return;

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

  const proceedToStartAttempt = async () => {
    if (!test || !user) return;

    try {
      const cameraLive = isLiveMonitoringTrack(cameraStreamRef.current?.getVideoTracks()[0]);
      const screenLive = isLiveMonitoringTrack(screenStreamRef.current?.getVideoTracks()[0]);
      if (!cameraLive || !screenLive) {
        setIsMonitoringReady(false);
        showNotification('error', 'Camera and Entire screen sharing must remain active before the test begins.');
        return;
      }

      if (!document.fullscreenElement) {
        await requestFullscreen();
      }

      if (!document.fullscreenElement) {
        showNotification('error', 'Fullscreen mode is required to take this test.');
        return;
      }

      startRequestIdRef.current ||= crypto.randomUUID();
      const response = await callFunction<{
        attemptId: string;
        resultId: string;
        attemptStartedAt: string;
        className: string;
      }>('/startAttempt', 'POST', {
        examId: null,
        testId: test.id,
        requestId: startRequestIdRef.current,
      });
      attemptIdRef.current = response.attemptId;
      draftIdRef.current = response.resultId;
      setAttemptId(response.attemptId);
      setIsMonitoringReady(false);
      await beginTest(response);
    } catch (err) {
      stopMonitoring();
      if (err instanceof TestAccessLockedError) {
        hardLockRef.current = true;
        setIsHardLocked(true);
        setTest(null);
      } else {
        showNotification('error', err instanceof Error ? err.message : 'Failed to start test. Please try again.');
      }
    }
  };

  const startTest = async () => {
    if (!test || isInitializingRef.current) return;

    monitoringCleanupRef.current = false;
    isInitializingRef.current = true;
    setIsInitializing(true);

    try {
      const result = await ensureMonitoringStreams({
        cameraLive: isLiveMonitoringTrack(cameraStreamRef.current?.getVideoTracks()[0]),
        screenLive: isLiveMonitoringTrack(screenStreamRef.current?.getVideoTracks()[0]),
        requestCamera: startCamera,
        requestScreen: startScreenShare,
      });
      if (!result.ready) {
        showNotification(
          'error',
          result.missing === 'camera'
            ? 'Camera access is required to take this test.'
            : screenSetupMessageRef.current || 'Entire screen sharing is required to take this test.',
        );
        return;
      }

      // Fullscreen requires a fresh user gesture after the permission dialogs.
      // Move to the confirmation step instead of invoking screen sharing again.
      setIsMonitoringReady(true);
    } finally {
      isInitializingRef.current = false;
      setIsInitializing(false);
    }
  };

  const beginTest = async (startContext: {
    attemptId: string;
    resultId: string;
    attemptStartedAt: string;
    className: string;
  }) => {
    if (!test || !user) return;

    // The backend owns Attempt creation. The returned context ties every
    // evidence capture to that immutable Attempt and its readable class name.
    const className = startContext.className || 'Chưa xếp lớp';
    const evidenceAttempt: EvidenceAttemptPathInput = {
      testName: test.name || 'Untitled test',
      testId: test.id,
      className,
      studentName: user.displayName || user.email?.split('@')[0] || 'Student',
      studentUid: user.uid,
      attemptId: startContext.attemptId,
      attemptStartedAt: startContext.attemptStartedAt,
    };
    evidenceAttemptRef.current = evidenceAttempt;
    evidenceSequenceRef.current = 0;
    lastLiveScreenFrameRef.current = null;
    lastScreenFrameCaptureRef.current = 0;

    draftIdRef.current = startContext.resultId;
    monitoringCleanupRef.current = false;
    isStartedRef.current = true;
    setIsStarted(true);
    setHasTestBegun(true);
    const fullscreenActive = Boolean(document.fullscreenElement);
    setIsFullscreenActive(fullscreenActive);
    if (!fullscreenActive) {
      isPausedRef.current = true;
      setIsPaused(true);
    } else {
      startTimer(durationMinutes * 60);
    }
    startHeartbeat(); // Begin periodic evidence heartbeat
  };

  async function submitTest(auto = false) {
    if (!test || !user || isSubmittingRef.current || hardLockRef.current) return;
    if (!auto) {
      showNotification('warning', 'Submit your test now?', false, 'Submit', () => { void submitTest(true); });
      return;
    }

    if (!validateWriting(auto)) return;
    if (!validateMultipleChoiceGroups()) return;
    if (!attemptIdRef.current) {
      showNotification('error', 'Attempt not found. Please return to Assignments and start again.');
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    stopTimer();

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
        const response = await callFunction<{ resultId: string }>('/submitAttempt', 'POST', {
          testId: test.id,
          attemptId: attemptIdRef.current,
          answers: answersRef.current,
          correctAnswers: correctCount,
          totalQuestions: totalCount,
          ieltsBand: band,
          timeSpent: durationMinutes * 60 - remainingRef.current,
          antiCheat: {
            violations: violationsRef.current.length,
            tabSwitches: tabSwitchCountRef.current,
          },
        });
        if (user?.email) invalidateStudentCache(user.email);
        sessionStorage.setItem(`needs_refresh_${user.email}`, '1');
        stopMonitoring();
        router.push(`/student/performance?reviewTestId=${encodeURIComponent(response.resultId)}`);
      } catch (err) {
        if (err instanceof TestAccessLockedError) {
          hardLockRef.current = true;
          setIsHardLocked(true);
        } else {
          showNotification('error', err instanceof Error ? err.message : 'Failed to submit test.');
          startTimer(remainingRef.current);
        }
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
      return;
    }

    // ── Writing: save submission ───────────────────────────────────
    try {
      const response = await callFunction<{ resultId: string }>('/submitAttempt', 'POST', {
        testId: test.id,
        attemptId: attemptIdRef.current,
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
      });
      if (user?.email) invalidateStudentCache(user.email);
      sessionStorage.setItem(`needs_refresh_${user.email}`, '1');
      stopMonitoring();
      router.push(`/student/performance?reviewTestId=${encodeURIComponent(response.resultId)}&fromSubmission=true`);
    } catch (err) {
      if (err instanceof TestAccessLockedError) {
        hardLockRef.current = true;
        setIsHardLocked(true);
      } else {
        showNotification('error', err instanceof Error ? err.message : 'Failed to submit test.');
        startTimer(remainingRef.current);
      }
    } finally {
      isSubmittingRef.current = false;
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

  const monitoringRecoveryStep = isPaused
    ? getMonitoringRecoveryStep({
        cameraLive: isLiveMonitoringTrack(cameraStreamRef.current?.getVideoTracks()[0]),
        screenLive: isLiveMonitoringTrack(screenStreamRef.current?.getVideoTracks()[0]),
        fullscreenActive: isFullscreenActive,
      })
    : 'ready';

  if (isLoading) {
    return <div className="tt-loading">Loading test...</div>;
  }

  if (isHardLocked) {
    return <TestLockedPanel onBack={() => router.replace('/student/assignments')} />;
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
                <div className="tt-start-icon"><i className="fas fa-check-circle" /></div>
                <h1>Monitoring Confirmed</h1>
                <p>Camera and screen sharing are active and ready.</p>
                <div className="tt-setup-list">
                  <div><i className="fas fa-check" style={{ color: '#10b981' }} /> Camera monitoring: Active</div>
                  <div><i className="fas fa-check" style={{ color: '#10b981' }} /> Screen sharing: Active</div>
                  <div><i className="fas fa-expand" style={{ color: '#006769' }} /> Fullscreen: Will enter on begin</div>
                </div>
                <p style={{ marginTop: '20px', fontWeight: 'bold' }}>Click &quot;Begin Test&quot; to enter fullscreen mode and start the test timer.</p>
                <div className="tt-modal-actions">
                  <button type="button" className="tt-secondary" onClick={() => { setIsMonitoringReady(false); stopMonitoring(); }} disabled={isInitializing}>Cancel & Redo Setup</button>
                  <button type="button" className="tt-primary" onClick={async () => {
                    isInitializingRef.current = true;
                    setIsInitializing(true);
                    try {
                      await proceedToStartAttempt();
                    } finally {
                      isInitializingRef.current = false;
                      setIsInitializing(false);
                    }
                  }} disabled={isInitializing}>
                    {isInitializing ? 'Entering Fullscreen...' : 'Begin Test'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {isPaused && (
        <div className="tt-pause-overlay">
          <div>
            {monitoringRecoveryStep === 'fullscreen' ? (
              <>
                <h2>Fullscreen required</h2>
                <p>You left fullscreen mode. Return to fullscreen to continue the test.</p>
                <button type="button" className="tt-primary" onClick={resumeFullscreen} disabled={isInitializing}>
                  {isInitializing ? 'Returning...' : 'Return to fullscreen'}
                </button>
              </>
            ) : monitoringRecoveryStep === 'monitoring' ? (
              <>
                <h2>Monitoring required</h2>
                <p>To continue, restore your camera and share your entire screen.</p>
                <button type="button" className="tt-primary" onClick={resumeMonitoring} disabled={isInitializing}>
                  {isInitializing ? 'Restoring...' : 'Restore monitoring'}
                </button>
              </>
            ) : (
              <>
                <h2>Monitoring restored</h2>
                <p>Camera, screen sharing, and fullscreen are active again.</p>
                <button type="button" className="tt-primary" onClick={resumeFullscreen} disabled={isInitializing}>
                  {isInitializing ? 'Resuming...' : 'Resume test'}
                </button>
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
            const isUnlocked = part <= listeningUnlockedPart;
            const waitingForThisPart = listeningWaitingPart === part;
            const countdownText = waitingForThisPart && listeningGapRemaining > 0 ? formatSeconds(listeningGapRemaining) : null;
            const helpText = !isUnlocked
              ? (waitingForThisPart
                ? `Part ${part} will unlock in ${countdownText || '1:00'}.`
                : `Part ${part} will unlock after the previous parts are completed.`)
              : status === 'idle'
                ? 'Click Play to start listening.'
                : status === 'playing'
                  ? 'Playing... Cannot pause or replay.'
                  : 'Audio has ended. Cannot replay.';
            return (
              <div className="tt-audio-card" key={part}>
                <h3>Audio Part {part}{waitingForThisPart && listeningGapRemaining > 0 ? ` - next in ${countdownText}` : ''}</h3>
                <audio
                  id={`tt-audio-${part - 1}`}
                  preload="metadata"
                  src={url}
                  onEnded={() => handleListeningAudioEnded(part)}
                />
                <button type="button" disabled={!isUnlocked || status !== 'idle'} onClick={() => playAudio(part - 1)} aria-label={`Play audio part ${part}`}>
                  <i className="fas fa-play" /> {status === 'idle' ? 'Play' : status === 'playing' ? 'Playing...' : 'Played'}
                </button>
                <span>{helpText}</span>
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
                <MediaPreview url={(test.files?.writingTask1?.[0] || test.files?.writingTasks?.[0]) as string} label="Writing Task 1" isWriting={true} />
              )}
              {activeWritingTask === 2 && (test.files?.writingTask2?.[0] || test.files?.writingTasks?.[0]) && (
                <MediaPreview url={(test.files?.writingTask2?.[0] || test.files?.writingTasks?.[0]) as string} label="Writing Task 2" isWriting={true} />
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
                  disabled={isHardLocked || isPaused}
                  onChange={(event) => setWritingAnswer('writingTask1', event.target.value)}
                  placeholder="Write your Task 1 response here..."
                />
                <span>Word count: {task1Words} / 150 minimum</span>
              </div>
              <div className={activeWritingTask === 2 ? 'active' : ''}>
                <h3>Writing Task 2</h3>
                <p>Write at least 250 words.</p>
                <textarea
                  value={answers.writingTask2 || ''}
                  disabled={isHardLocked || isPaused}
                  onChange={(event) => setWritingAnswer('writingTask2', event.target.value)}
                  placeholder="Write your Task 2 response here..."
                />
                <span>Word count: {task2Words} / 250 minimum</span>
              </div>
            </div>
          ) : questionBlocks}
        </section>
      </main>

      <div
        ref={cameraElementRef}
        className="tt-camera"
        onMouseDown={handleCameraMouseDown}
        style={{
          cursor: isDraggingCamera ? 'grabbing' : 'grab',
          transform: `translate(${cameraPosition.x}px, ${cameraPosition.y}px)`,
          userSelect: isDraggingCamera ? 'none' : 'auto',
          transition: isDraggingCamera ? 'none' : 'transform 0.1s ease-out',
        }}
      >
        <video ref={cameraVideoRef} autoPlay muted playsInline aria-label="Camera monitoring feed" />
      </div>
      {/* The active Entire-screen stream is the only source for evidence capture. */}
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
