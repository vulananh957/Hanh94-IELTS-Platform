import { z } from 'zod';
import { isLegacyQuestionType, type LegacyQuestionType } from './types';

export const PAGE_RANGE_PATTERN = /^all$|^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/i;

export const ExtractRequestSchema = z.object({
  skill: z.enum(['reading', 'listening']),
  pageRange: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return 'all';
      }

      const trimmed = value.trim();
      return trimmed || 'all';
    },
    z.string().trim().regex(PAGE_RANGE_PATTERN, {
      message: 'Invalid pageRange format. Example: 1-5,8,10-12 or all.',
    }),
  ),
});

export const ImageRefSchema = z.object({
  src: z.string().trim().min(1),
  name: z.string().trim().min(1),
}).strict();

export const TestQuestionSchema = z.object({
  question: z.string().trim().optional(),
  instructions: z.string().trim().optional(),
  choiceCount: z.number().int().min(1).max(10).optional(),
  optionCount: z.number().int().min(2).max(12).optional(),
  options: z.array(z.string().trim()).max(20).optional(),
  correctAnswers: z.array(z.string().trim().min(1)).max(10).optional(),
  correctAnswer: z.string().trim().optional(),
  correctHeading: z.string().trim().optional(),
  paragraphLetter: z.string().trim().optional(),
  correctEnding: z.string().trim().optional(),
  wordBank: z.string().trim().optional(),
  imageData: ImageRefSchema.optional(),
}).strict();

const LegacyQuestionTypeSchema = z.string().trim().refine(
  (value): value is LegacyQuestionType => isLegacyQuestionType(value),
  'Unsupported question type.',
).transform((value) => value as LegacyQuestionType);

export const TestQuestionTypeSchema = z.object({
  type: LegacyQuestionTypeSchema,
  questionCount: z.number().int().min(0),
  startNumber: z.number().int().min(1).optional(),
  endNumber: z.number().int().min(0).optional(),
  instructions: z.string().trim().optional(),
  headingsList: z.string().trim().optional(),
  headingCount: z.number().int().min(0).optional(),
  featuresList: z.string().trim().optional(),
  endingsList: z.string().trim().optional(),
  summaryText: z.string().trim().optional(),
  hasWordBank: z.boolean().optional(),
  wordBank: z.string().trim().optional(),
  imageData: ImageRefSchema.optional(),
  questions: z.array(TestQuestionSchema).default([]),
}).strict();

export const TestPartSchema = z.object({
  name: z.string().trim().min(1),
  questionTypes: z.array(TestQuestionTypeSchema).default([]),
}).strict();

export const ExtractionWarningSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  path: z.string().trim().optional(),
}).strict();

export const ExtractionConfidenceSchema = z.object({
  path: z.string().trim().min(1),
  score: z.number().min(0).max(1),
}).strict();

export const NormalizedExtractedPayloadSchema = z.object({
  parts: z.array(TestPartSchema).min(1),
  warnings: z.array(ExtractionWarningSchema).default([]),
  confidence: z.array(ExtractionConfidenceSchema).default([]),
}).strict();

export const RawQuestionSchema = z.object({
  question: z.string().trim().optional(),
  instructions: z.string().trim().optional(),
  choiceCount: z.number().int().min(1).max(10).optional(),
  optionCount: z.number().int().min(2).max(12).optional(),
  options: z.array(z.string()).optional(),
  correctAnswers: z.array(z.string()).optional(),
  correctAnswer: z.string().optional(),
  correctHeading: z.string().optional(),
  paragraphLetter: z.string().optional(),
  correctEnding: z.string().optional(),
  wordBank: z.string().optional(),
  imageData: ImageRefSchema.optional(),
}).strict();

export const RawQuestionTypeSchema = z.object({
  type: z.string().trim().min(1),
  questionCount: z.number().int().min(0).optional(),
  startNumber: z.number().int().min(1).optional(),
  endNumber: z.number().int().min(0).optional(),
  instructions: z.string().optional(),
  headingsList: z.string().optional(),
  headingCount: z.number().int().min(0).optional(),
  featuresList: z.string().optional(),
  endingsList: z.string().optional(),
  summaryText: z.string().optional(),
  hasWordBank: z.boolean().optional(),
  wordBank: z.string().optional(),
  imageData: ImageRefSchema.optional(),
  questions: z.array(RawQuestionSchema).default([]),
}).strict();

export const RawPartSchema = z.object({
  name: z.string().trim().optional(),
  questionTypes: z.array(RawQuestionTypeSchema).default([]),
}).strict();

export const RawExtractedPayloadSchema = z.object({
  parts: z.array(RawPartSchema).min(1),
  warnings: z.array(ExtractionWarningSchema).default([]),
  confidence: z.array(ExtractionConfidenceSchema).default([]),
}).strict();

export const CreateTestPayloadSchema = z.object({
  name: z.string().trim().min(1),
  skill: z.enum(['reading', 'listening', 'writing']),
  metadata: z.object({
    parts: z.array(TestPartSchema),
  }).strict(),
  files: z.record(z.string(), z.array(z.string().trim().min(1))),
  answerKey: z.record(z.string(), z.array(z.string().trim().min(1))),
  writingRule: z.enum(['auto-submit', 'overtime']).nullable(),
  classAssignment: z.object({
    distribution: z.enum(['all', 'specific']),
    selectedClasses: z.array(z.string().trim().min(1)),
  }).strict(),
}).strict();

export type ExtractRequestInput = z.infer<typeof ExtractRequestSchema>;
export type RawExtractedPayload = z.infer<typeof RawExtractedPayloadSchema>;
export type NormalizedExtractedPayload = z.infer<typeof NormalizedExtractedPayloadSchema>;
