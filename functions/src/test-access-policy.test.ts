import { describe, expect, it } from 'vitest';
import {
  canTransitionAttemptToLocked,
  getAccessLockDocumentId,
  isAssignedToTest,
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
});
