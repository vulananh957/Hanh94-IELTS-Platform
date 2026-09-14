import {
  LEGACY_LISTENING_QUESTION_TYPES,
  LEGACY_READING_QUESTION_TYPES,
  isLegacyQuestionType,
  type ExtractionWarning,
  type LegacyQuestionType,
  type TestQuestion,
  type TestQuestionType,
} from '../types';
import type { RawExtractedPayload } from '../schema';
import { buildObjectiveExtractionWarnings } from './extraction-quality';
import { calculateQuestionNumbers, isChooseMultipleQuestionType } from './numbering';

const SINGLE_CHOICE_TYPES = new Set<LegacyQuestionType>([
  'Multiple Choice (Single Answer)',
  'Multiple Choice Questions (Single Answer)',
]);

const MATCHING_HEADINGS_TYPE: LegacyQuestionType = 'Matching Headings';
const MATCHING_SENTENCE_ENDINGS_TYPE: LegacyQuestionType = 'Matching Sentence Endings';
const LISTENING_COMPLETION_TYPE: LegacyQuestionType = 'Form / Note / Table / Flow-chart / Map / Diagram / Summary Completion';
const READING_COMPLETION_TYPE: LegacyQuestionType = 'Diagram / Flow-chart / Table / Note Completion';

function isMatchingFeatureLikeType(type: LegacyQuestionType): boolean {
  return type === 'Matching Features'
    || type === 'Matching (Info/Features/Sentence Halves)'
    || type === 'Pick from a List';
}

const TYPE_SYNONYMS: Record<LegacyQuestionType, string[]> = {
  'Matching Information': ['matching information'],
  'Multiple Choice (Choose Multiple)': [
    'multiple choice choose multiple',
    'multiple choice (choose multiple)',
    'choose multiple',
  ],
  'Matching Headings': ['matching headings', 'heading matching'],
  'Matching Features': ['matching features', 'feature matching'],
  'Multiple Choice (Single Answer)': [
    'multiple choice single answer',
    'multiple choice (single answer)',
  ],
  'True / False / Not Given': ['true false not given', 'tfng', 't/f/ng'],
  'Yes / No / Not Given': ['yes no not given', 'y/n/ng'],
  'Summary Completion': ['summary completion'],
  'Sentence Completion': ['sentence completion'],
  'Matching Sentence Endings': ['matching sentence endings', 'sentence endings'],
  'Diagram / Flow-chart / Table / Note Completion': [
    'diagram flow chart table note completion',
    'diagram completion',
    'table completion',
    'flow chart completion',
    'note completion',
  ],
  'Short Answer Questions': ['short answer questions', 'short answer'],
  'Multiple Choice Questions (Single Answer)': [
    'multiple choice questions single answer',
    'multiple choice questions (single answer)',
  ],
  'Multiple Choice Questions (Choose Multiple)': [
    'multiple choice questions choose multiple',
    'multiple choice questions (choose multiple)',
  ],
  'Sentence Completion & Summary Completion': [
    'sentence completion and summary completion',
    'sentence completion summary completion',
  ],
  'Form / Note / Table / Flow-chart / Map / Diagram / Summary Completion': [
    'form note table flow chart map diagram summary completion',
    'form completion',
    'map completion',
    'plan map diagram labelling',
    'plan map diagram labeling',
    'map plan diagram labelling',
    'map plan diagram labeling',
    'map labelling',
    'map labeling',
    'plan labelling',
    'plan labeling',
    'diagram labelling',
    'diagram labeling',
  ],
  'Matching (Info/Features/Sentence Halves)': [
    'matching info features sentence halves',
    'matching sentence halves',
    'matching info features',
  ],
  'Pick from a List': ['pick from a list', 'list selection'],
};

const CANONICAL_TYPE_MAP = new Map<string, LegacyQuestionType>();
const READING_TYPE_SET = new Set<string>(LEGACY_READING_QUESTION_TYPES);
const LISTENING_TYPE_SET = new Set<string>(LEGACY_LISTENING_QUESTION_TYPES);

for (const questionType of [...LEGACY_READING_QUESTION_TYPES, ...LEGACY_LISTENING_QUESTION_TYPES]) {
  CANONICAL_TYPE_MAP.set(canonicalize(questionType), questionType);

  TYPE_SYNONYMS[questionType].forEach((alias) => {
    CANONICAL_TYPE_MAP.set(canonicalize(alias), questionType);
  });
}

function canonicalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toTrimmedString(value: unknown): string {
  return String(value || '').trim();
}

function toUpperTrimmed(value: unknown): string {
  return toTrimmedString(value).toUpperCase();
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function toLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function isRomanNumeralToken(value: string): boolean {
  return /^[ivxlcdm]+$/i.test(value);
}

function isSupportedLabelToken(value: string): boolean {
  const token = value.trim();
  if (!token) return false;
  if (/^\d{1,2}$/.test(token)) return true;
  if (/^[A-Za-z]$/.test(token)) return true;
  return token.length <= 7 && isRomanNumeralToken(token);
}

function splitInlineLabeledSegments(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  const starts: number[] = [];
  const pattern = /(?:^|\s)([A-Za-z]|\d{1,2}|[ivxlcdmIVXLCDM]{1,7})\s*[.)\-:]\s+/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const baseIndex = match.index;
    const startsWithSpace = raw.charAt(baseIndex) === ' ';
    starts.push(startsWithSpace ? baseIndex + 1 : baseIndex);
  }

  if (starts.length < 2 || starts[0] !== 0) {
    return [raw];
  }

  const segments: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : raw.length;
    const segment = raw.slice(start, end).trim();
    if (segment) {
      segments.push(segment);
    }
  }

  return segments.length > 0 ? segments : [raw];
}

function splitListItems(
  value: unknown,
  options?: {
    preferNamePairs?: boolean;
  },
): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const baseLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const expandedLines = baseLines.flatMap((line) => splitInlineLabeledSegments(line));
  if (expandedLines.length > 1) {
    return expandedLines;
  }

  if (/[,;|]/.test(raw)) {
    return raw
      .split(/[,;|]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (options?.preferNamePairs) {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const looksLikeNameToken = (token: string) => /^[A-Z][a-zA-Z'-]+$/.test(token);
    if (tokens.length >= 4 && tokens.length % 2 === 0 && tokens.every(looksLikeNameToken)) {
      const paired: string[] = [];
      for (let index = 0; index < tokens.length; index += 2) {
        paired.push(`${tokens[index]} ${tokens[index + 1]}`);
      }
      return paired;
    }
  }

  return expandedLines;
}

function splitLines(value: unknown): string[] {
  return splitListItems(value);
}

function normalizeListPreservingLines(
  value: unknown,
  options?: {
    preferNamePairs?: boolean;
  },
): string {
  const lines = splitListItems(value, options);
  return lines.join('\n');
}

function normalizeWordBankList(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lines = raw.includes('\n')
    ? splitLines(raw)
    : raw
      .split(/[,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);

  return Array.from(new Set(lines)).join('\n');
}

function parseLabeledLineOptions(
  value: unknown,
  options?: {
    keyCase?: 'lower' | 'upper';
    allowDerivedKeys?: boolean;
    preferNamePairs?: boolean;
  },
): Array<{ key: string; text: string }> {
  const keyCase = options?.keyCase || 'upper';
  const lines = splitListItems(value, { preferNamePairs: options?.preferNamePairs });

  const labeled = lines
    .map((line) => {
      const match = line.match(/^([A-Za-z]|\d{1,2}|[ivxlcdmIVXLCDM]{1,7})\s*([.)\-:]|\s)\s*(.*)$/);
      if (!match) return null;

      const rawKey = String(match[1] || '').trim();
      const text = String(match[3] || '').trim();
      if (!isSupportedLabelToken(rawKey)) return null;

      const key = keyCase === 'lower' ? rawKey.toLowerCase() : rawKey.toUpperCase();
      return { key, text };
    })
    .filter((item): item is { key: string; text: string } => Boolean(item));

  if (labeled.length > 0) {
    return labeled;
  }

  if (!options?.allowDerivedKeys) {
    return [];
  }

  return lines.map((line, index) => {
    const letter = toLetter(index);
    return {
      key: keyCase === 'lower' ? letter.toLowerCase() : letter.toUpperCase(),
      text: line,
    };
  });
}

function resolveLabeledOptionKey(
  rawValue: unknown,
  options: Array<{ key: string; text: string }>,
  normalizeKey: (value: string) => string,
): string {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  const normalizedRaw = normalizeToken(raw);

  const exactKey = options.find((item) => normalizeToken(item.key) === normalizedRaw);
  if (exactKey) return normalizeKey(exactKey.key);

  const leading = raw.match(/^([A-Za-z0-9ivxlcdmIVXLCDM]+)\s*[.)\-:]?/);
  if (leading?.[1]) {
    const token = normalizeToken(leading[1]);
    const tokenMatch = options.find((item) => normalizeToken(item.key) === token);
    if (tokenMatch) return normalizeKey(tokenMatch.key);
  }

  const numericMatch = raw.match(/^\d{1,2}$/);
  if (numericMatch) {
    const index = Number(numericMatch[0]) - 1;
    if (index >= 0 && index < options.length) {
      return normalizeKey(options[index].key);
    }
  }

  const exactText = options.find((item) => normalizeToken(item.text) === normalizedRaw);
  if (exactText) return normalizeKey(exactText.key);

  const containsText = options.find((item) => {
    const text = normalizeToken(item.text);
    return text.length > 0 && normalizedRaw.includes(text);
  });

  return containsText ? normalizeKey(containsText.key) : '';
}

function resolveSingleChoiceAnswer(rawValue: unknown, options: string[]): string {
  const raw = String(rawValue || '').trim();
  if (!raw || options.length === 0) return '';

  const upperRaw = raw.toUpperCase();
  if (/^[A-Z]$/.test(upperRaw)) {
    const index = upperRaw.charCodeAt(0) - 65;
    if (index >= 0 && index < options.length) {
      return upperRaw;
    }
  }

  const indexed = raw.match(/^\s*(\d{1,2})\s*$/);
  if (indexed) {
    const idx = Number(indexed[1]) - 1;
    if (idx >= 0 && idx < options.length) {
      return String.fromCharCode(65 + idx);
    }
  }

  const leadingLetter = raw.match(/^\s*([A-Za-z])\s*[.)\-:]?/);
  if (leadingLetter?.[1]) {
    const token = leadingLetter[1].toUpperCase();
    const index = token.charCodeAt(0) - 65;
    if (index >= 0 && index < options.length) {
      return token;
    }
  }

  const normalizedRaw = normalizeToken(raw);
  for (let index = 0; index < options.length; index += 1) {
    if (normalizeToken(options[index]) === normalizedRaw) {
      return String.fromCharCode(65 + index);
    }
  }

  return upperRaw;
}

