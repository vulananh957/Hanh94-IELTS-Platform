export type TestSkill = 'reading' | 'listening' | 'writing';

export type DraftSkill = TestSkill | null;

export type WritingRule = 'auto-submit' | 'overtime';

export type Distribution = 'all' | 'specific';

export const LEGACY_READING_QUESTION_TYPES = [
  'Matching Information',
  'Multiple Choice (Choose Multiple)',
  'Matching Headings',
  'Matching Features',
  'Multiple Choice (Single Answer)',
  'True / False / Not Given',
  'Yes / No / Not Given',
  'Summary Completion',
  'Sentence Completion',
  'Matching Sentence Endings',
  'Diagram / Flow-chart / Table / Note Completion',
  'Short Answer Questions',
] as const;

export const LEGACY_LISTENING_QUESTION_TYPES = [
  'Multiple Choice Questions (Single Answer)',
  'Multiple Choice Questions (Choose Multiple)',
  'Sentence Completion & Summary Completion',
  'Form / Note / Table / Flow-chart / Map / Diagram / Summary Completion',
  'Matching (Info/Features/Sentence Halves)',
  'Short Answer Questions',
  'Pick from a List',
] as const;

export const LEGACY_QUESTION_TYPES = [
  ...LEGACY_READING_QUESTION_TYPES,
  ...LEGACY_LISTENING_QUESTION_TYPES,
] as const;

export type LegacyReadingQuestionType = (typeof LEGACY_READING_QUESTION_TYPES)[number];
export type LegacyListeningQuestionType = (typeof LEGACY_LISTENING_QUESTION_TYPES)[number];
export type LegacyQuestionType = (typeof LEGACY_QUESTION_TYPES)[number];

const LEGACY_QUESTION_TYPE_SET = new Set<string>(LEGACY_QUESTION_TYPES);

export function isLegacyQuestionType(value: string): value is LegacyQuestionType {
  return LEGACY_QUESTION_TYPE_SET.has(value);
}

export interface ImageRef {
  src: string;
  name: string;
}

export interface QuestionBase {
  question?: string;
  imageData?: ImageRef;
}

export interface SingleChoiceQuestion extends QuestionBase {
  options?: string[];
  correctAnswer?: string;
}

export interface ChooseMultipleQuestion extends QuestionBase {
  instructions?: string;
  choiceCount?: number;
  optionCount?: number;
  options?: string[];
  correctAnswers?: string[];
}

export interface MatchingHeadingsQuestion extends QuestionBase {
  paragraphLetter?: string;
  correctHeading?: string;
}

export interface MatchingSentenceEndingsQuestion extends QuestionBase {
  correctEnding?: string;
}

export interface GenericAnswerQuestion extends QuestionBase {
  correctAnswer?: string;
  wordBank?: string;
}

export type TestQuestion =
  | SingleChoiceQuestion
  | ChooseMultipleQuestion
  | MatchingHeadingsQuestion
  | MatchingSentenceEndingsQuestion
  | GenericAnswerQuestion;

export interface TestQuestionType {
  type: LegacyQuestionType;
  questionCount: number;
  startNumber?: number;
  endNumber?: number;
  instructions?: string;
  headingsList?: string;
  headingCount?: number;
  featuresList?: string;
  endingsList?: string;
  summaryText?: string;
  hasWordBank?: boolean;
  wordBank?: string;
  imageData?: ImageRef;
  questions: TestQuestion[];
}

export interface TestPart {
  name: string;
  questionTypes: TestQuestionType[];
}

export interface UploadFileRef {
  name: string;
  type?: string;
  size?: number;
  file?: File;
  dataUrl?: string;
  url?: string;
}

export type UploadFileBucket = Partial<
  Record<
    | 'reading'
    | 'listeningPart1'
    | 'listeningPart2'
    | 'listeningPart3'
    | 'listeningPart4'
    | 'writingTask1'
    | 'writingTask2'
    | 'sourceDocument',
    UploadFileRef[]
  >
>;

export interface TestClassAssignment {
  distribution: Distribution;
  selectedClasses: string[];
}

export interface TestDraft {
  skill: DraftSkill;
  testName: string;
  files: UploadFileBucket;
  parts: TestPart[];
  writingRule: WritingRule | null;
  classAssignment: TestClassAssignment;
}

export interface CreateTestPayload {
  name: string;
  skill: TestSkill;
  metadata: {
    parts: TestPart[];
  };
  files: Record<string, string[]>;
  answerKey: Record<string, string[]>;
  writingRule: WritingRule | null;
  classAssignment: TestClassAssignment;
}

export interface ExtractionWarning {
  code: string;
  message: string;
  path?: string;
}

export interface ExtractionConfidence {
  path: string;
  score: number;
}

export interface ExtractedTestPayload {
  parts: TestPart[];
  warnings: ExtractionWarning[];
  confidence: ExtractionConfidence[];
}

export interface ExtractTestResponse {
  ok: true;
  data: ExtractedTestPayload;
}

export interface ExtractTestErrorResponse {
  ok: false;
  error: string;
  details?: string;
  issues?: string[];
}
