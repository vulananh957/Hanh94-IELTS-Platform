import { create } from 'zustand';
import { buildAnswerKeyFromParts, generateAnswerKey } from '../lib/answer-key';
import { calculateQuestionNumbers, isChooseMultipleQuestionType } from '../lib/numbering';
import type {
  CreateTestPayload,
  DraftSkill,
  ExtractedTestPayload,
  ExtractionConfidence,
  ExtractionWarning,
  TestClassAssignment,
  TestDraft,
  TestPart,
  TestQuestion,
  TestQuestionType,
  TestSkill,
  UploadFileBucket,
  UploadFileRef,
  WritingRule,
} from '../types';

export type UploadStep = 1 | 2 | 3 | 4;

export type ExtractionStatus = 'idle' | 'loading' | 'success' | 'error';

interface ExtractionState {
  status: ExtractionStatus;
  pageRange: string;
  warnings: ExtractionWarning[];
  confidence: ExtractionConfidence[];
  errorMessage: string | null;
  lastExtractedAt: number | null;
}

interface CreatePayloadSnapshot {
  skill?: DraftSkill;
  testName?: string;
  writingRule?: WritingRule | null;
  classAssignment?: TestClassAssignment;
}

interface UploadTestStore {
  step: UploadStep;
  draft: TestDraft;
  extraction: ExtractionState;
  answerKeyPreview: Record<string, string[]>;
  setStep: (step: UploadStep) => void;
  setSkill: (skill: DraftSkill) => void;
  setTestName: (testName: string) => void;
  setWritingRule: (writingRule: WritingRule | null) => void;
  setClassAssignment: (classAssignment: TestClassAssignment) => void;
  setDistribution: (distribution: TestClassAssignment['distribution']) => void;
  setSelectedClasses: (classIds: string[]) => void;
  setFilesForBucket: (bucket: keyof UploadFileBucket, files: UploadFileRef[]) => void;
  setParts: (parts: TestPart[]) => void;
  addQuestionType: (partIndex: number, type: TestQuestionType['type']) => void;
  removeQuestionType: (partIndex: number, questionTypeIndex: number) => void;
  changeQuestionType: (partIndex: number, questionTypeIndex: number, nextType: TestQuestionType['type']) => void;
  updateQuestionType: (
    partIndex: number,
    questionTypeIndex: number,
    patch: Partial<TestQuestionType>,
  ) => void;
  addQuestion: (partIndex: number, questionTypeIndex: number) => void;
  removeQuestion: (partIndex: number, questionTypeIndex: number, questionIndex: number) => void;
  updateQuestion: (
    partIndex: number,
    questionTypeIndex: number,
    questionIndex: number,
    patch: Partial<TestQuestion>,
  ) => void;
  addOption: (partIndex: number, questionTypeIndex: number, questionIndex: number) => void;
  removeOption: (
    partIndex: number,
    questionTypeIndex: number,
    questionIndex: number,
    optionIndex: number,
  ) => void;
  applyExtractionResult: (payload: ExtractedTestPayload, pageRange: string) => void;
  setExtractionLoading: (pageRange: string) => void;
  setExtractionError: (message: string) => void;
  buildCreateTestPayload: (
    uploadedFiles: Record<string, string[]>,
    partsOverride?: TestPart[],
    snapshot?: CreatePayloadSnapshot,
  ) => CreateTestPayload | null;
  resetDraft: () => void;
}

function createInitialDraft(): TestDraft {
  return {
    skill: null,
    testName: '',
    files: {},
    parts: [],
    writingRule: null,
    classAssignment: {
      distribution: 'all',
      selectedClasses: [],
    },
  };
}

function createInitialExtractionState(): ExtractionState {
  return {
    status: 'idle',
    pageRange: '',
    warnings: [],
    confidence: [],
    errorMessage: null,
    lastExtractedAt: null,
  };
}

function refreshDerived(parts: TestPart[]) {
  const numberedParts = calculateQuestionNumbers(parts);
  const answerKeyPreview = buildAnswerKeyFromParts(numberedParts);

  return {
    numberedParts,
    answerKeyPreview,
  };
}

function ensureValidSkill(skill: DraftSkill): skill is TestSkill {
  return skill === 'reading' || skill === 'listening' || skill === 'writing';
}

function isSingleChoiceQuestionType(type: string): boolean {
  return /multiple choice.*single answer/i.test(type);
}

function toLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function toPositiveInt(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.floor(next);
}

