import { describe, expect, it } from 'vitest';
import { getMonitoringRecoveryStep } from './monitoring-recovery';

describe('getMonitoringRecoveryStep', () => {
  it('requires fullscreen recovery after stopped screen sharing is restored outside fullscreen', () => {
    expect(getMonitoringRecoveryStep({
      cameraLive: true,
      screenLive: false,
      fullscreenActive: false,
    })).toBe('monitoring');

    expect(getMonitoringRecoveryStep({
      cameraLive: true,
      screenLive: true,
      fullscreenActive: false,
    })).toBe('fullscreen');

    expect(getMonitoringRecoveryStep({
      cameraLive: true,
      screenLive: true,
      fullscreenActive: true,
    })).toBe('ready');
  });
});
