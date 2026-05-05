/**
 * Simulated student session fixtures — one per IELTS skill.
 * All dates are deterministic to prevent flaky tests.
 */

import { makeTimestamp } from './firebase-mock';

// ─── Reference dates ──────────────────────────────────────────────────────────

export const TODAY = new Date('2025-01-15T10:00:00Z');
export const YESTERDAY = new Date('2025-01-14T10:00:00Z');
export const LAST_WEEK = new Date('2025-01-08T10:00:00Z');

export const STUDENT_EMAIL = 'student@hanh94esl.test';
export const STUDENT_UID = 'uid-test-001';
export const CLASS_ID = 'class-a1';
export const CLASS_NAME = 'IELTS Prep A1';

// ─── User profile document ────────────────────────────────────────────────────

export const fixtureUser = {
  email: STUDENT_EMAIL,
  classId: CLASS_ID,
  displayName: 'Test Student',
};

export const fixtureClass = {
  id: CLASS_ID,
  name: CLASS_NAME,
  code: 'A1',
};

// ─── Listening testResult document ───────────────────────────────────────────

export const fixtureListeningResult = {
  studentEmail: STUDENT_EMAIL,
  testId: 'test-listening-001',
  testName: 'IELTS Listening Practice 1',
  testType: 'listening',
  status: 'completed',
  ieltsBand: 6.5,
  correctAnswers: 32,
  totalQuestions: 40,
  completedAt: makeTimestamp(TODAY),
};

// ─── Reading testResult document ─────────────────────────────────────────────

export const fixtureReadingResult = {
  studentEmail: STUDENT_EMAIL,
  testId: 'test-reading-001',
  testName: 'IELTS Reading Academic 1',
  testType: 'reading',
  status: 'completed',
  ieltsBand: 7.0,
  correctAnswers: 35,
  totalQuestions: 40,
  completedAt: makeTimestamp(YESTERDAY),
};

// ─── Writing submission document ─────────────────────────────────────────────

export const fixtureWritingGraded = {
  studentEmail: STUDENT_EMAIL,
  testId: 'test-writing-001',
  testName: 'IELTS Writing Task 1 & 2',
  status: 'graded',
  writingScore: 6.5,
  task1Score: 6.0,
  task2Score: 7.0,
  comments: 'Good coherence. Improve vocabulary range.',
  submittedAt: makeTimestamp(LAST_WEEK),
  gradedAt: makeTimestamp(YESTERDAY),
  answers: {
    writingTask1: 'The chart shows...',
    writingTask2: 'In my opinion...',
  },
};

export const fixtureWritingPending = {
  studentEmail: STUDENT_EMAIL,
  testId: 'test-writing-002',
  testName: 'IELTS Writing Practice 2',
  status: 'pending',
  submittedAt: makeTimestamp(TODAY),
  answers: {
    writingTask1: 'The graph illustrates...',
    writingTask2: 'It is argued that...',
  },
};

// ─── Test documents (for assignments) ────────────────────────────────────────

export const fixtureTestListening = {
  name: 'Listening Prep Test 1',
  skill: 'listening',
  createdAt: makeTimestamp(LAST_WEEK),
  classAssignment: { distribution: 'all' },
};

export const fixtureTestReading = {
  name: 'Reading Academic Test 1',
  skill: 'reading',
  createdAt: makeTimestamp(LAST_WEEK),
  classAssignment: { distribution: 'all' },
};

export const fixtureTestWriting = {
  name: 'Writing Task 1 Practice',
  skill: 'writing',
  createdAt: makeTimestamp(LAST_WEEK),
  classAssignment: {
    distribution: 'specific',
    selectedClasses: [CLASS_ID],
  },
};

export const fixtureTestPrivate = {
  name: 'Private Test (other class)',
  skill: 'listening',
  createdAt: makeTimestamp(LAST_WEEK),
  classAssignment: {
    distribution: 'specific',
    selectedClasses: ['class-other'],
  },
};
