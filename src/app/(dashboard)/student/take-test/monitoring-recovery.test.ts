import { describe, expect, it, vi } from 'vitest';
import {
  ensureMonitoringStreams,
  getMonitoringRecoveryStep,
  getMonitoringViolationType,
  isEntireScreenShare,
  shouldHardLockMonitoringViolation,
} from './monitoring-recovery';

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

  it.each([
    [{ cameraLive: false, screenLive: true, fullscreenActive: true }, 'monitoring'],
    [{ cameraLive: true, screenLive: false, fullscreenActive: true }, 'monitoring'],
    [{ cameraLive: false, screenLive: false, fullscreenActive: false }, 'monitoring'],
    [{ cameraLive: true, screenLive: true, fullscreenActive: false }, 'fullscreen'],
    [{ cameraLive: true, screenLive: true, fullscreenActive: true }, 'ready'],
  ] as const)('maps requirement state %o to %s', (state, expected) => {
    expect(getMonitoringRecoveryStep(state)).toBe(expected);
  });

  it('requests camera and screen sharing once during initial setup, then reuses both streams', async () => {
    const requestCamera = vi.fn().mockResolvedValue(true);
    const requestScreen = vi.fn().mockResolvedValue(true);

    await expect(ensureMonitoringStreams({
      cameraLive: false,
      screenLive: false,
      requestCamera,
      requestScreen,
    })).resolves.toEqual({ ready: true, missing: null });

    await expect(ensureMonitoringStreams({
      cameraLive: true,
      screenLive: true,
      requestCamera,
      requestScreen,
    })).resolves.toEqual({ ready: true, missing: null });

    expect(requestCamera).toHaveBeenCalledTimes(1);
    expect(requestScreen).toHaveBeenCalledTimes(1);
  });

  it('requests gesture-sensitive screen sharing before camera access', async () => {
    const callOrder: string[] = [];
    const requestCamera = vi.fn().mockResolvedValue(false);
    const requestScreen = vi.fn().mockImplementation(async () => {
      callOrder.push('screen');
      return true;
    });
    requestCamera.mockImplementation(async () => {
      callOrder.push('camera');
      return false;
    });

    await expect(ensureMonitoringStreams({
      cameraLive: false,
      screenLive: false,
      requestCamera,
      requestScreen,
    })).resolves.toEqual({ ready: false, missing: 'camera' });

    expect(callOrder).toEqual(['screen', 'camera']);
  });

  it('reports screen sharing as missing when its request is rejected', async () => {
    const requestCamera = vi.fn().mockResolvedValue(true);
    await expect(ensureMonitoringStreams({
      cameraLive: true,
      screenLive: false,
      requestCamera,
      requestScreen: vi.fn().mockResolvedValue(false),
    })).resolves.toEqual({ ready: false, missing: 'screen' });

    expect(requestCamera).not.toHaveBeenCalled();
  });

  it.each([
    [true, false, 0, 1],
    [false, true, 1, 0],
  ] as const)(
    'reuses each live stream and requests only the missing requirement',
    async (cameraLive, screenLive, expectedCameraCalls, expectedScreenCalls) => {
      const requestCamera = vi.fn().mockResolvedValue(true);
      const requestScreen = vi.fn().mockResolvedValue(true);

      await expect(ensureMonitoringStreams({
        cameraLive,
        screenLive,
        requestCamera,
        requestScreen,
      })).resolves.toEqual({ ready: true, missing: null });

      expect(requestCamera).toHaveBeenCalledTimes(expectedCameraCalls);
      expect(requestScreen).toHaveBeenCalledTimes(expectedScreenCalls);
    },
  );
});

describe('monitoring requirement validation', () => {
  it.each([
    ['monitor', true],
    ['window', false],
    ['browser', false],
    [undefined, false],
  ] as const)('accepts displaySurface=%s as entire screen: %s', (surface, expected) => {
    expect(isEntireScreenShare(surface)).toBe(expected);
  });

  it.each([
    ['camera', undefined, 'camera_stopped'],
    ['camera', { readyState: 'ended', enabled: true, muted: false }, 'camera_stopped'],
    ['camera', { readyState: 'live', enabled: true, muted: true }, 'camera_muted'],
    ['camera', { readyState: 'live', enabled: false, muted: false }, 'camera_disabled'],
    ['camera', { readyState: 'live', enabled: true, muted: false }, null],
    ['screen', undefined, 'screen_sharing_stopped'],
    ['screen', { readyState: 'ended', enabled: true, muted: false }, 'screen_sharing_stopped'],
    ['screen', { readyState: 'live', enabled: true, muted: true }, 'screen_share_muted'],
    ['screen', { readyState: 'live', enabled: false, muted: false }, 'screen_share_disabled'],
    ['screen', { readyState: 'live', enabled: true, muted: false }, null],
  ] as const)('maps %s track state to %s', (source, track, expected) => {
    expect(getMonitoringViolationType(source, track)).toBe(expected);
  });

  it.each([
    ['screen_sharing_stopped', true, false, false, true],
    ['screen_share_muted', true, false, false, false],
    ['screen_share_disabled', true, false, false, false],
    ['camera_stopped', true, false, false, false],
    ['fullscreen_exit', true, false, false, false],
    ['tab_switch', true, false, false, false],
    ['screen_sharing_stopped', false, false, false, false],
    ['screen_sharing_stopped', true, true, false, false],
    ['screen_sharing_stopped', true, false, true, false],
  ] as const)(
    'hard-lock policy for %s (active=%s submitting=%s cleanup=%s) is %s',
    (violation, active, submitting, cleanup, expected) => {
      expect(shouldHardLockMonitoringViolation({
        violation,
        attemptActive: active,
        submitting,
        monitoringCleanup: cleanup,
      })).toBe(expected);
    },
  );
});
