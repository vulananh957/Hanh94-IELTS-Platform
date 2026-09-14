export type MonitoringRecoveryStep = 'monitoring' | 'fullscreen' | 'ready';

export function shouldHardLockMonitoringViolation(input: {
  violation: string;
  attemptActive: boolean;
  submitting: boolean;
  monitoringCleanup: boolean;
}): boolean {
  return input.violation === 'screen_sharing_stopped'
    && input.attemptActive
    && !input.submitting
    && !input.monitoringCleanup;
}
export type MonitoringSource = 'camera' | 'screen';

type MonitoringTrackState = {
  readyState: MediaStreamTrackState;
  enabled: boolean;
  muted: boolean;
};

type MonitoringRecoveryState = {
  cameraLive: boolean;
  screenLive: boolean;
  fullscreenActive: boolean;
};

type EnsureMonitoringStreamsInput = {
  cameraLive: boolean;
  screenLive: boolean;
  requestCamera: () => Promise<boolean>;
  requestScreen: () => Promise<boolean>;
};

export type EnsureMonitoringStreamsResult =
  | { ready: true; missing: null }
  | { ready: false; missing: 'camera' | 'screen' };

export function isLiveMonitoringTrack(track: MonitoringTrackState | undefined): boolean {
  return Boolean(track && track.readyState === 'live' && track.enabled && !track.muted);
}

export function isEntireScreenShare(displaySurface: string | undefined): boolean {
  return displaySurface === 'monitor';
}

export type ScreenShareVerificationStatus = 'verified' | 'not_entire_screen' | 'pending';

export function getScreenShareVerificationStatus(
  displaySurface: string | undefined,
): ScreenShareVerificationStatus {
  if (isEntireScreenShare(displaySurface)) return 'verified';
  return displaySurface === undefined ? 'pending' : 'not_entire_screen';
}

type DisplaySurfaceTrack = {
  getSettings?: () => { displaySurface?: string };
};

type ScreenSharePreview = {
  srcObject: unknown;
  play?: () => Promise<unknown>;
};

/**
 * Start the muted preview before checking display metadata. On Chromium/macOS
 * the display track can remain in its startup state until a consumer is
 * attached, even though the user has already selected Entire screen.
 */
export function activateScreenSharePreview(
  preview: ScreenSharePreview | null,
  stream: unknown,
): void {
  if (!preview) return;
  preview.srcObject = stream;
  // A hidden video can take an unbounded time to resolve play() in some
  // Chromium/macOS sessions. It is only a consumer for the track, not a
  // prerequisite for the security check, so never block setup on it.
  void preview.play?.().catch(() => undefined);
}

/**
 * Chromium can resolve getDisplayMedia before it exposes displaySurface on the
 * new track. Keep the verification strict, but poll briefly before treating
 * an otherwise valid entire-screen share as a rejected setup.
 */
export async function waitForVerifiedEntireScreenShare(
  track: DisplaySurfaceTrack | undefined,
  verificationWindowMs = 3000,
  pollIntervalMs = 100,
): Promise<boolean> {
  const attempts = Math.max(
    2,
    Math.ceil(Math.max(0, verificationWindowMs) / Math.max(1, pollIntervalMs)) + 1,
  );

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = getScreenShareVerificationStatus(track?.getSettings?.().displaySurface);
    if (status === 'verified') return true;
    if (status === 'not_entire_screen') return false;

    if (attempt < attempts - 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, pollIntervalMs));
    }
  }

  return false;
}

export function getMonitoringViolationType(
  source: MonitoringSource,
  track: MonitoringTrackState | undefined,
): string | null {
  if (isLiveMonitoringTrack(track)) return null;

  if (track?.muted) {
    return source === 'camera' ? 'camera_muted' : 'screen_share_muted';
  }

  if (!track || track.readyState === 'ended') {
    return source === 'camera' ? 'camera_stopped' : 'screen_sharing_stopped';
  }

  return source === 'camera' ? 'camera_disabled' : 'screen_share_disabled';
}

export function getMonitoringRecoveryStep({
  cameraLive,
  screenLive,
  fullscreenActive,
}: MonitoringRecoveryState): MonitoringRecoveryStep {
  if (!cameraLive || !screenLive) return 'monitoring';
  if (!fullscreenActive) return 'fullscreen';
  return 'ready';
}

export async function ensureMonitoringStreams({
  cameraLive,
  screenLive,
  requestCamera,
  requestScreen,
}: EnsureMonitoringStreamsInput): Promise<EnsureMonitoringStreamsResult> {
  // getDisplayMedia requires a transient user activation, so request it before
  // awaiting the camera permission dialog. Existing live streams are reused.
  const screenReady = screenLive || await requestScreen();
  if (!screenReady) return { ready: false, missing: 'screen' };

  const cameraReady = cameraLive || await requestCamera();
  if (!cameraReady) return { ready: false, missing: 'camera' };

  return { ready: true, missing: null };
}
