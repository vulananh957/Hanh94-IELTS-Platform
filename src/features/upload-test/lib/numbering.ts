import type { TestPart, TestQuestionType } from '../types';

function toPositiveInt(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return next > 0 ? Math.floor(next) : fallback;
}

function getQuestionCount(questionType: TestQuestionType): number {
  if (Array.isArray(questionType.questions) && questionType.questions.length > 0) {
    return questionType.questions.length;
  }

  const fallbackCount = toPositiveInt(questionType.questionCount, 0);
  return fallbackCount;
}

export function isChooseMultipleQuestionType(type: string): boolean {
  return /multiple choice.*choose multiple/i.test(type);
}

export function calculateQuestionNumbers(parts: TestPart[]): TestPart[] {
  let currentNumber = 1;

  return (parts || []).map((part) => {
    const normalizedQuestionTypes = (part.questionTypes || []).map((questionType) => {
      const questionCount = getQuestionCount(questionType);
      const startNumber = currentNumber;

      if (isChooseMultipleQuestionType(questionType.type)) {
        const totalChoices = (questionType.questions || []).reduce((total, question) => {
          return total + toPositiveInt((question as { choiceCount?: number }).choiceCount, 3);
        }, 0);

        currentNumber += totalChoices;
      } else {
        currentNumber += questionCount;
      }

      return {
        ...questionType,
        questionCount,
        startNumber,
        endNumber: currentNumber - 1,
      };
    });

    return {
      ...part,
      questionTypes: normalizedQuestionTypes,
    };
  });
}