function normalizeOptions(input: unknown, fallbackCount = 4): string[] {
  if (Array.isArray(input) && input.length > 0) {
    return input.map((value) => String(value ?? ''));
  }

  return Array.from({ length: fallbackCount }, () => '');
}

function createQuestionFromType(type: string, source?: TestQuestion): TestQuestion {
  const questionText = String((source as { question?: string })?.question ?? '');

  if (isChooseMultipleQuestionType(type)) {
    const nextOptions = normalizeOptions((source as { options?: string[] })?.options, 6);
    const choiceCount = toPositiveInt((source as { choiceCount?: number })?.choiceCount, 2);
    const optionCount = Math.max(toPositiveInt((source as { optionCount?: number })?.optionCount, nextOptions.length), 2);
    const existingAnswers = Array.isArray((source as { correctAnswers?: string[] })?.correctAnswers)
      ? ((source as { correctAnswers?: string[] }).correctAnswers || []).map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [];

    return {
      question: questionText,
      instructions: String((source as { instructions?: string })?.instructions ?? ''),
      choiceCount,
      optionCount,
      options: nextOptions,
      correctAnswers: Array.from(new Set(existingAnswers)).slice(0, choiceCount),
    };
  }

  if (isSingleChoiceQuestionType(type)) {
    const nextOptions = normalizeOptions((source as { options?: string[] })?.options, 4);
    const maybeAnswer = String((source as { correctAnswer?: string })?.correctAnswer ?? '').trim().toUpperCase();

    return {
      question: questionText,
      options: nextOptions,
      correctAnswer: maybeAnswer,
    };
  }

  if (/matching headings/i.test(type)) {
    return {
      question: questionText,
      paragraphLetter: String((source as { paragraphLetter?: string })?.paragraphLetter ?? '').trim().toUpperCase(),
      correctHeading: String((source as { correctHeading?: string })?.correctHeading ?? '').trim().toLowerCase(),
    };
  }

  if (/matching sentence endings/i.test(type)) {
    return {
      question: questionText,
      correctEnding: String((source as { correctEnding?: string })?.correctEnding ?? '').trim().toUpperCase(),
    };
  }

  return {
    question: questionText,
    correctAnswer: String((source as { correctAnswer?: string })?.correctAnswer ?? '').trim(),
  };
}

function createQuestionType(type: TestQuestionType['type']): TestQuestionType {
  return {
    type,
    questionCount: 1,
    questions: [createQuestionFromType(type)],
  };
}

function applyPartsUpdate(
  currentParts: TestPart[],
  updater: (parts: TestPart[]) => TestPart[],
): { numberedParts: TestPart[]; answerKeyPreview: Record<string, string[]> } {
  const nextParts = updater(currentParts);
  return refreshDerived(nextParts);
}

