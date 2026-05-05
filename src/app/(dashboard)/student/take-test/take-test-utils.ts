/**
 * Pure utility functions extracted from take-test-content.tsx for testability.
 * These functions have ZERO React dependencies and can be unit tested directly.
 */

export type Skill = 'listening' | 'reading' | 'writing' | string;
export type Answers = Record<string, string>;

export type QuestionResult = {
  questionId: string;
  questionDisplayName: string;
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  score: number;
  maxScore: number;
  isMultipleChoice?: boolean;
  wordCount?: number;
  minRequired?: number;
};

export type TestData = {
  id: string;
  name?: string;
  skill?: Skill;
  files?: Record<string, string[]>;
  metadata?: {
    duration?: number | string;
    difficulty?: string;
    parts?: Array<{
      name?: string;
      questionTypes?: Array<{
        type?: string;
        questionCount?: number;
        instructions?: string;
        headings?: string[] | string;
        headingsList?: string;
        headingCount?: number;
        features?: string[] | string;
        featuresList?: string;
        endingsList?: string;
        summaryText?: string;
        wordBank?: string | string[];
        options?: string[] | string;
        customOptionsCount?: number;
        image?: string;
        imageData?: { src?: string; name?: string };
        questions?: Array<{
          question?: string;
          instructions?: string;
          choiceCount?: number;
          options?: string[];
          paragraphLetter?: string;
          image?: string;
          imageData?: { src?: string; name?: string };
          summaryText?: string;
          wordBank?: string | string[];
        }>;
      }>;
    }>;
  };
  answerKey?: Record<string, string | string[]>;
  writingRule?: 'auto-submit' | 'overtime' | string | null;
  ownerUid?: string | null;
};

/* ── Formatting helpers ───────────────────────────────────────────── */

