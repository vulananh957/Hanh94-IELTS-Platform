import {
  LEGACY_LISTENING_QUESTION_TYPES,
  LEGACY_READING_QUESTION_TYPES,
  type TestSkill,
} from '../types';

export const extractionResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['parts', 'warnings', 'confidence'],
  properties: {
    parts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'questionTypes'],
        properties: {
          name: { type: 'string' },
          questionTypes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'questionCount', 'questions'],
              properties: {
                type: { type: 'string' },
                questionCount: { type: 'integer', minimum: 0 },
                instructions: { type: 'string' },
                headingsList: { type: 'string' },
                headingCount: { type: 'integer', minimum: 0 },
                featuresList: { type: 'string' },
                endingsList: { type: 'string' },
                summaryText: { type: 'string' },
                hasWordBank: { type: 'boolean' },
                wordBank: { type: 'string' },
                questions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      question: { type: 'string' },
                      instructions: { type: 'string' },
                      choiceCount: { type: 'integer', minimum: 1, maximum: 10 },
                      optionCount: { type: 'integer', minimum: 2, maximum: 12 },
                      options: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                      correctAnswers: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                      correctAnswer: { type: 'string' },
                      correctHeading: { type: 'string' },
                      paragraphLetter: { type: 'string' },
                      correctEnding: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },
    confidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'score'],
        properties: {
          path: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

function getAllowedQuestionTypes(skill: Exclude<TestSkill, 'writing'>): readonly string[] {
  if (skill === 'reading') {
    return LEGACY_READING_QUESTION_TYPES;
  }

  return LEGACY_LISTENING_QUESTION_TYPES;
}

export function buildExtractionSystemPrompt(input: {
  skill: Exclude<TestSkill, 'writing'>;
  pageRange: string;
  fileName: string;
}): string {
  const allowedTypes = getAllowedQuestionTypes(input.skill);

  return [
    'You are an IELTS exam data extraction engine.',
    '',
    'Return JSON only. Do not wrap in markdown. Do not include prose.',
    'Use only the schema fields provided in responseJsonSchema.',
    '',
    `Skill context: ${input.skill}`,
    `Target file: ${input.fileName}`,
    `Page range to parse: ${input.pageRange}`,
    'Parse only the requested page range and ignore cover pages outside that range.',
    '',
    'Allowed question type labels (must match exactly one of these):',
    ...allowedTypes.map((item) => `- ${item}`),
    '',
    'Hard rules:',
    '1) Keep original wording from the document. Avoid paraphrasing.',
    '2) If a value is missing or unreadable, keep empty string and add an item to warnings.',
    '3) questionCount must match the number of objects in questions.',
    '4) For choose-multiple questions, include choiceCount, optionCount, options, and correctAnswers letters.',
    '5) For matching headings, use paragraphLetter and correctHeading.',
    '6) For matching sentence endings, use correctEnding.',
    '7) For headingsList, featuresList, endingsList, and wordBank, keep each option on its own line. Do not use comma-separated lists.',
    '8) For Matching Features / Pick from a List / Matching (Info/Features/Sentence Halves): every featuresList item must be exactly one option per line. If options are people names, keep exactly one full person name per line.',
    '9) For matching-style answers (correctHeading, correctEnding, correctAnswer in matching features/list types), return the option key only (for example: A, B, C, i, ii). Do not return full option text when a key exists.',
    '10) Keep warnings and confidence arrays present even when empty.',
    '11) If the task is map/plan/diagram/flow-chart/table/form/note/summary labeling or completion, ALWAYS classify as completion type (Form / Note / Table / Flow-chart / Map / Diagram / Summary Completion for listening, or Diagram / Flow-chart / Table / Note Completion for reading), NOT matching features/list types even when answers are option letters.',
    '',
    'Output JSON shape (keys only):',
    '{ parts: [...], warnings: [...], confidence: [...] }',
  ].join('\n');
}
