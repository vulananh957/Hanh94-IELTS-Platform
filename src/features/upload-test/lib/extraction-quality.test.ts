import { describe, expect, it } from 'vitest';
import type { LegacyQuestionType, TestPart } from '../types';
import {
  buildObjectiveExtractionWarnings,
  countQuestionSlots,
  getExpectedPartCount,
  getExpectedQuestionCount,
} from './extraction-quality';

const sentenceCompletion = 'Sentence Completion' as LegacyQuestionType;
const chooseMultiple = 'Multiple Choice (Choose Multiple)' as LegacyQuestionType;

function partWithQuestionCount(name: string, count: number): TestPart {
  return {
    name,
    questionTypes: [
      {
        type: sentenceCompletion,
        questionCount: count,
        questions: Array.from({ length: count }, (_, index) => ({
          question: `Question ${index + 1}`,
          correctAnswer: `answer-${index + 1}`,
        })),
      },
    ],
  };
}

describe('extraction quality checks', () => {
  it('counts objective question slots across reading parts', () => {
    const parts = [
      partWithQuestionCount('Reading Passage 1', 12),
      partWithQuestionCount('Reading Passage 2', 15),
      partWithQuestionCount('Reading Passage 3', 13),
    ];

    expect(getExpectedQuestionCount('reading')).toBe(40);
    expect(getExpectedPartCount('reading')).toBe(3);
    expect(countQuestionSlots(parts)).toBe(40);
    expect(buildObjectiveExtractionWarnings('reading', parts)).toEqual([]);
  });

  it('warns when reading extraction silently misses part 1 questions 7-13', () => {
    const parts = [
      partWithQuestionCount('Reading Passage 1', 6),
      partWithQuestionCount('Reading Passage 2', 13),
      partWithQuestionCount('Reading Passage 3', 14),
    ];

    const warnings = buildObjectiveExtractionWarnings('reading', parts);

    expect(countQuestionSlots(parts)).toBe(33);
    expect(warnings.map((warning) => warning.code)).toEqual(['QUESTION_COUNT_MISMATCH']);
    expect(warnings[0].message).toContain('Expected 40 question slots');
  });

  it('warns for missing reading passages without enforcing per-part question distribution', () => {
    const parts = [
      partWithQuestionCount('Reading Passage 1', 20),
      partWithQuestionCount('Reading Passage 2', 20),
    ];

    const warnings = buildObjectiveExtractionWarnings('reading', parts);

    expect(countQuestionSlots(parts)).toBe(40);
    expect(warnings.map((warning) => warning.code)).toEqual(['PART_COUNT_MISMATCH']);
    expect(warnings[0].message).toContain('Expected 3 reading parts');
  });

  it('counts choose-multiple blocks by required choices, not object count', () => {
    const parts: TestPart[] = [
      {
        name: 'Reading Passage 1',
        questionTypes: [
          {
            type: chooseMultiple,
            questionCount: 2,
            questions: [
              {
                question: 'Choose TWO letters.',
                choiceCount: 2,
                options: ['A', 'B', 'C', 'D'],
                correctAnswers: ['A', 'C'],
              },
              {
                question: 'Choose THREE letters.',
                choiceCount: 3,
                options: ['A', 'B', 'C', 'D', 'E'],
                correctAnswers: ['B', 'D', 'E'],
              },
            ],
          },
        ],
      },
    ];

    expect(countQuestionSlots(parts)).toBe(5);
  });
});
