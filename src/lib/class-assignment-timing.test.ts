import { describe, expect, it } from 'vitest';
import {
  buildClassAssignmentWithOpenedTimes,
  getClassAssignmentOpenedAt,
} from './class-assignment-timing';

describe('class assignment timing', () => {
  it('keeps an existing class opening time while timestamping a newly opened class', () => {
    const firstOpenedAt = new Date('2026-06-01T08:00:00.000Z');
    const laterOpenedAt = new Date('2026-09-06T08:00:00.000Z');
    const assignment = buildClassAssignmentWithOpenedTimes({
      distribution: 'specific',
      selectedClasses: ['class-a'],
      openedAtByClass: { 'class-a': firstOpenedAt },
      updatedAt: firstOpenedAt,
    }, {
      distribution: 'specific',
      selectedClasses: ['class-a', 'class-b'],
    }, laterOpenedAt);

    expect(getClassAssignmentOpenedAt(assignment, ['class-a'], null)).toBe(firstOpenedAt);
    expect(getClassAssignmentOpenedAt(assignment, ['class-b'], null)).toBe(laterOpenedAt);
  });

  it('falls back to the legacy assignment timestamp when no per-class time exists', () => {
    const legacyOpenedAt = new Date('2026-05-01T08:00:00.000Z');

    expect(getClassAssignmentOpenedAt({ updatedAt: legacyOpenedAt }, ['class-a'], null)).toBe(legacyOpenedAt);
  });
});
