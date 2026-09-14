export type TestAssignment = {
  distribution?: unknown;
  selectedClasses?: unknown;
};

export type StudentClass = {
  classId?: unknown;
  classCode?: unknown;
};

export type MaterialCapability = {
  expectedTicket: unknown;
  presentedTicket: unknown;
  expiresAtMs: unknown;
  nowMs: number;
  allowedPaths: unknown;
  requestedPath: unknown;
};

export type ByteRange = {
  start: number;
  end: number;
  partial: boolean;
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

export function canUseMaterialCapability(input: MaterialCapability): boolean {
  const expectedTicket = normalizedText(input.expectedTicket);
  const presentedTicket = normalizedText(input.presentedTicket);
  const requestedPath = normalizedText(input.requestedPath);
  const expiresAtMs = Number(input.expiresAtMs);
  const allowedPaths = Array.isArray(input.allowedPaths)
    ? input.allowedPaths.map(normalizedText)
    : [];

  return Boolean(
    expectedTicket
    && presentedTicket === expectedTicket
    && requestedPath
    && allowedPaths.includes(requestedPath)
    && Number.isFinite(expiresAtMs)
    && expiresAtMs > input.nowMs,
  );
}

export function resolveByteRange(totalSize: number, rangeHeader: unknown): ByteRange | null {
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) return null;
  const range = normalizedText(rangeHeader);
  if (!range) return { start: 0, end: Math.max(totalSize - 1, 0), partial: false };
  if (totalSize === 0) return null;

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, from, to] = match;
  if (!from && !to) return null;

  let start: number;
  let end: number;
  if (from) {
    start = Number(from);
    end = to ? Number(to) : totalSize - 1;
  } else {
    const suffixSize = Number(to);
    if (!Number.isSafeInteger(suffixSize) || suffixSize <= 0) return null;
    start = Math.max(totalSize - suffixSize, 0);
    end = totalSize - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= totalSize) {
    return null;
  }
  return { start, end: Math.min(end, totalSize - 1), partial: true };
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
