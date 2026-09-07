export type MonitoringRecoveryStep = 'monitoring' | 'fullscreen' | 'ready';

type MonitoringRecoveryState = {
  cameraLive: boolean;
  screenLive: boolean;
  fullscreenActive: boolean;
};

export function isLiveMonitoringTrack(track: MediaStreamTrack | undefined): boolean {
  return Boolean(track && track.readyState === 'live' && track.enabled && !track.muted);
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
