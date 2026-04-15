import type { TestPart, TestQuestion, TestQuestionType } from '../types';

function normalizeMulti(answers: string[]): string {
  return (answers || [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(' ');
}

function isTrueFalseLike(type: string): boolean {
  return /(true\s*\/\s*false\s*\/\s*not\s*given|yes\s*\/\s*no\s*\/\s*not\s*given)/i.test(type);
}

function isSingleChoice(type: string): boolean {
  return /multiple choice.*single answer/i.test(type);
}

function isCompletionLike(type: string): boolean {
  return /completion|short answer|sentence|diagram|table|flow/i.test(type);
}

function isMatchingHeadings(type: string): boolean {
  return /matching headings/i.test(type);
}

function isMatchingSentenceEndings(type: string): boolean {
  return /matching sentence endings/i.test(type);
}

function isMatchingLike(type: string): boolean {
  return /matching/i.test(type);
}

function isChooseMultiple(type: string): boolean {
  return /multiple choice.*choose multiple/i.test(type);
}

function getQuestionCount(questionType: TestQuestionType): number {
  if (Array.isArray(questionType.questions) && questionType.questions.length > 0) {
    return questionType.questions.length;
  }

  if (questionType.questionCount) {
    return Number(questionType.questionCount) || 0;
  }

  return 0;
}

function toQuestion(record: unknown): TestQuestion {
  if (!record || typeof record !== 'object') {
    return {};
  }

  return record as TestQuestion;
}

function toNonEmptyAnswer(value: unknown): string {
  return String(value || '').trim();
}

export function buildAnswerKeyFromParts(parts: TestPart[]): Record<string, string[]> {
  const key: Record<string, string[]> = {};
  let currentQuestionNumber = 1;

  (parts || []).forEach((part) => {
    (part.questionTypes || []).forEach((questionType) => {
      const typeLabel = questionType.type || '';
      const count = getQuestionCount(questionType);

      if (isChooseMultiple(typeLabel)) {
        for (let i = 0; i < count; i += 1) {
          const question = toQuestion(questionType.questions?.[i]);
          const choiceCount = Number((question as { choiceCount?: number }).choiceCount || 3);

          const questionNumber = String(currentQuestionNumber);
          const value = normalizeMulti(
            ((question as { correctAnswers?: string[] }).correctAnswers || []).map((item) => String(item || '')),
          );

          if (value) {
            key[questionNumber] = [value];
          }

          currentQuestionNumber += choiceCount;
        }

        return;
      }

      for (let i = 0; i < count; i += 1) {
        const questionNumber = String(currentQuestionNumber);
        currentQuestionNumber += 1;

        const question = toQuestion(questionType.questions?.[i]);
        let value = '';

        if (isMatchingSentenceEndings(typeLabel)) {
          value = toNonEmptyAnswer((question as { correctEnding?: string }).correctEnding).toUpperCase();
        } else if (isSingleChoice(typeLabel)) {
          value = toNonEmptyAnswer((question as { correctAnswer?: string }).correctAnswer).toUpperCase();
        } else if (isTrueFalseLike(typeLabel)) {
          value = toNonEmptyAnswer((question as { correctAnswer?: string }).correctAnswer);
        } else if (isCompletionLike(typeLabel)) {
          value = toNonEmptyAnswer((question as { correctAnswer?: string }).correctAnswer);
        } else if (isMatchingHeadings(typeLabel)) {
          value = toNonEmptyAnswer((question as { correctHeading?: string }).correctHeading);
        } else if (isMatchingLike(typeLabel)) {
          value = toNonEmptyAnswer((question as { correctAnswer?: string }).correctAnswer);
        } else {
          value = toNonEmptyAnswer((question as { correctAnswer?: string }).correctAnswer);
        }

        if (value) {
          key[questionNumber] = [value];
        }
      }
    });
  });

  return key;
}

export function generateAnswerKey(parts: TestPart[]): Record<string, string[]> {
  return buildAnswerKeyFromParts(parts);
}
