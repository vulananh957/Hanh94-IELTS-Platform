import type { TestPart } from '@/features/upload-test/types';
import { calculateIELTSBand, matchAnswer, splitAnswerTokens } from '@/app/(dashboard)/student/take-test/take-test-utils';

export type ObjectiveSkill = 'reading' | 'listening';

/* ── helpers ─────────────────────────────────────────────────────── */

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toPositiveInt(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return next > 0 ? Math.floor(next) : fallback;
}

function isChooseMultipleType(type: string): boolean {
  return /multiple choice.*choose multiple/i.test(type);
}

function flattenAnswerKey(ak: unknown): Record<string, string> {
  const raw = asRecord(ak);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      // Join with '/' so matchAnswer's slash-splitting can parse each alternative
      flat[k] = v.map((x) => String(x ?? '').trim()).filter(Boolean).join('/');
    } else {
      flat[k] = String(v ?? '').trim();
    }
  }
  return flat;
}

function flattenStudentAnswers(ans: unknown): Record<string, string> {
  const raw = asRecord(ans);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    flat[k] = String(v ?? '').trim();
  }
  return flat;
}

/* ── core scoring ─────────────────────────────────────────────────── */

function computeScoreForParts(
  parts: TestPart[],
  studentAnswers: Record<string, string>,
  answerKey: Record<string, string>,
): { correctAnswers: number; totalQuestions: number } {
  let totalCorrect = 0;
  let totalQuestions = 0;

  for (const part of parts) {
    const questionTypes = part.questionTypes || [];
    let currentNumber = toPositiveInt((part as any).startNumber, 1);

    for (const qt of questionTypes) {
      const typeName = qt.type || 'Questions';
      const questions = qt.questions || [];
      currentNumber = toPositiveInt(qt.startNumber, currentNumber);

      if (isChooseMultipleType(typeName)) {
        for (const question of questions) {
          const rec = question as Record<string, unknown>;
          const choiceCount = toPositiveInt(rec.choiceCount, 2);
          const startNumber = currentNumber;
          const endNumber = startNumber + choiceCount - 1;

          const rawCorrect = (function() {
            const answers = asArray(rec.correctAnswers)
              .map((value) => String(value ?? '').trim().toUpperCase())
              .filter(Boolean);
            if (answers.length > 0) return answers.join(' ');
            return String(rec.correctAnswer ?? asArray(rec.correctAnswers)[0] ?? answerKey[String(startNumber)] ?? '').trim();
          })();
          const correctAnswerTokens = Array.from(new Set(splitAnswerTokens(rawCorrect)));

          for (let subIdx = 0; subIdx < choiceCount; subIdx += 1) {
            const subNum = startNumber + subIdx;
            const correctToken = correctAnswerTokens[subIdx] || '';

            if (!correctToken) {
              totalQuestions += 1;
              continue;
            }

            const groupKey = `${startNumber}-${endNumber}`;
            const groupAnswer = studentAnswers[groupKey] || studentAnswers[String(subNum)] || '';
            const studentTokens = Array.from(new Set(splitAnswerTokens(groupAnswer)));
            const isCorrect = studentTokens.some((t) => matchAnswer(t, correctToken));

            totalCorrect += isCorrect ? 1 : 0;
            totalQuestions += 1;
          }

          currentNumber = endNumber + 1;
        }
      } else {
        const questionCount = Math.max(
          toPositiveInt(qt.questionCount, 0),
          questions.length,
        );

        for (let index = 0; index < questionCount; index += 1) {
          const qNum = String(currentNumber + index);
          const question = questions[index];
          const rec = question ? asRecord(question) : {};
          const correct = String(rec.correctAnswer ?? answerKey[qNum] ?? '').trim();
          const student = studentAnswers[qNum] || '';

          if (!correct) {
            totalQuestions += 1;
            continue;
          }

          totalCorrect += matchAnswer(student, correct) ? 1 : 0;
          totalQuestions += 1;
        }

        currentNumber += questionCount;
      }
    }
  }

  return { correctAnswers: totalCorrect, totalQuestions };
}

/* ── public API ──────────────────────────────────────────────────── */

export interface ScoreCalculationResult {
  correctAnswers: number;
  totalQuestions: number;
  band: number;
}

/**
 * Compute the objective score for a student's test submission,
 * given the full parts structure and their raw answers map.
 *
 * Used by:
 *   - ObjectiveTestDrawer (replaces inlined logic)
 *   - updateTest Cloud Function (batch recalculation)
 */
export function calculateObjectiveScore(params: {
  answers: Record<string, string>;
  answerKey: Record<string, string | string[]>;
  parts: TestPart[];
  skill: ObjectiveSkill;
}): ScoreCalculationResult {
  // Flatten student answers if passed as a nested object
  const studentAnswers = flattenStudentAnswers(params.answers);
  const answerKey = flattenAnswerKey(params.answerKey);

  // Compute raw correct / total
  const { correctAnswers, totalQuestions } = computeScoreForParts(
    params.parts,
    studentAnswers,
    answerKey,
  );

  // Compute IELTS band
  const band = calculateIELTSBand(correctAnswers, params.skill);

  return { correctAnswers, totalQuestions, band };
}
