import { describe, expect, it } from 'vitest';
import { isActiveManagedStudent } from './user-directory';

describe('active managed student', () => {
  it('uses the same enabled-account definition regardless of legacy account flags', () => {
    expect(isActiveManagedStudent({ role: 'student', status: 'active' })).toBe(true);
    expect(isActiveManagedStudent({ role: 'student' })).toBe(true);
    expect(isActiveManagedStudent({ role: 'student', status: 'active', disabled: true })).toBe(false);
    expect(isActiveManagedStudent({ role: 'student', status: 'disabled' })).toBe(false);
    expect(isActiveManagedStudent({ role: 'student', deletedAt: '2026-09-14' })).toBe(false);
    expect(isActiveManagedStudent({ role: 'teacher', status: 'active' })).toBe(false);
  });
});