function splitMultiAnswerCandidates(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  const raw = String(value || '').trim();
  if (!raw) return [];

  return raw
    .split(/(?:\r?\n|,|;|\/|\||\band\b)/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBooleanStyleAnswer(type: LegacyQuestionType, value: unknown): string {
  const raw = toUpperTrimmed(value);
  if (!raw) return '';

  if (type === 'True / False / Not Given') {
    if (raw === 'T' || raw === 'TRUE') return 'TRUE';
    if (raw === 'F' || raw === 'FALSE') return 'FALSE';
    if (raw === 'NG' || raw === 'NOT GIVEN' || raw === 'NOTGIVEN') return 'NOT GIVEN';
  }

  if (type === 'Yes / No / Not Given') {
    if (raw === 'Y' || raw === 'YES') return 'YES';
    if (raw === 'N' || raw === 'NO') return 'NO';
    if (raw === 'NG' || raw === 'NOT GIVEN' || raw === 'NOTGIVEN') return 'NOT GIVEN';
  }

  return raw;
}

function resolveWordBankAnswer(rawValue: unknown, wordBankItems: string[]): string {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  const labeledItems = wordBankItems.map((item, index) => {
    const match = item.match(/^([A-Za-z0-9ivxlcdmIVXLCDM]+)\s*[.)\-:]?\s*(.*)$/);
    return {
      index,
      raw: item,
      key: match?.[1] ? normalizeToken(match[1]) : '',
      text: normalizeToken(match?.[2] || item),
    };
  });

  const exact = wordBankItems.find((item) => item === raw);
  if (exact) return exact;

  const normalizedRaw = normalizeToken(raw);
  const caseInsensitive = wordBankItems.find((item) => normalizeToken(item) === normalizedRaw);
  if (caseInsensitive) return caseInsensitive;

  const tokenMatch = raw.match(/^([A-Za-z0-9ivxlcdmIVXLCDM]+)\s*[.)\-:]?/);
  if (tokenMatch?.[1]) {
    const token = normalizeToken(tokenMatch[1]);
    const byKey = labeledItems.find((item) => item.key === token);
    if (byKey) return byKey.raw;
  }

  const numericMatch = raw.match(/^\d{1,2}$/);
  if (numericMatch) {
    const index = Number(numericMatch[0]) - 1;
    if (index >= 0 && index < wordBankItems.length) {
      return wordBankItems[index];
    }
  }

  const candidates = raw.split('/').map((item) => item.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const found = wordBankItems.find((item) => normalizeToken(item) === normalizeToken(candidate));
    if (found) return found;
  }

  const byText = labeledItems.find((item) => item.text.length > 0 && normalizeToken(raw).includes(item.text));
  if (byText) return byText.raw;

  return raw;
}

