import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { RuntimeRecoveryGuard } from './runtime-recovery-guard';

function rejection(reason: unknown) {
  const event = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(event, 'reason', { value: reason });
  window.dispatchEvent(event);
  return event;
}
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
it('leaves generic network/storage failures alone instead of reloading login', () => {
  render(<RuntimeRecoveryGuard />);
  expect(rejection(new Event('error')).defaultPrevented).toBe(false);
  expect(rejection(new Error("Cannot read properties of undefined (reading 'call')")).defaultPrevented).toBe(false);
  expect(sessionStorage.getItem('hanh94esl:chunkRecoveryAt')).toBeNull();
});
it('does not reload repeatedly after a chunk recovery and remount', () => {
  sessionStorage.setItem('hanh94esl:chunkRecoveryAt', String(Date.now()));
  const view = render(<RuntimeRecoveryGuard />);
  expect(rejection(new Error('ChunkLoadError: Loading chunk 123 failed')).defaultPrevented).toBe(false);
  view.unmount(); render(<RuntimeRecoveryGuard />);
  expect(rejection(new Error('ChunkLoadError: Loading chunk 123 failed')).defaultPrevented).toBe(false);
});
