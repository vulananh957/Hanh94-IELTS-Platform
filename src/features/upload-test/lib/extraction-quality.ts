import type { ExtractionWarning, TestPart, TestSkill } from '../types';
import { isChooseMultipleQuestionType } from './numbering';

export const EXPECTED_OBJECTIVE_QUESTION_COUNT = 40;

const EXPECTED_PART_TOTALS: Partial<Record<TestSkill, number>> = {
  reading: 3,
  listening: 4,
};

function toPositiveInt(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return next > 0 ? Math.floor(next) : fallback;
}

export function countQuestionSlots(parts: TestPart[]): number {
  return (parts || []).reduce((partTotal, part) => {
    const groupTotal = (part.questionTypes || []).reduce((total, questionType) => {
      if (isChooseMultipleQuestionType(questionType.type)) {
        return total + (questionType.questions || []).reduce((choiceTotal, question) => {
          return choiceTotal + toPositiveInt((question as { choiceCount?: number }).choiceCount, 3);
        }, 0);
      }

      if (Array.isArray(questionType.questions) && questionType.questions.length > 0) {
        return total + questionType.questions.length;
      }

      return total + toPositiveInt(questionType.questionCount, 0);
    }, 0);

    return partTotal + groupTotal;
  }, 0);
}

export function countPartQuestionSlots(part: TestPart): number {
  return countQuestionSlots([part]);
}

export function getExpectedQuestionCount(skill: TestSkill | null): number | null {
  if (skill === 'reading' || skill === 'listening') {
    return EXPECTED_OBJECTIVE_QUESTION_COUNT;
  }

  return null;
}

export function getExpectedPartCount(skill: TestSkill | null): number | null {
  return skill ? EXPECTED_PART_TOTALS[skill] || null : null;
}

export function buildObjectiveExtractionWarnings(skill: TestSkill, parts: TestPart[]): ExtractionWarning[] {
  const expectedTotal = getExpectedQuestionCount(skill);
  if (!expectedTotal) return [];

  const warnings: ExtractionWarning[] = [];
  const total = countQuestionSlots(parts);

  if (total !== expectedTotal) {
    warnings.push({
      code: 'QUESTION_COUNT_MISMATCH',
      message: `Expected ${expectedTotal} question slots for ${skill}, but extraction produced ${total}. Review the source preview and re-run extraction before submitting.`,
      path: 'parts',
    });
  }

  const expectedPartTotal = getExpectedPartCount(skill);
  if (expectedPartTotal && parts.length !== expectedPartTotal) {
    warnings.push({
      code: 'PART_COUNT_MISMATCH',
      message: `Expected ${expectedPartTotal} ${skill} parts, but extraction produced ${parts.length}.`,
      path: 'parts',
    });
  }

  return warnings;
}
