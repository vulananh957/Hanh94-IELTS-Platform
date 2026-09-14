import { describe, expect, it } from 'vitest';
import {
  canUseMaterialCapability,
  canTransitionAttemptToLocked,
  getAccessLockDocumentId,
  isAssignedToTest,
  resolveByteRange,
} from './test-access-policy';

describe('test access policy', () => {
  it('uses one deterministic lock document for a student and test', () => {
    expect(getAccessLockDocumentId('reading-01', 'student-123'))
      .toBe('reading-01--student-123');
  });

  it.each([
    ['in_progress', true],
    ['started', true],
    ['active', true],
    ['completed', false],
    ['submitted', false],
    ['locked', false],
    ['terminated', false],
    ['', false],
  ])('locks only an active attempt with status %s', (status, expected) => {
    expect(canTransitionAttemptToLocked(status)).toBe(expected);
  });

  it('accepts all-class tests and matches either class id or class code', () => {
    expect(isAssignedToTest({ distribution: 'all' }, { classId: null, classCode: null })).toBe(true);
    expect(isAssignedToTest(
      { distribution: 'specific', selectedClasses: ['class-doc-id'] },
      { classId: 'class-doc-id', classCode: 'IELTS-A' },
    )).toBe(true);
    expect(isAssignedToTest(
      { distribution: 'specific', selectedClasses: ['IELTS-A'] },
      { classId: 'class-doc-id', classCode: 'IELTS-A' },
    )).toBe(true);
    expect(isAssignedToTest(
      { distribution: 'specific', selectedClasses: ['OTHER'] },
      { classId: 'class-doc-id', classCode: 'IELTS-A' },
    )).toBe(false);
  });

  it('treats any non-empty selectedClasses list as the access boundary for legacy shapes', () => {
    const student = { classId: 'class-a', classCode: 'A' };
    expect(isAssignedToTest({ selectedClasses: ['class-a'] }, student)).toBe(true);
    expect(isAssignedToTest({ distribution: 'all', selectedClasses: ['class-a'] }, student)).toBe(true);
    expect(isAssignedToTest({ selectedClasses: ['class-b'] }, student)).toBe(false);
    expect(isAssignedToTest({ distribution: 'all', selectedClasses: ['class-b'] }, student)).toBe(false);
  });

  it('requires a current opaque ticket for exactly one allowed material path', () => {
    const input = {
      expectedTicket: 'opaque-ticket',
      presentedTicket: 'opaque-ticket',
      expiresAtMs: 10_001,
      nowMs: 10_000,
      allowedPaths: ['tests/test-1/audio.mp3'],
      requestedPath: 'tests/test-1/audio.mp3',
    };
    expect(canUseMaterialCapability(input)).toBe(true);
    expect(canUseMaterialCapability({ ...input, presentedTicket: 'wrong-ticket' })).toBe(false);
    expect(canUseMaterialCapability({ ...input, requestedPath: 'tests/test-1/other.mp3' })).toBe(false);
    expect(canUseMaterialCapability({ ...input, expiresAtMs: 10_000 })).toBe(false);
  });

  it('resolves valid byte ranges without allowing out-of-bounds reads', () => {
    expect(resolveByteRange(1_000, 'bytes=100-199')).toEqual({ start: 100, end: 199, partial: true });
    expect(resolveByteRange(1_000, 'bytes=-200')).toEqual({ start: 800, end: 999, partial: true });
    expect(resolveByteRange(1_000, '')).toEqual({ start: 0, end: 999, partial: false });
    expect(resolveByteRange(1_000, 'bytes=1000-')).toBeNull();
    expect(resolveByteRange(1_000, 'bytes=100-99')).toBeNull();
  });
});
