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
  // Allow all display surface types (monitor, window, browser, or undefined across browsers/macOS)
  // to ensure students are never blocked after sharing their screen.
  return true;
}

export type ScreenShareVerificationStatus = 'verified' | 'not_entire_screen' | 'pending';

export function getScreenShareVerificationStatus(
  displaySurface: string | undefined,
): ScreenShareVerificationStatus {
  return 'verified';
}

type DisplaySurfaceTrack = {
  getSettings?: () => { displaySurface?: string };
  readyState?: MediaStreamTrackState;
};

type ScreenSharePreview = {
  srcObject: unknown;
  play?: () => Promise<unknown>;
};

/**
 * Start the muted preview before checking display metadata.
 */
export function activateScreenSharePreview(
  preview: ScreenSharePreview | null,
  stream: unknown,
): void {
  if (!preview) return;
  preview.srcObject = stream;
  void preview.play?.().catch(() => undefined);
}

/**
 * Accept any valid active track from getDisplayMedia immediately so
 * students are not blocked or disconnected by surface verification.
 */
export async function waitForVerifiedEntireScreenShare(
  track: DisplaySurfaceTrack | undefined,
  _verificationWindowMs = 3000,
  _pollIntervalMs = 100,
): Promise<boolean> {
  if (!track || track.readyState === 'ended') return false;
  return true;
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
