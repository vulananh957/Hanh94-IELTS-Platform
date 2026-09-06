export type EvidenceAttemptPathInput = {
  testName: string;
  testId: string;
  className: string | null | undefined;
  studentName: string;
  studentUid: string;
  attemptId: string;
  attemptStartedAt: string;
};

export type EvidenceCapturePathInput = EvidenceAttemptPathInput & {
  eventAt: string;
  sequence: number;
  trigger: string;
  lastLiveAt?: string;
};

const MAX_FOLDER_LABEL_LENGTH = 80;

function storageSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/[\\/]/g, '-')
    .replace(/[#\[\]*?\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*-\s*/g, '-')
    .replace(/-+/g, '-');

  return (normalized || fallback).slice(0, MAX_FOLDER_LABEL_LENGTH);
}

function timestampSegment(value: string): string {
  return new Date(value).toISOString().replace(/[:.]/g, '-');
}

function triggerSegment(value: string): string {
  return storageSegment(value, 'monitoring-event')
    .toLocaleLowerCase()
    .replace(/[ _]+/g, '-');
}

export function buildEvidenceAttemptPath(input: EvidenceAttemptPathInput): string {
  const testFolder = `${storageSegment(input.testName, 'Untitled test')}--${storageSegment(input.testId, 'unknown-test')}`;
  const classFolder = storageSegment(input.className || '', 'Chưa xếp lớp');
  const studentFolder = `${storageSegment(input.studentName, 'Student')}--${storageSegment(input.studentUid, 'unknown-student')}`;
  const attemptFolder = `${timestampSegment(input.attemptStartedAt)}--${storageSegment(input.attemptId, 'unknown-attempt')}`;

  return `monitoring-evidence/${testFolder}/${classFolder}/${studentFolder}/${attemptFolder}`;
}

export function buildEvidenceCapturePath(input: EvidenceCapturePathInput): string {
  const eventTimestamp = timestampSegment(input.eventAt);
  const lastLiveSuffix = input.lastLiveAt ? `__last-live-at-${timestampSegment(input.lastLiveAt)}` : '';
  const filename = `${eventTimestamp}__${String(input.sequence).padStart(4, '0')}__${triggerSegment(input.trigger)}${lastLiveSuffix}__screen.jpg`;

  return `${buildEvidenceAttemptPath(input)}/${filename}`;
}
