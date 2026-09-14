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
export async function activateScreenSharePreview(
  preview: ScreenSharePreview | null,
  stream: unknown,
): Promise<void> {
  if (!preview) return;
  preview.srcObject = stream;
  await preview.play?.().catch(() => undefined);
}

/**
 * Chromium can resolve getDisplayMedia before it exposes displaySurface on the
 * new track. Keep the verification strict, but re-read the metadata once on
 * the next short turn before treating an otherwise valid entire-screen share
 * as a rejected setup.
 */
export async function waitForVerifiedEntireScreenShare(
  track: DisplaySurfaceTrack | undefined,
  retryDelayMs = 300,
): Promise<boolean> {
  const displaySurface = track?.getSettings?.().displaySurface;
  if (isEntireScreenShare(displaySurface)) return true;

  await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelayMs));
  return isEntireScreenShare(track?.getSettings?.().displaySurface);
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