function toNonEmptyString(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function toPositiveInteger(value: unknown, min = 1): number | undefined {
  const next = Number(value);
  if (!Number.isFinite(next)) return undefined;

  const intValue = Math.floor(next);
  if (intValue < min) return undefined;
  return intValue;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const next = Number(value);
  if (!Number.isFinite(next)) return undefined;

  const intValue = Math.floor(next);
  if (intValue < 0) return undefined;
  return intValue;
}

function sanitizeImageRef(value: unknown): { src: string; name: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const record = value as { src?: unknown; name?: unknown };
  const src = toNonEmptyString(record.src);
  const name = toNonEmptyString(record.name);

  if (!src || !name) return undefined;
  return { src, name };
}

function sanitizeQuestionForCreate(question: TestQuestion): TestQuestion | null {
  const source = (question || {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  const questionText = toNonEmptyString(source.question);
  if (questionText) next.question = questionText;

  const instructions = toNonEmptyString(source.instructions);
  if (instructions) next.instructions = instructions;

  const choiceCount = toPositiveInteger(source.choiceCount, 1);
  if (choiceCount) next.choiceCount = choiceCount;

  const optionCount = toPositiveInteger(source.optionCount, 2);
  if (optionCount) next.optionCount = optionCount;

  const options = Array.isArray(source.options)
    ? Array.from(new Set(source.options.map((item) => String(item ?? '').trim()).filter(Boolean)))
    : [];
  if (options.length > 0) next.options = options;

  const correctAnswers = Array.isArray(source.correctAnswers)
    ? Array.from(new Set(source.correctAnswers.map((item) => String(item ?? '').trim()).filter(Boolean)))
    : [];
  if (correctAnswers.length > 0) next.correctAnswers = correctAnswers;

  const correctAnswer = toNonEmptyString(source.correctAnswer);
  if (correctAnswer) next.correctAnswer = correctAnswer;

  const correctHeading = toNonEmptyString(source.correctHeading);
  if (correctHeading) next.correctHeading = correctHeading;

  const paragraphLetter = toNonEmptyString(source.paragraphLetter);
  if (paragraphLetter) next.paragraphLetter = paragraphLetter;

  const correctEnding = toNonEmptyString(source.correctEnding);
  if (correctEnding) next.correctEnding = correctEnding;

  const wordBank = toNonEmptyString(source.wordBank);
  if (wordBank) next.wordBank = wordBank;

  const imageData = sanitizeImageRef(source.imageData);
  if (imageData) next.imageData = imageData;

  return Object.keys(next).length > 0 ? (next as TestQuestion) : null;
}

function sanitizeQuestionTypeForCreate(questionType: TestQuestionType): TestQuestionType | null {
  const sanitizedQuestions = (questionType.questions || [])
    .map((question) => sanitizeQuestionForCreate(question))
    .filter((question): question is TestQuestion => question !== null);

  if (sanitizedQuestions.length === 0) {
    return null;
  }

  const sanitizedQuestionType: TestQuestionType = {
    type: questionType.type,
    questionCount: sanitizedQuestions.length,
    questions: sanitizedQuestions,
  };

  const instructions = toNonEmptyString(questionType.instructions);
  if (instructions) sanitizedQuestionType.instructions = instructions;

  const headingsList = toNonEmptyString(questionType.headingsList);
  if (headingsList) sanitizedQuestionType.headingsList = headingsList;

  const headingCount = toNonNegativeInteger(questionType.headingCount);
  if (headingCount !== undefined) sanitizedQuestionType.headingCount = headingCount;

  const featuresList = toNonEmptyString(questionType.featuresList);
  if (featuresList) sanitizedQuestionType.featuresList = featuresList;

  const endingsList = toNonEmptyString(questionType.endingsList);
  if (endingsList) sanitizedQuestionType.endingsList = endingsList;

  const summaryText = toNonEmptyString(questionType.summaryText);
  if (summaryText) sanitizedQuestionType.summaryText = summaryText;

  if (typeof questionType.hasWordBank === 'boolean') {
    sanitizedQuestionType.hasWordBank = questionType.hasWordBank;
  }

  const wordBank = toNonEmptyString(questionType.wordBank);
  if (wordBank) sanitizedQuestionType.wordBank = wordBank;

  const imageData = sanitizeImageRef(questionType.imageData);
  if (imageData) sanitizedQuestionType.imageData = imageData;

  const startNumber = toPositiveInteger(questionType.startNumber, 1);
  if (startNumber !== undefined) sanitizedQuestionType.startNumber = startNumber;

  const endNumber = toPositiveInteger(questionType.endNumber, 1);
  if (endNumber !== undefined) sanitizedQuestionType.endNumber = endNumber;

  return sanitizedQuestionType;
}

function sanitizePartsForCreate(parts: TestPart[]): TestPart[] {
  return (parts || [])
    .map((part, partIndex) => {
      const sanitizedQuestionTypes = (part.questionTypes || [])
        .map((questionType) => sanitizeQuestionTypeForCreate(questionType))
        .filter((questionType): questionType is TestQuestionType => questionType !== null);

      if (sanitizedQuestionTypes.length === 0) {
        return null;
      }

      return {
        name: toNonEmptyString(part.name) || `Part ${partIndex + 1}`,
        questionTypes: sanitizedQuestionTypes,
      } as TestPart;
    })
    .filter((part): part is TestPart => part !== null);
}

export const useUploadTestStore = create<UploadTestStore>((set, get) => ({
  step: 1,
  draft: createInitialDraft(),
  extraction: createInitialExtractionState(),
  answerKeyPreview: {},

  setStep: (step) => set({ step }),

  setSkill: (skill) =>
    set((state) => ({
      draft: {
        ...state.draft,
        skill,
      },
    })),

  setTestName: (testName) =>
    set((state) => ({
      draft: {
        ...state.draft,
        testName,
      },
    })),

  setWritingRule: (writingRule) =>
    set((state) => ({
      draft: {
        ...state.draft,
        writingRule,
      },
    })),

  setClassAssignment: (classAssignment) =>
    set((state) => ({
      draft: {
        ...state.draft,
        classAssignment,
      },
    })),

  setDistribution: (distribution) =>
    set((state) => ({
      draft: {
        ...state.draft,
        classAssignment: {
          ...state.draft.classAssignment,
          distribution,
          selectedClasses: distribution === 'all' ? [] : state.draft.classAssignment.selectedClasses,
        },
      },
    })),

  setSelectedClasses: (classIds) =>
    set((state) => ({
      draft: {
        ...state.draft,
        classAssignment: {
          ...state.draft.classAssignment,
          selectedClasses: Array.from(new Set(classIds.map((item) => item.trim()).filter(Boolean))),
        },
      },
    })),

  setFilesForBucket: (bucket, files) =>
    set((state) => ({
      draft: {
        ...state.draft,
        files: {
          ...state.draft.files,
          [bucket]: files,
        },
      },
    })),

  setParts: (parts) => {
    const { numberedParts, answerKeyPreview } = refreshDerived(parts);

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  addQuestionType: (partIndex, type) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: [...part.questionTypes, createQuestionType(type)],
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  removeQuestionType: (partIndex, questionTypeIndex) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.filter((_, qtIndex) => qtIndex !== questionTypeIndex),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  changeQuestionType: (partIndex, questionTypeIndex, nextType) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.map((questionType, qtIndex) => {
            if (qtIndex !== questionTypeIndex) return questionType;

            const nextQuestions = (questionType.questions || []).map((question) =>
              createQuestionFromType(nextType, question),
            );

            return {
              ...questionType,
              type: nextType,
              questions: nextQuestions.length > 0 ? nextQuestions : [createQuestionFromType(nextType)],
              questionCount: nextQuestions.length > 0 ? nextQuestions.length : 1,
            };
          }),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  updateQuestionType: (partIndex, questionTypeIndex, patch) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.map((questionType, qtIndex) => {
            if (qtIndex !== questionTypeIndex) return questionType;
            return {
              ...questionType,
              ...patch,
            };
          }),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  addQuestion: (partIndex, questionTypeIndex) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.map((questionType, qtIndex) => {
            if (qtIndex !== questionTypeIndex) return questionType;

            const questions = [...(questionType.questions || [])];
            questions.push(createQuestionFromType(questionType.type));

            return {
              ...questionType,
              questions,
              questionCount: questions.length,
            };
          }),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  removeQuestion: (partIndex, questionTypeIndex, questionIndex) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.map((questionType, qtIndex) => {
            if (qtIndex !== questionTypeIndex) return questionType;

            const questions = (questionType.questions || []).filter((_, qIndex) => qIndex !== questionIndex);

            return {
              ...questionType,
              questions,
              questionCount: questions.length,
            };
          }),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  addOption: (partIndex, questionTypeIndex, questionIndex) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.map((questionType, qtIndex) => {
            if (qtIndex !== questionTypeIndex) return questionType;

            const questions = [...(questionType.questions || [])];
            const existing = questions[questionIndex] || {};
            const options = normalizeOptions((existing as { options?: string[] }).options, 0);
            options.push('');

            const nextQuestion = {
              ...(existing as Record<string, unknown>),
              options,
            } as Record<string, unknown>;

            if (isChooseMultipleQuestionType(questionType.type)) {
              nextQuestion.optionCount = options.length;
            }

            questions[questionIndex] = nextQuestion as TestQuestion;

            return {
              ...questionType,
              questions,
            };
          }),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  removeOption: (partIndex, questionTypeIndex, questionIndex, optionIndex) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.map((questionType, qtIndex) => {
            if (qtIndex !== questionTypeIndex) return questionType;

            const questions = [...(questionType.questions || [])];
            const existing = questions[questionIndex] || {};
            const options = normalizeOptions((existing as { options?: string[] }).options, 0)
              .filter((_, index) => index !== optionIndex);

            const nextQuestion = {
              ...(existing as Record<string, unknown>),
              options,
            } as Record<string, unknown>;

            if (isChooseMultipleQuestionType(questionType.type)) {
              const nextOptionCount = Math.max(options.length, 2);
              const currentChoiceCount = toPositiveInt((existing as { choiceCount?: number }).choiceCount, 2);
              nextQuestion.optionCount = nextOptionCount;
              nextQuestion.choiceCount = Math.min(currentChoiceCount, nextOptionCount);

              const validLetters = new Set(options.map((_, index) => toLetter(index)));
              const currentCorrect = Array.isArray((existing as { correctAnswers?: string[] }).correctAnswers)
                ? ((existing as { correctAnswers?: string[] }).correctAnswers || [])
                : [];
              nextQuestion.correctAnswers = currentCorrect.filter((value) => validLetters.has(String(value || '').toUpperCase()));
            }

            if (isSingleChoiceQuestionType(questionType.type)) {
              const answer = String((existing as { correctAnswer?: string }).correctAnswer || '').toUpperCase();
              const validLetters = new Set(options.map((_, index) => toLetter(index)));
              nextQuestion.correctAnswer = validLetters.has(answer) ? answer : '';
            }

            questions[questionIndex] = nextQuestion as TestQuestion;

            return {
              ...questionType,
              questions,
            };
          }),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  updateQuestion: (partIndex, questionTypeIndex, questionIndex, patch) => {
    const { numberedParts, answerKeyPreview } = applyPartsUpdate(get().draft.parts, (parts) =>
      parts.map((part, pIndex) => {
        if (pIndex !== partIndex) return part;

        return {
          ...part,
          questionTypes: part.questionTypes.map((questionType, qtIndex) => {
            if (qtIndex !== questionTypeIndex) return questionType;

            const questions = [...questionType.questions];
            const existingQuestion = questions[questionIndex] || {};
            questions[questionIndex] = {
              ...existingQuestion,
              ...patch,
            };

            return {
              ...questionType,
              questions,
              questionCount: Math.max(questionType.questionCount, questions.length),
            };
          }),
        };
      }),
    );

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
    }));
  },

  applyExtractionResult: (payload, pageRange) => {
    const { numberedParts, answerKeyPreview } = refreshDerived(payload.parts);

    set((state) => ({
      draft: {
        ...state.draft,
        parts: numberedParts,
      },
      answerKeyPreview,
      extraction: {
        status: 'success',
        pageRange,
        warnings: payload.warnings,
        confidence: payload.confidence,
        errorMessage: null,
        lastExtractedAt: Date.now(),
      },
    }));
  },

  setExtractionLoading: (pageRange) =>
    set((state) => ({
      extraction: {
        ...state.extraction,
        status: 'loading',
        pageRange,
        warnings: [],
        confidence: [],
        errorMessage: null,
      },
    })),

  setExtractionError: (message) =>
    set((state) => ({
      extraction: {
        ...state.extraction,
        status: 'error',
        errorMessage: message,
      },
    })),

  buildCreateTestPayload: (uploadedFiles, partsOverride, snapshot) => {
    const state = get();
    const skillCandidate = snapshot?.skill ?? state.draft.skill;
    if (!ensureValidSkill(skillCandidate)) {
      return null;
    }
    const skill = skillCandidate;
    const resolvedTestName = String(snapshot?.testName ?? state.draft.testName ?? '').trim();

    if (!resolvedTestName) {
      return null;
    }

    const sourceParts = Array.isArray(partsOverride) ? partsOverride : (state.draft.parts || []);
    const normalizedParts = calculateQuestionNumbers(sourceParts);
    const sanitizedParts = sanitizePartsForCreate(normalizedParts);
    if (skill !== 'writing' && sanitizedParts.length === 0) {
      return null;
    }

    const finalParts = sanitizedParts.length > 0 ? calculateQuestionNumbers(sanitizedParts) : [];
    const answerKey = generateAnswerKey(finalParts);

    const sanitizedFiles = Object.fromEntries(
      Object.entries(uploadedFiles || {})
        .map(([key, urls]) => [key, Array.isArray(urls) ? urls.map((url) => String(url || '').trim()).filter(Boolean) : []])
        .filter(([, urls]) => (urls as string[]).length > 0),
    ) as Record<string, string[]>;

    const sourceClassAssignment = snapshot?.classAssignment ?? state.draft.classAssignment;

    const selectedClasses = Array.from(
      new Set((sourceClassAssignment.selectedClasses || []).map((id) => String(id || '').trim()).filter(Boolean)),
    );

    const classAssignment: TestClassAssignment = {
      distribution: sourceClassAssignment.distribution === 'specific' ? 'specific' : 'all',
      selectedClasses,
    };

    return {
      name: resolvedTestName,
      skill,
      metadata: {
        parts: finalParts,
      },
      files: sanitizedFiles,
      answerKey,
      writingRule: snapshot?.writingRule ?? state.draft.writingRule ?? null,
      classAssignment,
    };
  },

  resetDraft: () =>
    set({
      step: 1,
      draft: createInitialDraft(),
      extraction: createInitialExtractionState(),
      answerKeyPreview: {},
    }),
}));