function getPreferredCorrectAnswer(input: Record<string, unknown>): string {
  const direct = toTrimmedString(input.correctAnswer);
  if (direct) {
    return direct;
  }

  if (Array.isArray(input.correctAnswers)) {
    const first = input.correctAnswers.map((item) => toTrimmedString(item)).find(Boolean);
    if (first) {
      return first;
    }
  }

  return '';
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;

  const intValue = Math.floor(next);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeQuestionTypeLabel(skill: 'reading' | 'listening', label: string): LegacyQuestionType | null {
  if (isLegacyQuestionType(label)) {
    return label;
  }

  const canonical = canonicalize(label);
  const mapped = CANONICAL_TYPE_MAP.get(canonical);
  if (!mapped) {
    return null;
  }

  if (skill === 'reading' && READING_TYPE_SET.has(mapped)) {
    return mapped;
  }

  if (skill === 'listening' && LISTENING_TYPE_SET.has(mapped)) {
    return mapped;
  }

  return null;
}

function looksLikeStructuredCompletionQuestionType(rawQuestionType: {
  instructions?: unknown;
  summaryText?: unknown;
  featuresList?: unknown;
  imageData?: unknown;
  questions?: Array<Record<string, unknown>>;
}): boolean {
  if (rawQuestionType.imageData && typeof rawQuestionType.imageData === 'object') {
    return true;
  }

  const questionText = Array.isArray(rawQuestionType.questions)
    ? rawQuestionType.questions
      .map((question) => toTrimmedString((question as Record<string, unknown>).question))
      .filter(Boolean)
      .join(' ')
    : '';

  const contextText = [
    toTrimmedString(rawQuestionType.instructions),
    toTrimmedString(rawQuestionType.summaryText),
    toTrimmedString(rawQuestionType.featuresList),
    questionText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!contextText) {
    return false;
  }

  return /(form|note|table|flow\s*-?\s*chart|map|plan|diagram|summary|label(?:ling|ing)?|floor\s*plan|ground\s*floor|first\s*floor|second\s*floor|you\s+are\s+here|entrance|exit|reception|layout)/i.test(contextText);
}

function remapTypeByContext(
  skill: 'reading' | 'listening',
  mappedType: LegacyQuestionType,
  rawQuestionType: {
    instructions?: unknown;
    summaryText?: unknown;
    featuresList?: unknown;
    imageData?: unknown;
    questions?: Array<Record<string, unknown>>;
  },
): LegacyQuestionType {
  const isMatchingLike = mappedType === 'Matching Features'
    || mappedType === 'Matching (Info/Features/Sentence Halves)'
    || mappedType === 'Pick from a List';

  if (!isMatchingLike) {
    return mappedType;
  }

  if (!looksLikeStructuredCompletionQuestionType(rawQuestionType)) {
    return mappedType;
  }

  return skill === 'listening' ? LISTENING_COMPLETION_TYPE : READING_COMPLETION_TYPE;
}

function fallbackQuestionType(skill: 'reading' | 'listening'): LegacyQuestionType {
  return skill === 'reading'
    ? 'Multiple Choice (Single Answer)'
    : 'Multiple Choice Questions (Single Answer)';
}

function normalizeQuestionForType(
  type: LegacyQuestionType,
  input: Record<string, unknown>,
  context: {
    headingsList?: string;
    featuresList?: string;
    endingsList?: string;
    hasWordBank?: boolean;
    wordBank?: string;
  },
): TestQuestion {
  const options = uniqueNonEmpty(
    Array.isArray(input.options) ? input.options.map((value) => toTrimmedString(value)) : [],
  );
  const headingOptions = parseLabeledLineOptions(context.headingsList, { keyCase: 'lower' });
  const featureOptions = parseLabeledLineOptions(context.featuresList, {
    keyCase: 'upper',
    allowDerivedKeys: true,
    preferNamePairs: true,
  });
  const endingOptions = parseLabeledLineOptions(context.endingsList, {
    keyCase: 'upper',
    allowDerivedKeys: true,
  });
  const wordBankItems = splitLines(context.wordBank);

  const baseQuestion: TestQuestion = {
    question: toTrimmedString(input.question),
  };

  if (type === MATCHING_HEADINGS_TYPE) {
    return {
      ...baseQuestion,
      paragraphLetter: toUpperTrimmed(input.paragraphLetter),
      correctHeading: resolveLabeledOptionKey(input.correctHeading, headingOptions, (value) => value.toLowerCase())
        || toTrimmedString(input.correctHeading).toLowerCase(),
    };
  }

  if (type === MATCHING_SENTENCE_ENDINGS_TYPE) {
    return {
      ...baseQuestion,
      correctEnding: resolveLabeledOptionKey(input.correctEnding, endingOptions, (value) => value.toUpperCase())
        || toUpperTrimmed(input.correctEnding),
    };
  }

  if (isChooseMultipleQuestionType(type)) {
    const normalizedAnswers = uniqueNonEmpty(
      splitMultiAnswerCandidates(input.correctAnswers).map((value) => resolveSingleChoiceAnswer(value, options)).map((value) => value.toUpperCase()),
    );

    const choiceCount = clampInteger(
      input.choiceCount,
      normalizedAnswers.length > 0 ? normalizedAnswers.length : 3,
      1,
      10,
    );

    const optionCount = clampInteger(
      input.optionCount,
      options.length > 0 ? options.length : Math.max(choiceCount + 1, 6),
      2,
      12,
    );

    return {
      ...baseQuestion,
      instructions: toTrimmedString(input.instructions),
      choiceCount,
      optionCount,
      options,
      correctAnswers: normalizedAnswers.slice(0, choiceCount),
    };
  }

  if (SINGLE_CHOICE_TYPES.has(type)) {
    return {
      ...baseQuestion,
      options,
      correctAnswer: resolveSingleChoiceAnswer(getPreferredCorrectAnswer(input), options),
    };
  }

  if (type === 'True / False / Not Given' || type === 'Yes / No / Not Given') {
    return {
      ...baseQuestion,
      options: options.length > 0 ? options : undefined,
      correctAnswer: normalizeBooleanStyleAnswer(type, getPreferredCorrectAnswer(input)),
    };
  }

  if (
    type === 'Matching Features'
    || type === 'Matching (Info/Features/Sentence Halves)'
    || type === 'Pick from a List'
  ) {
    const mapped = resolveLabeledOptionKey(getPreferredCorrectAnswer(input), featureOptions, (value) => value.toUpperCase());
    return {
      ...baseQuestion,
      options: options.length > 0 ? options : undefined,
      correctAnswer: mapped || getPreferredCorrectAnswer(input),
    };
  }

  if (context.hasWordBank && wordBankItems.length > 0) {
    return {
      ...baseQuestion,
      options: options.length > 0 ? options : undefined,
      correctAnswer: resolveWordBankAnswer(getPreferredCorrectAnswer(input), wordBankItems),
    };
  }

  return {
    ...baseQuestion,
    options: options.length > 0 ? options : undefined,
    correctAnswer: getPreferredCorrectAnswer(input),
  };
}

export function normalizeExtractedPayload(input: {
  skill: 'reading' | 'listening';
  payload: RawExtractedPayload;
}) {
  const warnings: ExtractionWarning[] = [...(input.payload.warnings || [])];
  const confidence = input.payload.confidence || [];

  const parts = input.payload.parts.map((part, partIndex) => {
    const partName = toTrimmedString(part.name) ||
      (input.skill === 'reading' ? `Reading Passage ${partIndex + 1}` : `Part ${partIndex + 1}`);

    const questionTypes: TestQuestionType[] = (part.questionTypes || []).map((questionType, qtIndex) => {
      const rawTypeLabel = toTrimmedString(questionType.type);
      const mappedType = normalizeQuestionTypeLabel(input.skill, rawTypeLabel);
      const fallbackType = mappedType || fallbackQuestionType(input.skill);
      const finalType = remapTypeByContext(input.skill, fallbackType, questionType as {
        instructions?: unknown;
        summaryText?: unknown;
        featuresList?: unknown;
        imageData?: unknown;
        questions?: Array<Record<string, unknown>>;
      });

      if (!mappedType) {
        warnings.push({
          code: 'UNKNOWN_QUESTION_TYPE',
          message: `Question type "${rawTypeLabel}" is not recognized. Fallback to "${finalType}".`,
          path: `parts[${partIndex}].questionTypes[${qtIndex}].type`,
        });
      }

      if (mappedType && finalType !== mappedType) {
        warnings.push({
          code: 'QUESTION_TYPE_CONTEXT_OVERRIDE',
          message: `Question type "${mappedType}" was reclassified to "${finalType}" based on map/form/diagram completion context.`,
          path: `parts[${partIndex}].questionTypes[${qtIndex}].type`,
        });
      }

      const normalizedQuestions = (questionType.questions || []).map((question, questionIndex) => {
        const rawQuestion = (question || {}) as Record<string, unknown>;
        const normalizedQuestion = normalizeQuestionForType(finalType, rawQuestion, {
          headingsList: questionType.headingsList,
          featuresList: questionType.featuresList,
          endingsList: questionType.endingsList,
          hasWordBank: questionType.hasWordBank,
          wordBank: questionType.wordBank,
        });

        if (isChooseMultipleQuestionType(finalType)) {
          const answerCount = Array.isArray((normalizedQuestion as { correctAnswers?: string[] }).correctAnswers)
            ? ((normalizedQuestion as { correctAnswers?: string[] }).correctAnswers || []).length
            : 0;
          const choiceCount = Number((normalizedQuestion as { choiceCount?: number }).choiceCount || 0);

          if (answerCount > choiceCount) {
            warnings.push({
              code: 'TOO_MANY_CORRECT_ANSWERS',
              message: 'correctAnswers exceeds choiceCount; extra answers were truncated.',
              path: `parts[${partIndex}].questionTypes[${qtIndex}].questions[${questionIndex}]`,
            });
          }
        }

        return normalizedQuestion;
      });

      let questionCount = clampInteger(questionType.questionCount, normalizedQuestions.length, 0, 200);
      if (normalizedQuestions.length > 0) {
        questionCount = normalizedQuestions.length;
      }

      while (normalizedQuestions.length < questionCount) {
        normalizedQuestions.push({});
      }

      const normalizedHeadingsList = normalizeListPreservingLines(questionType.headingsList);
      const normalizedFeaturesList = normalizeListPreservingLines(questionType.featuresList, { preferNamePairs: true });
      const normalizedEndingsList = normalizeListPreservingLines(questionType.endingsList);
      const normalizedWordBank = normalizeWordBankList(questionType.wordBank);

      if (isMatchingFeatureLikeType(finalType)) {
        const optionCount = splitLines(normalizedFeaturesList).length;
        if (optionCount < 2 && questionCount > 0) {
          warnings.push({
            code: 'FEATURES_LIST_LOW_CONFIDENCE',
            message: 'featuresList has fewer than 2 options after normalization; answer mapping may be unreliable.',
            path: `parts[${partIndex}].questionTypes[${qtIndex}].featuresList`,
          });
        }
      }

      return {
        type: finalType,
        questionCount,
        instructions: toTrimmedString(questionType.instructions),
        headingsList: normalizedHeadingsList,
        headingCount: questionType.headingCount,
        featuresList: normalizedFeaturesList,
        endingsList: normalizedEndingsList,
        summaryText: toTrimmedString(questionType.summaryText),
        hasWordBank: Boolean(questionType.hasWordBank),
        wordBank: normalizedWordBank,
        imageData: questionType.imageData,
        questions: normalizedQuestions,
      };
    });

    return {
      name: partName,
      questionTypes,
    };
  });

  const numberedParts = calculateQuestionNumbers(parts);
  warnings.push(...buildObjectiveExtractionWarnings(input.skill, numberedParts));

  return {
    parts: numberedParts,
    warnings,
    confidence,
  };
}
