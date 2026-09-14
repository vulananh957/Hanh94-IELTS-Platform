/**
 * Pure utility functions extracted from take-test-content.tsx for testability.
 * These functions have ZERO React dependencies and can be unit tested directly.
 */

export type Skill = 'listening' | 'reading' | 'writing' | string;
export type Answers = Record<string, string>;

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

export function getImageSrc(source: any): string | null {
  if (!source) return null;
  if ('imageData' in source && source.imageData?.src) return source.imageData.src;
  if ('image' in source && source.image) return source.image;
  return null;
}

export function getQuestionTypeImages(qt: any): string[] {
  const urls = [getImageSrc(qt), ...(qt.questions || []).map((question: any) => getImageSrc(question))]
    .filter((url: string | null): url is string => Boolean(url));
  return Array.from(new Set(urls));
}

export function getOptions(value: unknown, fallbackCount = 12): string[] {
  const parsed = splitList(value);
  if (parsed.length > 0) return parsed;
  return Array.from({ length: fallbackCount }, (_, index) => toLetter(index));
}

/* ── Scoring helpers ──────────────────────────────────────────────── */

function normalizeString(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function splitAnswerTokensNoSlash(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((choice) => choice.trim().toUpperCase())
    .filter(Boolean);
}

function matchSingleOption(student: string, option: string): boolean {
  const s = normalizeString(student);
  const opt = normalizeString(option);
  if (!s || !opt) return false;

  if (s === opt) return true;

  // Try matching if both are letters or letter-prefixed (e.g. "A." vs "A")
  const mStudent = student.trim().match(/^[A-Z](?:\.|\s|$)/i);
  const mOption = option.trim().match(/^[A-Z](?:\.|\s|$)/i);
  if (mStudent && mOption) {
    const stuLetter = mStudent[0].toUpperCase().replace('.', '').trim();
    const optLetter = mOption[0].toUpperCase().replace('.', '').trim();
    if (stuLetter === optLetter) return true;
  }

  // Token-based comparison: split on spaces/commas/semicolons and compare as sets
  const studentTokens = splitAnswerTokensNoSlash(student);
  const optionTokens = splitAnswerTokensNoSlash(option);
  if (
    studentTokens.length > 0 &&
    studentTokens.length === optionTokens.length &&
    studentTokens.every((tok) => optionTokens.includes(tok))
  ) {
    return true;
  }

  return false;
}

export function matchAnswer(student: string, correct: string): boolean {
  if (!student || !correct) return false;

  // Split student's potential slash options as well (in case they write both)
  const studentOptions = student
    .split('/')
    .map((token) => token.trim())
    .filter(Boolean);

  const acceptedAnswers = correct
    .split('/')
    .map((token) => token.trim())
    .filter(Boolean);

  return studentOptions.some((sOpt) =>
    acceptedAnswers.some((cOpt) => matchSingleOption(sOpt, cOpt))
  );
}

export function calculateSingleAnswerScore(userAnswer: unknown, accepted: unknown[]): number {
  if (!String(userAnswer || '').trim()) return 0;
  const student = String(userAnswer).trim();

  // accepted is an array of acceptable answers, each might contain alternative options separated by '/'
  const isCorrect = accepted.some((item) => matchAnswer(student, String(item)));
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

/* ── Test metadata helpers ──────────────────────────────────────── */

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

export function countTotalQuestionsFromMetadata(test: TestData): number {
  const metadata = asRecord(test?.metadata);
  const parts = asArray(metadata?.parts);

  if (parts.length === 0) {
    // Fallback: count keys in answerKey
    const ak = test?.answerKey;
    if (ak && typeof ak === 'object') return Object.keys(ak).length;
    return 0;
  }

  let total = 0;

  for (const part of parts) {
    const partRec = asRecord(part);
    const questionTypes = asArray(partRec.questionTypes ?? partRec.sections);
    for (const qt of questionTypes) {
      const qtRec = asRecord(qt);
      const typeName = String(qtRec.type ?? qtRec.label ?? qtRec.kind ?? '');
      const questions = asArray(qtRec.questions ?? qtRec.items);

      if (/multiple choice.*choose multiple/i.test(typeName)) {
        // Each question = choiceCount sub-items
        for (const q of questions) {
          const qRec = asRecord(q);
          total += toPositiveInt(qRec.choiceCount, 2);
        }
      } else {
        // Each question = 1 item
        total += Math.max(
          toPositiveInt(qtRec.questionCount, 0),
          questions.length,
        );
      }
    }
  }

  return total;
}

export function calculateIELTSBand(correctAnswers: number, skill: Skill): number {
  const scoreMap: Record<number, number> = {
    40: 9.0,
    39: 8.5,
    37: 8.0, 38: 8.0,
    35: 7.5, 36: 7.5,
    33: 7.0, 34: 7.0,
    31: 6.5, 32: 6.5,
    29: 6.0, 30: 6.0,
    26: 5.5, 27: 5.5, 28: 5.5,
    23: 5.0, 24: 5.0, 25: 5.0,
    18: 4.5, 19: 4.5, 20: 4.5, 21: 4.5, 22: 4.5,
    15: 4.0, 16: 4.0, 17: 4.0,
    12: 3.5, 13: 3.5, 14: 3.5,
    9: 3.0, 10: 3.0, 11: 3.0,
    7: 2.5, 8: 2.5,
    5: 2.0, 6: 2.0,
    3: 1.5, 4: 1.5,
    1: 1.0, 2: 1.0,
    0: 0,
  };

  const safeSkill = normalizeSkill(skill);
  const _sameAcademicTableForReadingAndListening = safeSkill === 'reading' || safeSkill === 'listening';

  for (let answers = correctAnswers; answers >= 0; answers -= 1) {
    if (scoreMap[answers] !== undefined) return scoreMap[answers];
  }

  return correctAnswers > 0 ? 0 : 0;
}
