export type TestAssignment = {
  distribution?: unknown;
  selectedClasses?: unknown;
};

export type StudentClass = {
  classId?: unknown;
  classCode?: unknown;
};

function normalizedText(value: unknown): string {
  return String(value ?? '').trim();
}

export function getAccessLockDocumentId(testId: string, studentUid: string): string {
  return `${normalizedText(testId)}--${normalizedText(studentUid)}`;
}

export function canTransitionAttemptToLocked(status: unknown): boolean {
  return ['in_progress', 'started', 'active'].includes(normalizedText(status).toLowerCase());
}

export function isAssignedToTest(assignment: TestAssignment, student: StudentClass): boolean {
  const selectedClasses = Array.isArray(assignment.selectedClasses)
    ? assignment.selectedClasses.map(normalizedText).filter(Boolean)
    : [];
  const distribution = normalizedText(assignment.distribution).toLowerCase();

  if (distribution !== 'specific' && selectedClasses.length === 0) return true;

  const studentKeys = new Set([
    normalizedText(student.classId),
    normalizedText(student.classCode),
  ].filter(Boolean));

  return selectedClasses.some((classKey) => studentKeys.has(classKey));
}
