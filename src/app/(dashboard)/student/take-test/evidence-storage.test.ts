import { describe, expect, it } from 'vitest';
import { buildEvidenceCapturePath } from './evidence-storage';

describe('buildEvidenceCapturePath', () => {
  it('groups a screen capture by test, class name, student, and attempt', () => {
    expect(buildEvidenceCapturePath({
      testName: 'Reading / Midterm',
      testId: 'test-123',
      className: 'Lớp 10A1',
      studentName: 'Nguyễn Văn An',
      studentUid: 'student-456',
      attemptId: 'result-789',
      attemptStartedAt: '2026-09-06T06:30:00.000Z',
      eventAt: '2026-09-06T06:43:22.000Z',
      sequence: 3,
      trigger: 'screen_sharing_stopped',
      lastLiveAt: '2026-09-06T06:43:14.000Z',
    })).toBe(
      'monitoring-evidence/Reading-Midterm--test-123/Lớp 10A1/Nguyễn Văn An--student-456/'
      + '2026-09-06T06-30-00-000Z--result-789/'
      + '2026-09-06T06-43-22-000Z__0003__screen-sharing-stopped__last-live-at-2026-09-06T06-43-14-000Z__screen.jpg',
    );
  });

  it('keeps capture paths usable when display names contain unsafe path characters', () => {
    expect(buildEvidenceCapturePath({
      testName: 'Test #1/[draft]',
      testId: 'test-123',
      className: '',
      studentName: 'A/B',
      studentUid: 'student-456',
      attemptId: 'result-789',
      attemptStartedAt: '2026-09-06T06:30:00.000Z',
      eventAt: '2026-09-06T06:43:22.000Z',
      sequence: 12,
      trigger: 'tab_switch',
    })).toBe(
      'monitoring-evidence/Test 1-draft--test-123/Chưa xếp lớp/A-B--student-456/'
      + '2026-09-06T06-30-00-000Z--result-789/'
      + '2026-09-06T06-43-22-000Z__0012__tab-switch__screen.jpg',
    );
  });
});