export function formatSeconds(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function normalizeSkill(value: unknown): Skill {
  const skill = String(value || '').toLowerCase();
  if (skill.includes('listening')) return 'listening';
  if (skill.includes('reading')) return 'reading';
  if (skill.includes('writing')) return 'writing';
  return skill || 'reading';
}

export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n|[,;|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitAnswerTokens(value: unknown): string[] {
  return String(value || '')
    .split(/[,\s;/]+/)
    .map((choice) => choice.trim().toUpperCase())
    .filter(Boolean);
}

export function toLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/* ── Scoring helpers ──────────────────────────────────────────────── */

export function calculateSingleAnswerScore(userAnswer: unknown, accepted: unknown[]): number {
  if (!String(userAnswer || '').trim()) return 0;

  const userStr = String(userAnswer).trim();
  const userLower = userStr.toLowerCase();

  const isCorrect = accepted.some((item) => {
    const acceptedStr = String(item).trim();
    if (acceptedStr.toLowerCase() === userLower) return true;

    if (acceptedStr.includes('/')) {
      return acceptedStr.split('/').map((option) => option.trim().toLowerCase()).includes(userLower);
    }

    if (acceptedStr.includes(',') || acceptedStr.includes(';')) {
      return acceptedStr.split(/[,;]/).map((option) => option.trim().toLowerCase()).includes(userLower);
    }

    return false;
  });

  return isCorrect ? 1 : 0;
}

export function calculateMultipleChoiceScore(userAnswer: unknown, accepted: unknown[]): number {
  const studentChoices = Array.from(new Set(splitAnswerTokens(userAnswer)));
  const acceptedChoices = accepted.flatMap((item) => splitAnswerTokens(item));

  let correctChoices = 0;
  studentChoices.forEach((choice) => {
    if (acceptedChoices.includes(choice)) correctChoices += 1;
  });

  return Math.min(correctChoices, acceptedChoices.length);
}

export function calculateScore(userAnswer: unknown, accepted: unknown[]): number {
  if (!String(userAnswer || '').trim()) return 0;

  const isMultipleChoice = accepted.some((item) => {
    const answer = String(item);
    return answer.includes(',') ||
      answer.includes(';') ||
      answer.includes('/') ||
      answer.includes(' ') ||
      (answer.length > 1 && /^[A-Z\s,;/]+$/i.test(answer));
  });

  return isMultipleChoice
    ? calculateMultipleChoiceScore(userAnswer, accepted)
    : calculateSingleAnswerScore(userAnswer, accepted);
}

export function calculateIELTSBand(correctAnswers: number, skill: Skill): number {
  const scoreMap: Record<number, number> = {
    39: 9.0, 40: 9.0,
    37: 8.5, 38: 8.5,
    35: 8.0, 36: 8.0,
    33: 7.5, 34: 7.5,
    30: 7.0, 31: 7.0, 32: 7.0,
    27: 6.5, 28: 6.5, 29: 6.5,
    23: 6.0, 24: 6.0, 25: 6.0, 26: 6.0,
    20: 5.5, 21: 5.5, 22: 5.5,
    16: 5.0, 17: 5.0, 18: 5.0, 19: 5.0,
    13: 4.5, 14: 4.5, 15: 4.5,
    10: 4.0, 11: 4.0, 12: 4.0,
    7: 3.5, 8: 3.5, 9: 3.5,
    5: 3.0, 6: 3.0,
    3: 2.5, 4: 2.5,
  };

  const safeSkill = normalizeSkill(skill);
  const _sameAcademicTableForReadingAndListening = safeSkill === 'reading' || safeSkill === 'listening';

  for (let answers = correctAnswers; answers >= 0; answers -= 1) {
    if (scoreMap[answers] !== undefined) return scoreMap[answers];
  }

  return 0;
}

/* ── Question Results ─────────────────────────────────────────────── */

export function generateQuestionResults(test: TestData, answers: Answers): QuestionResult[] {
  if (normalizeSkill(test.skill) === 'writing') {
    const task1 = answers.writingTask1 || '';
    const task2 = answers.writingTask2 || '';
    const task1Words = task1.trim() ? task1.trim().split(/\s+/).length : 0;
    const task2Words = task2.trim() ? task2.trim().split(/\s+/).length : 0;

    return [
      {
        questionId: 'writingTask1',
        questionDisplayName: 'Writing Task 1',
        studentAnswer: task1 || 'No answer',
        correctAnswer: 'Manual grading required',
        isCorrect: task1Words >= 150,
        score: task1Words >= 150 ? 1 : 0,
        maxScore: 1,
        wordCount: task1Words,
        minRequired: 150,
      },
      {
        questionId: 'writingTask2',
        questionDisplayName: 'Writing Task 2',
        studentAnswer: task2 || 'No answer',
        correctAnswer: 'Manual grading required',
        isCorrect: task2Words >= 250,
        score: task2Words >= 250 ? 1 : 0,
        maxScore: 1,
        wordCount: task2Words,
        minRequired: 250,
      },
    ];
  }

  const answerKey = test.answerKey || {};
  const groupKeys = Object.keys(answers).filter((key) => key.includes('-'));
  const processedGroups = new Set<string>();
  const results: QuestionResult[] = [];

  Object.keys(answerKey).forEach((qid) => {
    const accepted = Array.isArray(answerKey[qid]) ? answerKey[qid] as string[] : [answerKey[qid] as string];
    const currentQid = parseInt(qid, 10);

    const shouldProcess = groupKeys.some((groupKey) => {
      const [start] = groupKey.split('-').map(Number);
      return currentQid === start;
    }) || !groupKeys.some((groupKey) => {
      const [start, end] = groupKey.split('-').map(Number);
      return currentQid >= start && currentQid <= end;
    });

    if (!shouldProcess) return;

    const isGroup = groupKeys.some((groupKey) => {
      const [start, end] = groupKey.split('-').map(Number);
      return currentQid >= start && currentQid <= end;
    });

    if (isGroup) {
      const acceptedChoices = accepted.flatMap((item) => splitAnswerTokens(item));
      const startNum = currentQid;
      const endNum = startNum + acceptedChoices.length - 1;
      const groupId = `${startNum}-${endNum}`;

      if (processedGroups.has(groupId)) return;
      processedGroups.add(groupId);

      const studentAnswer = answers[groupId] || '';
      const score = calculateScore(studentAnswer, accepted);
      results.push({
        questionId: groupId,
        questionDisplayName: `Question ${startNum}-${endNum}`,
        studentAnswer: studentAnswer || 'No answer',
        correctAnswer: String(answerKey[qid]),
        isCorrect: score >= acceptedChoices.length,
        score,
        maxScore: acceptedChoices.length,
        isMultipleChoice: true,
      });
      return;
    }

    const studentAnswer = answers[qid] || '';
    const score = calculateSingleAnswerScore(studentAnswer, accepted);
    results.push({
      questionId: qid,
      questionDisplayName: `Question ${qid}`,
      studentAnswer: studentAnswer || 'No answer',
      correctAnswer: String(answerKey[qid]),
      isCorrect: score > 0,
      score,
      maxScore: 1,
    });
  });

  return results;
}
